import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitRunEvents, emitTranscriptEvidence, uploadTranscript } from "../src/index.js";
import type { RunEvent } from "../src/types.js";

const ENV_KEYS = ["FACILITY_API_URL", "RUN_ID", "RUNNER_TOKEN"] as const;

const RUN_ID = "run_transcript";
const RUNNER_TOKEN = "runner-transcript-token";
const TRANSCRIPT_LINE = '{"type":"assistant","message":"hello"}\n';

type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

let cleanups: Array<() => Promise<void>> = [];
let handlerFailures: unknown[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let previousFetch: typeof fetch;

beforeEach(() => {
  cleanups = [];
  handlerFailures = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error(`integration test blocked external request to ${url.origin}`);
    }
    return previousFetch(request, init);
  };
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = previousFetch;
  }
  failures.push(...handlerFailures);
  if (failures.length > 0) throw new AggregateError(failures, "integration fixture cleanup failed");
});

/**
 * Stands in for the platform: the transcript route answers with `transcriptStatus`,
 * the events route with `eventsStatus`, and every accepted event batch is recorded
 * so a test can assert what the run's event log would actually contain.
 */
async function startPlatform({
  transcriptStatus = 200,
  eventsStatus = 200,
}: {
  transcriptStatus?: number;
  eventsStatus?: number;
} = {}) {
  const requests: RecordedRequest[] = [];
  const eventBatches: RunEvent[][] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      // Drain before replying: the transcript upload streams its body, and
      // answering early would surface as a socket error instead of the status.
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      if (recorded.headers.authorization !== `Bearer ${RUNNER_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "invalid runner token" }));
        return;
      }
      if (recorded.method === "POST" && recorded.path === `/internal/runs/${RUN_ID}/transcript`) {
        response.writeHead(transcriptStatus, { "content-type": "application/json" });
        response.end(JSON.stringify(transcriptStatus === 200 ? {} : { error: "s3_write_failed" }));
        return;
      }
      if (recorded.method === "POST" && recorded.path === `/internal/runs/${RUN_ID}/events`) {
        if (eventsStatus === 200) eventBatches.push(JSON.parse(recorded.body) as RunEvent[]);
        response.writeHead(eventsStatus, { "content-type": "application/json" });
        response.end(JSON.stringify(eventsStatus === 200 ? {} : { message: "events degraded" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `unexpected route ${recorded.path}` }));
    } catch (error) {
      handlerFailures.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  process.env.FACILITY_API_URL = `http://127.0.0.1:${port}`;
  process.env.RUN_ID = RUN_ID;
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  return {
    requests,
    /** Every event the platform accepted, flattened across batches. */
    events: () => eventBatches.flat(),
    transcriptRequests: () =>
      requests.filter((r) => r.path === `/internal/runs/${RUN_ID}/transcript`),
  };
}

async function writeTranscript(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "facility-transcript-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "engine.stream.jsonl");
  await writeFile(path, contents);
  return path;
}

/**
 * The run's end-of-capture sequence: the real upload followed by the real emit,
 * against the real platform routes.
 *
 * This mirrors `main()`'s result_capture block by hand rather than calling
 * `main()`, so the coupling is manual: if the emit moves away from the upload
 * again — the bug this file exists to cover — these tests keep passing. Keep it
 * in step with the two lines in `runner/src/index.ts` that do this for real.
 */
async function captureTranscript(transcriptPath: string) {
  const state = await uploadTranscript({ transcriptPath });
  await emitTranscriptEvidence(state, emitRunEvents);
  return state;
}

describe("transcript upload evidence", () => {
  it("streams the transcript to the platform and records nothing when it lands", async () => {
    const platform = await startPlatform();
    const path = await writeTranscript(TRANSCRIPT_LINE);

    await expect(captureTranscript(path)).resolves.toBe("uploaded");

    const [upload] = platform.transcriptRequests();
    expect(upload?.headers["content-type"]).toBe("application/x-ndjson");
    expect(upload?.body).toBe(TRANSCRIPT_LINE);
    expect(platform.events()).toEqual([]);
  });

  it("does not upload or record anything when the engine wrote no transcript", async () => {
    const platform = await startPlatform({ transcriptStatus: 500 });
    const path = await writeTranscript("");

    await expect(captureTranscript(path)).resolves.toBe("empty");

    expect(platform.transcriptRequests()).toEqual([]);
    expect(platform.events()).toEqual([]);
  });

  it("records a rejected upload as evidence that the receipt's check query cannot collect", async () => {
    const platform = await startPlatform({ transcriptStatus: 500 });
    const path = await writeTranscript(TRANSCRIPT_LINE);

    await expect(captureTranscript(path)).resolves.toBe("failed");

    const events = platform.events();
    expect(events).toContainEqual({
      type: "evidence",
      data: { name: "transcript", status: "failed", reason: "transcript_upload_failed" },
    });
    // The receipt collects its check list with `where type = 'check'`, so the
    // loss is recorded without ever reaching the gate that list feeds.
    expect(events.filter((event) => event.type === "check")).toEqual([]);
    expect(events).toContainEqual({
      type: "artifact_error",
      data: { kind: "transcript_upload_failed" },
    });
  });

  it("survives an events endpoint that is degraded at the same time", async () => {
    const platform = await startPlatform({ transcriptStatus: 500, eventsStatus: 503 });
    const path = await writeTranscript(TRANSCRIPT_LINE);

    // Both writes fail, and neither may escape: an unguarded emit here would
    // reach main()'s outer catch and fail an otherwise successful run.
    await expect(captureTranscript(path)).resolves.toBe("failed");

    expect(platform.events()).toEqual([]);
  });
});
