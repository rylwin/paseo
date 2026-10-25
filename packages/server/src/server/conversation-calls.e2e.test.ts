import { expect, test } from "vitest";
import { hash } from "bcryptjs";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

test("the real authenticated endpoint rejects unknown and wrong-provider targets before provider launch", async () => {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    conversationCallCodexBinary: process.execPath,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.23.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    expect(client.getLastServerInfoMessage()?.features?.conversationCalls).toBe(true);
    await expect(
      client.startConversationCall({ callId: "missing", agentId: "unknown", sdp: "offer" }),
    ).rejects.toThrow("eligible live Pi");
    const codex = await client.createAgent({ provider: "codex", cwd: daemon.paseoHome });
    await expect(
      client.startConversationCall({ callId: "wrong-provider", agentId: codex.id, sdp: "offer" }),
    ).rejects.toThrow("eligible live Pi");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("unauthenticated clients cannot reach call signaling", async () => {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    conversationCallCodexBinary: process.execPath,
    auth: { password: await hash("isolated-test-password", 4) },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.23.0",
    password: "incorrect-test-password",
  });
  try {
    await expect(client.connect()).rejects.toThrow("Incorrect password");
    expect(client.getLastServerInfoMessage()).toBeNull();
    expect(client.isConnected).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("a daemon without call capability leaves normal chat available and refuses calls", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.23.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await expect(
      client.startConversationCall({ callId: "test", agentId: "unknown", sdp: "offer" }),
    ).rejects.toThrow("Update the host");
    expect(client.isConnected).toBe(true);
    expect((await client.fetchAgents()).entries).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
});
