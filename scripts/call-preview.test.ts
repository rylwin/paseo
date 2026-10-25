import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadPreviewAsset } from "./call-preview-static.mjs";
import { BoundPiSession, TRIAL_AGENT } from "./call-preview-pi.mjs";
import { admitUpgrade, validateTool, authenticate, authenticateStart } from "./call-preview.mjs";

describe("built preview assets", () => {
  it("rejects encoded traversal rather than reading outside the build", async () => {
    await expect(loadPreviewAsset(tmpdir(), "/%2e%2e%2fsecret.txt", false)).rejects.toThrow(
      "Invalid preview asset path",
    );
  });
  it.each([
    ["js", "text/javascript; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["svg", "image/svg+xml"],
    ["png", "image/png"],
    ["woff2", "font/woff2"],
    ["ttf", "font/ttf"],
    ["json", "application/json"],
  ])("serves %s with its correct MIME type", async (extension, type) => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-static-test-"));
    try {
      await writeFile(path.join(root, `app.${extension}`), "console.log('preview');");
      const asset = await loadPreviewAsset(root, `/app.${extension}?version=1`, false);
      expect(asset.type).toBe(type);
      expect(asset.encoding).toBe(null);
      expect(asset.body.toString()).toBe("console.log('preview');");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("serves the built SPA route compressed without requiring Metro", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-static-test-"));
    try {
      await writeFile(path.join(root, "index.html"), "<html>Stable call preview</html>");
      const asset = await loadPreviewAsset(root, "/open-project", true);
      expect(asset.type).toBe("text/html; charset=utf-8");
      expect(asset.encoding).toBe("gzip");
      expect(gunzipSync(asset.body).toString()).toBe("<html>Stable call preview</html>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scoped token and timeline", () => {
  it("rejects malformed start envelopes without crashing the preview", () => {
    expect(authenticateStart(null, "a".repeat(64))).toBe(false);
    expect(authenticateStart("start", "a".repeat(64))).toBe(false);
    expect(authenticateStart({ type: "start", token: "a".repeat(64) }, "a".repeat(64))).toBe(true);
  });
  it("rejects absent, malformed and incorrect tokens", () => {
    expect(authenticate("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(authenticate(undefined, "a".repeat(64))).toBe(false);
    expect(authenticate("b".repeat(64), "a".repeat(64))).toBe(false);
    expect(authenticate({}, "a".repeat(64))).toBe(false);
    expect(authenticate("é".repeat(64), "a".repeat(64))).toBe(false);
  });
});

describe("bound Pi request", () => {
  it("bounds a large assistant answer before passing it to voice", async () => {
    let count = 0;
    const pi = new BoundPiSession(
      async () => ({ stdout: ++count === 1 ? '{"status":"completed"}' : "x".repeat(20000) }),
      new AbortController().signal,
    );
    expect((await pi.request("Explain the code")).text.length).toBeLessThanOrEqual(12000);
  });
  it("reads fixed-session status and latest assistant reply without sending a request", async () => {
    const calls: string[][] = [];
    const pi = new BoundPiSession(async (_file: string, argv: string[]) => {
      calls.push(argv);
      return {
        stdout:
          argv[0] === "inspect"
            ? '{"Status":"idle","PendingPermissions":[]}'
            : "The current directory is the Paseo prototype worktree.",
      };
    }, new AbortController().signal);
    expect(await pi.status()).toEqual({
      success: true,
      text: "Pi status: idle. Pending permissions: 0. Latest assistant reply: The current directory is the Paseo prototype worktree.",
    });
    expect(calls).toEqual([
      ["inspect", TRIAL_AGENT, "--json"],
      ["logs", TRIAL_AGENT, "--filter", "assistant_message", "--tail", "20", "--json"],
    ]);
  });
  it.each(["", "No activity to display.\n"])(
    "does not report a missing assistant reply as success: %j",
    async (reply) => {
      let count = 0;
      const pi = new BoundPiSession(
        async () => ({ stdout: ++count === 1 ? '{"status":"completed"}' : reply }),
        new AbortController().signal,
      );
      expect(await pi.request("Explain this file")).toEqual({
        success: false,
        text: "Pi completed but no fresh assistant reply is available. Ask for status; do not assume success.",
      });
    },
  );
  it("reports permission waiting without inventing an answer", async () => {
    const calls: string[][] = [];
    const pi = new BoundPiSession(async (_file: string, argv: string[]) => {
      calls.push(argv);
      return { stdout: '{"status":"permission"}' };
    }, new AbortController().signal);
    expect(await pi.request("Read package.json")).toEqual({
      success: false,
      text: "Pi request status: permission. The task may still be active; ask for status or resolve permissions in Paseo.",
    });
    expect(calls.length).toBe(1);
  });
  it("forwards the exact instruction in argv and returns only the fresh assistant answer", async () => {
    const calls: string[][] = [];
    const execute = async (_file: string, argv: string[]) => {
      calls.push(argv);
      return {
        stdout:
          calls.length === 1
            ? '{"status":"completed"}'
            : "This helper checks the preview token and browser origin.\n",
      };
    };
    const since = "2026-10-25T03:00:00.000Z";
    const pi = new BoundPiSession(execute, new AbortController().signal, () => since);
    const instruction =
      "Explain scripts/call-preview.mjs; do not change files.\nTreat $(whoami) as text.";
    expect(await pi.request(instruction)).toEqual({
      success: true,
      text: "Pi replied: This helper checks the preview token and browser origin.",
    });
    expect(calls).toEqual([
      ["send", TRIAL_AGENT, `--prompt=${instruction}`, "--behavior", "steer", "--json"],
      [
        "logs",
        TRIAL_AGENT,
        "--since",
        since,
        "--filter",
        "assistant_message",
        "--tail",
        "20",
        "--json",
      ],
    ]);
  });
});

describe("restricted tool", () => {
  it("accepts bounded real instructions and status only, never a selected target", () => {
    expect(
      validateTool("paseo_pi_request", {
        instruction: "Explain scripts/call-preview.mjs without changing files",
      }),
    ).toBe(true);
    expect(
      validateTool("paseo_pi_request", { instruction: "Explain this", agentId: "other" }),
    ).toBe(false);
    expect(validateTool("paseo_pi_request", { instruction: "" })).toBe(false);
    expect(validateTool("paseo_pi_request", { instruction: "x".repeat(8001) })).toBe(false);
    expect(validateTool("paseo_pi_request", { instruction: 42 })).toBe(false);
    expect(validateTool("paseo_pi_request", { instruction: "bad\u0000value" })).toBe(false);
    expect(validateTool("paseo_pi_status", {})).toBe(true);
    expect(validateTool("paseo_pi_status", { agentId: "other" })).toBe(false);
    expect(validateTool("shell", {})).toBe(false);
    expect(validateTool("paseo_pi_request", null)).toBe(false);
  });
});

describe("call preview admission", () => {
  it("accepts only the configured host and exact browser origin", () => {
    const origin = "https://titanium.tail75866.ts.net:8443";
    expect(admitUpgrade({ host: "titanium.tail75866.ts.net:8443", origin }, [origin])).toBe(true);
    expect(admitUpgrade({ host: "evil.test", origin }, [origin])).toBe(false);
    expect(
      admitUpgrade({ host: "titanium.tail75866.ts.net:8443", origin: "https://evil.test" }, [
        origin,
      ]),
    ).toBe(false);
    expect(admitUpgrade({ host: "titanium.tail75866.ts.net:8443" }, [origin])).toBe(false);
  });
});
