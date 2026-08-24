import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkEvent,
  deliveryFailure,
  engineEnv,
  githubCiOwnsAcceptance,
  parseSelfReportedChecks,
  readOnlyRepositoryMode,
  redactEventData,
  redactSecrets,
  requiresDelivery,
  runCheckCommand,
  transcriptEvidenceEvent,
} from "../src/index.js";

describe("platform acceptance checks", () => {
  it("does not measure read-only learning runs against the repository baseline", () => {
    expect(readOnlyRepositoryMode("learning")).toBe(true);
    expect(readOnlyRepositoryMode("codex-learning")).toBe(true);
    expect(readOnlyRepositoryMode("architect")).toBe(true);
    expect(readOnlyRepositoryMode("review")).toBe(true);
    expect(readOnlyRepositoryMode("security-sweep")).toBe(true);
    expect(readOnlyRepositoryMode("custom")).toBe(false);
    expect(readOnlyRepositoryMode("builder")).toBe(false);
  });

  it("reports the exit code of a passing command", async () => {
    const { code } = await runCheckCommand("echo ok; exit 0", tmpdir(), 5);
    expect(code).toBe(0);
  });

  it("reports the non-zero exit code and captures stderr for a failing command", async () => {
    const { code, tail } = await runCheckCommand("echo boom 1>&2; exit 3", tmpdir(), 5);
    expect(code).toBe(3);
    expect(tail).toContain("boom");
  });

  it("surfaces a missing binary as a non-zero exit rather than throwing", async () => {
    const { code } = await runCheckCommand("this-binary-does-not-exist", tmpdir(), 5);
    expect(code).not.toBe(0);
  });

  it("builds a passed check event without carrying output", () => {
    expect(checkEvent("pnpm run typecheck", 0, "all good")).toEqual({
      self_reported: false,
      command: "pnpm run typecheck",
      status: "passed",
      exit_code: 0,
    });
  });

  it("builds a failed check event carrying the output tail", () => {
    expect(checkEvent("pnpm run test", 1, "1 failing")).toEqual({
      self_reported: false,
      command: "pnpm run test",
      status: "failed",
      exit_code: 1,
      output: "1 failing",
    });
  });

  it("caps the failure output at 2000 chars", () => {
    const event = checkEvent("x", 1, "z".repeat(5000));
    expect((event.output as string).length).toBe(2000);
  });
});

describe("transcript evidence (non-gating)", () => {
  it("emits a failed transcript as an evidence event, not a platform check", () => {
    const event = transcriptEvidenceEvent("failed");
    expect(event).toEqual({
      type: "evidence",
      data: {
        name: "transcript",
        status: "failed",
        reason: "transcript_upload_failed",
      },
    });
    expect(event?.type).not.toBe("check");
    expect(event?.data).not.toHaveProperty("self_reported");
  });

  it("never appears in the receipt check list (receipts only collect type=check)", () => {
    const evidence = transcriptEvidenceEvent("failed");
    const allEmitted = [
      {
        type: "check",
        data: { self_reported: false, command: "pnpm test", status: "passed", exit_code: 0 },
      },
      evidence,
    ];
    const receiptChecks = allEmitted.filter((e) => e?.type === "check");
    expect(receiptChecks).toHaveLength(1);
    expect((receiptChecks[0]?.data as Record<string, unknown>)?.command).toBe("pnpm test");
  });

  it("returns null for a successful upload", () => {
    expect(transcriptEvidenceEvent("uploaded")).toBeNull();
  });

  it("returns null when the transcript was empty", () => {
    expect(transcriptEvidenceEvent("empty")).toBeNull();
  });
});

