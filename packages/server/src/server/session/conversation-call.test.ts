import { expect, test } from "vitest";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { MemoryCallRpc } from "./test-utils/call-rpc.js";
import {
  ConversationCalls,
  type CallAgent,
  type CallProvider,
  type CallProviderOptions,
} from "./conversation-call.js";
import { conversationHistory } from "./conversation-call-history.js";
import { SessionDelivery } from "./owned-subscriptions/index.js";

function fixture(
  startProvider: () => Promise<void> = async () => {},
  createProvider?: (options: CallProviderOptions) => CallProvider,
) {
  const source = {};
  const starts: string[] = [];
  let stopped = 0;
  let allowed = true;
  let bound: CallProviderOptions | null = null;
  let expire = async () => {};
  let now = 0;
  const deadlines = new Set<{ at: number; callback(): Promise<void> }>();
  const provider: CallProvider = {
    async start(sdp) {
      starts.push(sdp);
      await startProvider();
      return "answer";
    },
    async stop() {
      stopped++;
    },
  };
  const agent: CallAgent = {
    title: "Harmless Pi",
    cwd: "/tmp",
    async request(text) {
      return `Pi replied: ${text}`;
    },
    async history() {
      return conversationHistory([], {});
    },
    async status() {
      return "idle";
    },
  };
  const messages: unknown[] = [];
  const delivery = new SessionDelivery((_source, message) => {
    messages.push(message);
  });
  const calls = new ConversationCalls({
    delivery,
    scheduleEnd(callback) {
      expire = callback;
      const deadline = { at: now + 10 * 60 * 1000, callback };
      deadlines.add(deadline);
      return () => {
        deadlines.delete(deadline);
      };
    },
    resolveAgent: async (id) => {
      if (!allowed || id !== "pi") throw new Error("Target is not an eligible live Pi agent");
      return agent;
    },
    createProvider: (options) => {
      bound = options;
      return createProvider ? createProvider(options) : provider;
    },
  });
  function start(agentId = "pi", callId = "c1", owner = source) {
    let answer = "";
    return delivery
      .request(
        owner,
        { type: "conversation.call.start.request", requestId: "r", callId, agentId, sdp: "offer" },
        async () => {
          answer = await calls.start({ callId, agentId, sdp: "offer" });
        },
      )
      .then(() => answer);
  }
  async function end(callId = "c1", owner = source) {
    await delivery.request(
      owner,
      { type: "conversation.call.end.request", requestId: "end", callId },
      () => calls.end(callId),
    );
  }
  return {
    calls,
    delivery,
    source,
    starts,
    messages,
    start,
    end,
    expire: () => expire(),
    get expiration() {
      return expire;
    },
    async advance(minutes: number) {
      const until = now + minutes * 60 * 1000;
      for (;;) {
        const next = [...deadlines].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > until) break;
        now = next.at;
        deadlines.delete(next);
        await next.callback();
      }
      now = until;
    },
    get timers() {
      return deadlines.size;
    },
    revoke() {
      allowed = false;
    },
    get bound() {
      if (!bound) throw new Error("not started");
      return bound;
    },
    get stopped() {
      return stopped;
    },
  };
}

test("starts the bound target and stops only the owned provider on disconnect", async () => {
  const f = fixture();
  expect(await f.start()).toBe("answer");
  expect(f.starts).toEqual(["offer"]);
  await f.delivery.detach(f.source);
  expect(f.stopped).toBe(1);
  expect(f.timers).toBe(0);
  await f.advance(30);
  expect(f.stopped).toBe(1);
});

test("a sibling socket cannot end or retarget an active call", async () => {
  const f = fixture();
  await f.start();
  await expect(f.start("pi", "c2")).rejects.toThrow("already active");
  await expect(f.end("c1", {})).rejects.toThrow("not owned");
  expect(f.stopped).toBe(0);
  await f.end();
  expect(f.stopped).toBe(1);
  expect(f.messages).toEqual([]);
  expect(f.timers).toBe(0);
  await f.delivery.close();
});

test("revalidates permission and target eligibility before each delegated operation", async () => {
  const f = fixture();
  await f.start();
  expect(await f.bound.agent.request("question", f.bound.signal)).toBe("Pi replied: question");
  f.revoke();
  await expect(f.bound.agent.request("write files", f.bound.signal)).rejects.toThrow(
    "eligible live Pi",
  );
  await expect(f.bound.agent.status(f.bound.signal)).rejects.toThrow("eligible live Pi");
  await expect(f.bound.agent.history({}, f.bound.signal)).rejects.toThrow("eligible live Pi");
  await f.delivery.close();
});

test("cancel during target validation cannot acquire a late provider", async () => {
  const f = fixture();
  const starting = f.start();
  await f.end();
  await expect(starting).rejects.toThrow();
  expect(f.starts).toEqual([]);
  expect(f.stopped).toBe(0);
  await f.delivery.close();
});

test("a terminal provider error releases its call slot", async () => {
  const f = fixture();
  await f.start();
  f.bound.emit({ kind: "error", message: "Provider ended" });
  await Promise.resolve();
  expect(f.stopped).toBe(1);
  expect(await f.start("pi", "c2")).toBe("answer");
  await f.delivery.close();
});

