import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitTranscriptEvidence,
  fetchJson,
  transcriptEvidenceEvent,
  uploadTranscript,
} from "../src/index.js";
import type { RunEvent } from "../src/types.js";

const servers: ReturnType<typeof createServer>[] = [];
const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(tempFiles.splice(0).map((f) => rm(f, { force: true })));
});

describe("transcript upload evidence contract", () => {
  it("delivers the transcript body to the platform and returns the response", async () => {
    let receivedBody = "";
    let receivedContentType = "";
    const server = createServer((request, response) => {
      receivedContentType = request.headers["content-type"] ?? "";
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        receivedBody = body;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const transcript = '{"type":"assistant","message":"hello"}\n{"type":"tool","name":"read"}\n';

    const result = await fetchJson(
      `http://127.0.0.1:${port}/internal/runs/run_abc/transcript`,
      {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      () => Readable.from(transcript) as unknown as RequestInit["body"],
    );

    expect(result).toEqual({ ok: true });
    expect(receivedContentType).toBe("application/x-ndjson");
    expect(receivedBody).toBe(transcript);
  });

  it("throws on server error so the caller can detect evidence loss", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "s3_write_failed" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/internal/runs/run_abc/transcript`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          duplex: "half",
        } as RequestInit & { duplex: "half" },
        () => Readable.from("transcript\n") as unknown as RequestInit["body"],
      ),
    ).rejects.toThrow(/failed 500/);
  });

  it("does not report failure when the transcript is empty", async () => {
    const path = join(tmpdir(), `empty-transcript-${Date.now()}.jsonl`);
    tempFiles.push(path);
    await writeFile(path, "");

    let uploadCalled = false;
    const emitted: RunEvent[] = [];

    const result = await uploadTranscript({
      transcriptPath: path,
      upload: async () => {
        uploadCalled = true;
      },
      emitEvents: async (events) => {
        emitted.push(...events);
      },
    });

    expect(result).toBe("empty");
    expect(uploadCalled).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("returns 'failed' on upload error and the evidence event stays non-gating", async () => {
    const path = join(tmpdir(), `fail-transcript-${Date.now()}.jsonl`);
    tempFiles.push(path);
    await writeFile(path, '{"type":"assistant","message":"hello"}\n');

    const emitted: RunEvent[] = [];

    const result = await uploadTranscript({
      transcriptPath: path,
      upload: async () => {
        throw new Error("storage unavailable");
      },
      emitEvents: async (events) => {
        emitted.push(...events);
      },
    });

    expect(result).toBe("failed");
    expect(emitted).toEqual([
      { type: "artifact_error", data: { kind: "transcript_upload_failed" } },
    ]);

    const evidence = transcriptEvidenceEvent(result);
    expect(evidence).not.toBeNull();
    expect(evidence?.type).toBe("evidence");
    expect(evidence?.type).not.toBe("check");
    expect(evidence?.data).not.toHaveProperty("self_reported");
  });

  it("returns 'uploaded' on success and produces no evidence event", async () => {
    const path = join(tmpdir(), `ok-transcript-${Date.now()}.jsonl`);
    tempFiles.push(path);
    await writeFile(path, '{"type":"assistant","message":"hello"}\n');

    const emitted: RunEvent[] = [];

    const result = await uploadTranscript({
      transcriptPath: path,
      upload: async () => {},
      emitEvents: async (events) => {
        emitted.push(...events);
      },
    });

    expect(result).toBe("uploaded");
    expect(emitted).toEqual([]);
    expect(transcriptEvidenceEvent(result)).toBeNull();
  });
});

describe("emitTranscriptEvidence (best-effort)", () => {
  it("swallows a rejected emit so a degraded events endpoint cannot fail the run", async () => {
    await expect(
      emitTranscriptEvidence("failed", () => Promise.reject(new Error("503"))),
    ).resolves.toBeUndefined();
  });

  it("emits the evidence event exactly once on failure", async () => {
    const emitted: RunEvent[] = [];
    await emitTranscriptEvidence("failed", async (events) => {
      emitted.push(...events);
    });
    expect(emitted).toEqual([transcriptEvidenceEvent("failed")]);
  });

  it("skips the emit entirely for uploaded and empty transcripts", async () => {
    const spy = vi.fn();
    await emitTranscriptEvidence("uploaded", spy);
    await emitTranscriptEvidence("empty", spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
