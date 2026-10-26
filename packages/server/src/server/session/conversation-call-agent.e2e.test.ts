import { expect, test } from "vitest";
import pino from "pino";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { resolveCallAgent } from "./conversation-call-agent.js";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { MemoryCallRpc } from "./test-utils/call-rpc.js";
import { formatAgentMessage, projectAgentMessages } from "../agent/agent-messages/index.js";

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

test("reads an existing answer while a real Pi request observation remains pending without resending", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
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
  let offered!: () => void;
  const delivery = new Promise<void>((resolve) => {
    offered = resolve;
  });
  class DeliveryRpc extends MemoryCallRpc {
    override async request(method: string, params?: unknown) {
      const result = await super.request(method, params);
      if (method === "thread/realtime/appendText") offered();
      return result;
    }
  }
  const rpc = new DeliveryRpc();
  let voice: CodexConversationCall | undefined;
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
    voice = new CodexConversationCall(rpc, {
      agent: bound,
      emit() {},
      signal: new AbortController().signal,
    });
    await voice.start("offer");
    const waiting = rpc.tool(
      {
        threadId: "voice-thread",
        callId: "request",
        tool: "paseo_pi_request",
        arguments: { instruction: "Respond with exactly: Existing answer" },
      },
      1,
    );
    await started;
    await host.daemon.agentManager.appendTimelineItem(pi.id, {
      type: "assistant_message",
      text: "Already posted answer while request is pending",
    });
    for (const [index, tool] of [
      "paseo_pi_status",
      "paseo_pi_history",
      "paseo_pi_catchup",
    ].entries()) {
      const result = await rpc.tool(
        { threadId: "voice-thread", callId: tool, tool, arguments: {} },
        index + 2,
      );
      expect(result).toMatchObject({ success: true });
      expect(JSON.stringify(result)).toContain("Already posted answer while request is pending");
    }
    expect(prompts).toEqual(["Respond with exactly: Existing answer"]);
    expect(host.daemon.agentManager.getAgent(pi.id)?.lifecycle).toBe("running");
    rpc.notifyHandler("serverRequest/resolved", { threadId: "voice-thread", requestId: 1 });
    expect(await waiting).toMatchObject({ success: false });
    expect(host.daemon.agentManager.getAgent(pi.id)?.lifecycle).toBe("running");
    release();
    await host.daemon.agentManager.waitForAgentEvent(pi.id);
    await delivery;
    expect(
      JSON.stringify(rpc.requests.filter((entry) => entry.method === "thread/realtime/appendText")),
    ).toContain("Already posted answer while request is pending");
    expect(prompts).toHaveLength(1);
  } finally {
    release();
    await voice?.stop();
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
    await host.daemon.agentManager.appendTimelineItem(pi.id, {
      type: "user_message",
      text: "First question",
    });
    await host.daemon.agentManager.appendTimelineItem(pi.id, {
      type: "reasoning",
      text: "private thinking",
    });
    await host.daemon.agentManager.appendTimelineItem(pi.id, {
      type: "assistant_message",
      text: "First answer",
    });
    await host.daemon.agentManager.appendTimelineItem(codex.id, {
      type: "assistant_message",
      text: "wrong target",
    });
    const page = await bound.history({ limit: 1 }, new AbortController().signal);
    expect(page.messages).toEqual([
      { seq: 3, role: "assistant", text: "First answer", textTruncated: false },
    ]);
    expect(page).toMatchObject({ hasMore: true, nextCursor: 3, skippedOlder: true });
    expect(
      (await bound.history({ before: page.nextCursor!, limit: 1 }, new AbortController().signal))
        .messages,
    ).toEqual([{ seq: 1, role: "user", text: "First question", textTruncated: false }]);
    const cancelled = new AbortController();
    const unaccepted = bound.request("Respond with exactly: Never submitted", cancelled.signal);
    cancelled.abort();
    await expect(unaccepted).rejects.toThrow();
    expect(host.daemon.agentManager.hasInFlightRun(pi.id)).toBe(false);
    expect(
      host.daemon.agentManager.getTimeline(pi.id).filter((item) => item.type === "user_message"),
    ).toEqual([{ type: "user_message", text: "First question" }]);
    expect(
      await bound.request("Respond with exactly: Actual Pi answer", new AbortController().signal),
    ).toBe("Pi replied: Actual Pi answer");
    expect(await bound.status(new AbortController().signal)).toContain("Actual Pi answer");
    const signal = new AbortController().signal;
    await expect(bound.history({ before: 3, after: 0 }, signal)).rejects.toThrow();
    await expect(bound.history({ limit: 51 }, signal)).rejects.toThrow();
    const longText = '"\\\n😀'.repeat(4000);
    for (let index = 0; index < 5; index++) {
      await host.daemon.agentManager.appendTimelineItem(pi.id, {
        type: "user_message",
        text: `Question ${index}`,
      });
      await host.daemon.agentManager.appendTimelineItem(pi.id, {
        type: "assistant_message",
        text: longText,
      });
    }
    const bounded = await bound.history({ after: 3, limit: 50 }, signal);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(10000);
    expect(bounded.hasMore).toBe(true);
    expect(bounded.messages.find((message) => message.text.startsWith('"\\\n😀'))).toMatchObject({
      textTruncated: true,
    });
    const next = await bound.history({ after: bounded.nextCursor!, limit: 50 }, signal);
    expect(next.messages[0]!.seq).toBeGreaterThan(bounded.nextCursor!);
    const userText =
      "Discuss <design> & retain attachment metadata: report.pdf, application/pdf, 123 bytes";
    for (const item of projectAgentMessages({
      type: "user_message",
      text: formatAgentMessage({ id: "human", source: null, text: userText }),
    })) {
      await host.daemon.agentManager.appendTimelineItem(pi.id, item);
    }
    for (const item of projectAgentMessages({
      type: "user_message",
      text: formatAgentMessage({
        id: "agent",
        source: { kind: "agent-message", agentId: codex.id },
        text: "Unrelated agent secret",
      }),
    })) {
      await host.daemon.agentManager.appendTimelineItem(pi.id, item);
    }
    expect((await bound.history({ limit: 1 }, signal)).messages).toEqual([
      { seq: 16, role: "user", text: userText, textTruncated: false },
    ]);
    let cursor = 0;
    const seen: number[] = [];
    let more = true;
    while (more) {
      const chunk = await bound.history({ after: cursor, limit: 2 }, signal);
      seen.push(...chunk.messages.map((message) => message.seq));
      cursor = chunk.nextCursor ?? cursor;
      more = chunk.hasMore;
    }
    const expected = (await host.daemon.agentManager.getTimelineRows(pi.id))
      .filter((row) => row.item.type === "user_message" || row.item.type === "assistant_message")
      .map((row) => row.seq);
    expect(seen).toEqual(expected);
    const cancelledRead = new AbortController();
    cancelledRead.abort();
    await expect(bound.history({}, cancelledRead.signal)).rejects.toThrow();
    expect(host.daemon.agentManager.hasInFlightRun(pi.id)).toBe(false);
    allowed = false;
    await expect(bound.status(signal)).rejects.toThrow("workspace authority");
    await expect(bound.request("must not be submitted", signal)).rejects.toThrow(
      "workspace authority",
    );
    await expect(bound.history({}, signal)).rejects.toThrow("workspace authority");
    await expect(resolve(pi.id)).rejects.toThrow("workspace authority");
    allowed = true;
    await client.archiveAgent(pi.id);
    await expect(bound.history({}, signal)).rejects.toThrow("eligible live Pi");
    await expect(resolve(pi.id)).rejects.toThrow("eligible live Pi");
  } finally {
    await client.close();
    await host.close();
  }
});
