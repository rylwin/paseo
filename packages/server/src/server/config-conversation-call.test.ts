import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { loadConfig } from "./config.js";

test("conversation calls are opt-in with an explicit executable host binary", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-call-config-"));
  try {
    expect(loadConfig(home, { env: {} }).conversationCallCodexBinary).toBeUndefined();
    expect(
      loadConfig(home, { env: { PASEO_CONVERSATION_CALLS_CODEX_BINARY: process.execPath } })
        .conversationCallCodexBinary,
    ).toBe(process.execPath);
    expect(() =>
      loadConfig(home, { env: { PASEO_CONVERSATION_CALLS_CODEX_BINARY: "/nonexistent/codex" } }),
    ).toThrow("executable");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