describe("builder delivery invariant", () => {
  const repo = {
    cloneUrl: "https://github.com/example/project.git",
    branch: "main",
    expectedHeadSha: null,
    installationTokenRef: "installation",
  };

  it("requires delivery only for builder modes", () => {
    expect(requiresDelivery("builder")).toBe(true);
    expect(requiresDelivery("codex-builder")).toBe(true);
    expect(requiresDelivery("architect")).toBe(false);
    expect(requiresDelivery("review")).toBe(false);
  });

  it("defers GitHub builder and repair acceptance to the durable pull request", () => {
    expect(githubCiOwnsAcceptance({ mode: "builder", repo })).toBe(true);
    expect(githubCiOwnsAcceptance({ mode: "codex-builder", repo })).toBe(true);
    expect(githubCiOwnsAcceptance({ mode: "ci-doctor", repo })).toBe(true);
    expect(githubCiOwnsAcceptance({ mode: "address-review", repo })).toBe(true);
  });

  it("keeps local gates for non-GitHub and non-delivery runs", () => {
    expect(
      githubCiOwnsAcceptance({
        mode: "builder",
        repo: { ...repo, cloneUrl: "https://gitlab.example/acme/project.git" },
      }),
    ).toBe(false);
    expect(githubCiOwnsAcceptance({ mode: "review", repo })).toBe(false);
    expect(githubCiOwnsAcceptance({ mode: "custom", repo })).toBe(false);
  });

  it("rejects no-op, unpushed, and push-failed builder results", () => {
    expect(deliveryFailure({ mode: "builder", repo }, { changed: false })).toBe(
      "delivery_no_changes",
    );
    expect(deliveryFailure({ mode: "builder", repo }, { changed: true })).toBe(
      "delivery_branch_missing",
    );
    expect(
      deliveryFailure(
        { mode: "builder", repo },
        { changed: true, branch: "facility/run-1", headSha: "abc", pushError: "denied" },
      ),
    ).toBe("delivery_push_failed");
  });

  it("accepts a changed commit with agent-owned pull request metadata", () => {
    expect(
      deliveryFailure(
        { mode: "builder", repo },
        {
          changed: true,
          branch: "feature/task",
          headSha: "abc",
          pullRequestTitle: "feat: deliver task",
          pullRequestBody: "## Summary\n\n- Deliver the requested task.",
        },
      ),
    ).toBeNull();
  });

  it("rejects a builder result that drops the agent-owned PR title or body", () => {
    const delivered = { changed: true, branch: "feature/task", headSha: "abc" };
    expect(deliveryFailure({ mode: "builder", repo }, delivered)).toBe("delivery_pr_title_missing");
    expect(
      deliveryFailure(
        { mode: "builder", repo },
        { ...delivered, pullRequestTitle: "feat: deliver task" },
      ),
    ).toBe("delivery_pr_body_missing");
  });

  it("fails read-only agents that alter the repository", () => {
    expect(deliveryFailure({ mode: "review", repo }, { changed: true })).toBe(
      "repository_changes_not_allowed",
    );
    expect(deliveryFailure({ mode: "security-sweep", repo }, { changed: false })).toBeNull();
    expect(deliveryFailure({ mode: "learning", repo }, { changed: true })).toBe(
      "repository_changes_not_allowed",
    );
    expect(deliveryFailure({ mode: "custom", repo }, { changed: true })).toBe(
      "repository_changes_not_allowed",
    );
  });

  it("accepts a no-op repair or a signed update to the existing PR branch", () => {
    expect(deliveryFailure({ mode: "address-review", repo }, { changed: false })).toBeNull();
    expect(
      deliveryFailure(
        { mode: "ci-doctor", repo },
        { changed: true, branch: "feature/task", headSha: "signed" },
      ),
    ).toBeNull();
    expect(deliveryFailure({ mode: "ci-doctor", repo }, { changed: true })).toBe(
      "delivery_branch_missing",
    );
  });
});

