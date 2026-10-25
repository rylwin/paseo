import { expect, test } from "vitest";
import pino from "pino";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { resolveCallAgent } from "./conversation-call-agent.js";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { MemoryCallRpc } from "./test-utils/call-rpc.js";

test("voice barge-in, control request cancellation and hangup preserve Pi work; a later call reads its completion", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let accepted!: () => void;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const prompts: unknown[] = [];
  const host = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: {
      pi: createTestAgentClient("pi", {
        onStartTurn(prompt) {
          prompts.push(prompt);
        },
        async beforeTurnComplete() {
          accepted();
          await gate;
        },
      }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws`, appVersion: "0.23.0" });
  const observation = new AbortController();
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const pi = await client.createAgent({ provider: "pi", cwd: host.paseoHome });
    const bound = await resolveCallAgent({
      agentId: pi.id,
      agentManager: host.daemon.agentManager,
      agentStorage: host.daemon.agentStorage,
      allows: () => true,
      logger: pino({ level: "silent" }),
    });
    const rpc = new MemoryCallRpc();
    const voice = new CodexConversationCall(rpc, {
      agent: bound,
      emit() {},
      signal: observation.signal,
    });
    await voice.start("offer");
    const waiting = rpc.tool(
      {
        threadId: "voice-thread",
        callId: "long-task",
        tool: "paseo_pi_request",
        arguments: { instruction: "Respond with exactly: Work survived hangup" },
      },
      1,
    );
    await started;
    rpc.notifyHandler("thread/realtime/transcript/done", {
      threadId: "voice-thread",
      role: "user",
      text: "Wait, I am talking over you",
    });
    rpc.notifyHandler("serverRequest/resolved", { threadId: "voice-thread", requestId: 1 });
    expect(host.daemon.agentManager.getAgent(pi.id)?.lifecycle).toBe("running");
    expect(prompts).toHaveLength(1);
    observation.abort();
    await voice.stop();
    expect(await waiting).toMatchObject({ success: false });
    expect(host.daemon.agentManager.getAgent(pi.id)?.lifecycle).toBe("running");
    expect(await bound.status(new AbortController().signal)).toContain("Pi status: running");
    expect(prompts).toEqual(["Respond with exactly: Work survived hangup"]);
    finish();
    await host.daemon.agentManager.waitForAgentEvent(pi.id);
    expect(await bound.status(new AbortController().signal)).toContain(
      "Pi status: idle. Pending permissions: 0. Latest assistant reply: Work survived hangup",
    );
    expect(prompts).toHaveLength(1);
    const laterRpc = new MemoryCallRpc();
    const later = new CodexConversationCall(laterRpc, {
      agent: bound,
      emit() {},
      signal: new AbortController().signal,
    });
    await later.start("offer");
    expect(
      await laterRpc.tool(
        {
          threadId: "voice-thread",
          callId: "later-status",
          tool: "paseo_pi_status",
          arguments: {},
        },
        2,
      ),
    ).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "Pi status: idle. Pending permissions: 0. Latest assistant reply: Work survived hangup",
        },
      ],
    });
    expect(prompts).toHaveLength(1);
    await later.stop();
  } finally {
    finish();
    await client.close();
    await host.close();
  }
});

test("binds only an eligible live Pi under the caller's current workspace authority", async () => {
  const host = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: { pi: createTestAgentClient("pi"), codex: createTestAgentClient("codex") },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws`, appVersion: "0.23.0" });
  let allowed = true;
  const resolve = (agentId: string) =>
    resolveCallAgent({
      agentId,
      agentManager: host.daemon.agentManager,
      agentStorage: host.daemon.agentStorage,
      allows: () => allowed,
      logger: pino({ level: "silent" }),
    });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await expect(resolve("missing")).rejects.toThrow("eligible live Pi");
    const codex = await client.createAgent({ provider: "codex", cwd: host.paseoHome });
    await expect(resolve(codex.id)).rejects.toThrow("eligible live Pi");
    const pi = await client.createAgent({
      provider: "pi",
      cwd: host.paseoHome,
      title: "Call target",
    });
    const bound = await resolve(pi.id);
    expect(bound.title).toBe("Call target");
    const cancelled = new AbortController();
    const unaccepted = bound.request("Respond with exactly: Never submitted", cancelled.signal);
    cancelled.abort();
    await expect(unaccepted).rejects.toThrow();
    expect(host.daemon.agentManager.hasInFlightRun(pi.id)).toBe(false);
    expect(
      host.daemon.agentManager.getTimeline(pi.id).filter((item) => item.type === "user_message"),
    ).toEqual([]);
    expect(
      await bound.request("Respond with exactly: Actual Pi answer", new AbortController().signal),
    ).toBe("Pi replied: Actual Pi answer");
    expect(await bound.status(new AbortController().signal)).toContain("Actual Pi answer");
    allowed = false;
    await expect(resolve(pi.id)).rejects.toThrow("workspace authority");
    allowed = true;
    await client.archiveAgent(pi.id);
    await expect(resolve(pi.id)).rejects.toThrow("eligible live Pi");
  } finally {
    await client.close();
    await host.close();
  }
});