test("revoking call authority releases every owned call", async () => {
  const f = fixture();
  await f.start();
  await f.calls.close();
  expect(f.stopped).toBe(1);
  expect(f.delivery.registrationCount).toBe(0);
  await f.delivery.close();
});

test("conversation at nine minutes survives the former absolute ten-minute limit", async () => {
  const f = fixture();
  await f.start();
  await f.advance(9);
  f.bound.onConversationActivity?.();
  await f.advance(2);
  expect(f.stopped).toBe(0);
  await f.advance(8);
  expect(f.stopped).toBe(1);
  expect(f.timers).toBe(0);
  await f.delivery.close();
});

test("idle timing begins at provider readiness, not during the separate startup deadline", async () => {
  let ready = () => {};
  const connecting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const f = fixture(() => connecting);
  const starting = f.start();
  await Promise.resolve();
  await f.advance(9);
  expect(f.timers).toBe(0);
  ready();
  await starting;
  await f.advance(9);
  expect(f.stopped).toBe(0);
  await f.advance(1);
  expect(f.stopped).toBe(1);
  await f.delivery.close();
});

test("provider user and assistant deltas keep a call alive beyond twenty minutes, then completion starts ten quiet minutes", async () => {
  const rpc = new MemoryCallRpc();
  const f = fixture(undefined, (options) => new CodexConversationCall(rpc, options));
  await f.start();
  for (let minute = 0; minute < 30; minute++) {
    await f.advance(1);
    rpc.notifyHandler("thread/realtime/transcript/delta", {
      threadId: "voice-thread",
      role: minute % 2 ? "user" : "assistant",
      delta: "synthetic speech",
    });
    expect(rpc.disposed).toBe(0);
    expect(f.timers).toBe(1);
  }
  await f.advance(1);
  rpc.notifyHandler("thread/realtime/transcript/done", {
    threadId: "voice-thread",
    role: "assistant",
    text: "synthetic speech ended",
  });
  await f.advance(9.999);
  expect(rpc.disposed).toBe(0);
  await f.advance(0.001);
  expect(rpc.disposed).toBe(1);
  expect(f.timers).toBe(0);
  expect(f.messages).toContainEqual({
    type: "conversation.call.event",
    payload: {
      callId: "c1",
      event: {
        kind: "error",
        message:
          "Call ended after ten minutes without conversation. Pi keeps working; you can call again.",
      },
    },
  });
  await f.advance(30);
  expect(rpc.disposed).toBe(1);
  expect(f.messages).toHaveLength(2); // One final transcript and one expiration notice.
  expect(f.delivery.registrationCount).toBe(0);
  await f.delivery.close();
});

test("tool observations, summaries, history and generic provider frames cannot reset idle time", async () => {
  const rpc = new MemoryCallRpc();
  const f = fixture(undefined, (options) => new CodexConversationCall(rpc, options));
  await f.start();
  await f.advance(9);
  rpc.notifyHandler("ping", { threadId: "voice-thread" });
  rpc.notifyHandler("thread/realtime/item/added", {
    threadId: "voice-thread",
    item: { type: "metadata" },
  });
  rpc.notifyHandler("thread/realtime/transcript/delta", {
    threadId: "other-thread",
    role: "user",
    delta: "speech",
  });
  rpc.notifyHandler("item/agentMessage/delta", {
    threadId: "voice-thread",
    delta: "control tokens",
  });
  await rpc.tool(
    { threadId: "voice-thread", callId: "history", tool: "paseo_pi_history", arguments: {} },
    1,
  );
  f.bound.emit({ kind: "delegation", status: "working", text: "Pi still working" });
  await f.advance(1);
  expect(rpc.disposed).toBe(1);
  expect(f.timers).toBe(0);
  await f.delivery.close();
});

test("old callbacks and old call activity cannot expire or revive a replacement call", async () => {
  const f = fixture();
  await f.start();
  const old = f.bound;
  // Capture a timeout already queued before cancellation.
  const queued = f.expiration;
  await f.advance(9);
  old.onConversationActivity?.();
  await queued();
  expect(f.stopped).toBe(0);
  await f.end();
  expect(f.timers).toBe(0);
  await f.start("pi", "c2");
  await f.advance(9);
  old.onConversationActivity?.();
  await queued();
  expect(f.stopped).toBe(1);
  expect(f.timers).toBe(1);
  await f.advance(1);
  expect(f.stopped).toBe(2);
  old.onConversationActivity?.();
  await queued();
  await f.calls.close();
  await f.advance(30);
  expect(f.stopped).toBe(2);
  expect(f.timers).toBe(0);
  await f.delivery.close();
});

test("ten minutes without conversation releases the provider without agent control", async () => {
  const f = fixture();
  await f.start();
  await f.expire();
  expect(f.stopped).toBe(1);
  expect(f.delivery.registrationCount).toBe(0);
  await f.delivery.close();
});

test("rejects an invalid target before starting the provider", async () => {
  const f = fixture();
  await expect(f.start("unknown")).rejects.toThrow("eligible live Pi");
  expect(f.starts).toEqual([]);
  await f.delivery.close();
});