describe("secret redaction of check output", () => {
  const key = "fvk_0123456789abcdef0123456789abcdef";

  it("scrubs every occurrence of an injected secret", () => {
    const out = redactSecrets(`auth ${key} then ${key} again`, [key]);
    expect(out).toBe("auth «redacted» then «redacted» again");
    expect(out).not.toContain(key);
  });

  it("scrubs a token embedded in an authenticated clone URL", () => {
    const token = "ghs_supersecrettoken1234567890";
    const out = redactSecrets(`https://x-access-token:${token}@github.com/o/r.git`, [token]);
    expect(out).not.toContain(token);
  });

  it("leaves short values alone so it cannot over-redact", () => {
    expect(redactSecrets("exit code 1, ok", ["1", "ok"])).toBe("exit code 1, ok");
  });

  it("passes text through untouched when there are no secrets", () => {
    expect(redactSecrets("nothing secret here", [])).toBe("nothing secret here");
  });

  it("scrubs credentials generated by repository setup tools", () => {
    const generated = [
      "Publishable key │ sb_publishable_local_generated_value",
      "Secret key │ sb_secret_local_generated_value",
      "anon key: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbm9uX3VzZXIifQ.signature_value_12345",
      "Access Key │ 0123456789abcdef0123456789abcdef │",
      "Secret Key │ abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 │",
    ].join("\n");

    const out = redactSecrets(generated, []);

    expect(out).not.toContain("sb_publishable_");
    expect(out).not.toContain("sb_secret_");
    expect(out).not.toContain("eyJhbGci");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out.match(/«redacted»/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe("central event redaction (redactEventData)", () => {
  const secret = "fvk_deadbeefdeadbeefdeadbeefdeadbeef";

  it("recursively scrubs secrets in nested engine event payloads (values AND keys)", () => {
    const redacted = redactEventData(
      {
        text: `key is ${secret}`,
        tool: { input: [secret, { nested: secret }] },
        [`field_${secret}`]: "value",
        n: 3,
        ok: true,
      },
      [secret],
    ) as Record<string, unknown> & {
      text: string;
      tool: { input: [string, { nested: string }] };
    };
    expect(redacted.text).toBe("key is «redacted»");
    expect(redacted.tool.input[0]).toBe("«redacted»");
    expect(redacted.tool.input[1].nested).toBe("«redacted»");
    expect(redacted.n).toBe(3);
    expect(redacted.ok).toBe(true);
    // The secret embedded in a property NAME is scrubbed too.
    expect(Object.keys(redacted)).toContain("field_«redacted»");
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});

describe("self-reported check provenance", () => {
  it("forces self_reported:true even when the agent line claims false", () => {
    const events = parseSelfReportedChecks(
      '{"name":"lint","status":"passed","self_reported":false}',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.data.self_reported).toBe(true);
    expect(events[0]?.data.name).toBe("lint");
  });

  it("isolates a malformed line without dropping the valid ones", () => {
    const events = parseSelfReportedChecks(['{"name":"a"}', "not json", '{"name":"b"}'].join("\n"));
    expect(events.map((e) => e.data.name)).toEqual(["a", "b"]);
    expect(events.every((e) => e.data.self_reported === true)).toBe(true);
  });

  it("is empty for empty input", () => {
    expect(parseSelfReportedChecks("")).toEqual([]);
  });
});

describe("engine environment isolation", () => {
  const saved = { runner: process.env.RUNNER_TOKEN, auth: process.env.ANTHROPIC_AUTH_TOKEN };
  afterEach(() => {
    if (saved.runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = saved.runner;
    if (saved.auth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = saved.auth;
  });

  it("never leaks the runner's internal-lifecycle token to the child engine/checks", () => {
    process.env.RUNNER_TOKEN = "rt_super_secret_runner_token";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-be-stripped";
    const env = engineEnv();
    expect(env.RUNNER_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/work");
    // The runner's own process still holds the token for its api() calls.
    expect(process.env.RUNNER_TOKEN).toBe("rt_super_secret_runner_token");
  });
});
