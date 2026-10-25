import { expect, test } from "vitest";
import {
  ConversationCalls,
  type CallAgent,
  type CallProvider,
  type CallProviderOptions,
} from "./conversation-call.js";
import { SessionDelivery } from "./owned-subscriptions/index.js";

function fixture() {
  const source = {};
  const starts: string[] = [];
  let stopped = 0;
  let allowed = true;
  let bound: CallProviderOptions | null = null;
  let expire = async () => {};
  const provider: CallProvider = {
    async start(sdp) {
      starts.push(sdp);
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
    async status() {
      return "idle";
    },
  };
  const delivery = new SessionDelivery(() => {});
  const calls = new ConversationCalls({
    delivery,
    scheduleEnd(callback) {
      expire = callback;
      return () => {};
    },
    resolveAgent: async (id) => {
      if (!allowed || id !== "pi") throw new Error("Target is not an eligible live Pi agent");
      return agent;
    },
    createProvider: (options) => {
      bound = options;
      return provider;
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
    start,
    end,
    expire: () => expire(),
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
});

test("a sibling socket cannot end or retarget an active call", async () => {
  const f = fixture();
  await f.start();
  await expect(f.start("pi", "c2")).rejects.toThrow("already active");
  await expect(f.end("c1", {})).rejects.toThrow("not owned");
  expect(f.stopped).toBe(0);
  await f.end();
  expect(f.stopped).toBe(1);
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

test("the bounded call lifetime releases the provider without agent control", async () => {
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
