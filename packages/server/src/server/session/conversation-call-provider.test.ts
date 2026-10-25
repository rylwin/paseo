import { expect, test } from "vitest";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { MemoryCallRpc as MemoryRpc } from "./test-utils/call-rpc.js";

test("only structured tools for the bound target are admitted and a duplicate is never resent", async () => {
  const rpc = new MemoryRpc();
  const sent: string[] = [];
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request(text) {
        sent.push(text);
        return "Pi answered";
      },
      async status() {
        return "idle";
      },
    },
    emit() {},
    signal: new AbortController().signal,
  });
  await call.start("offer");
  expect(
    await rpc.tool(
      {
        threadId: "voice-thread",
        callId: "bad-arguments",
        tool: "paseo_pi_request",
        arguments: { instruction: "explain", agentId: "other" },
      },
      1,
    ),
  ).toMatchObject({ success: false });
  expect(
    await rpc.tool(
      {
        threadId: "other-thread",
        callId: "bad-thread",
        tool: "paseo_pi_request",
        arguments: { instruction: "explain" },
      },
      2,
    ),
  ).toMatchObject({ success: false });
  expect(
    await rpc.tool(
      {
        threadId: "voice-thread",
        callId: "delegation",
        tool: "paseo_pi_request",
        arguments: { instruction: "explain" },
      },
      3,
    ),
  ).toMatchObject({ success: true });
  expect(
    await rpc.tool(
      {
        threadId: "voice-thread",
        callId: "delegation",
        tool: "paseo_pi_request",
        arguments: { instruction: "explain" },
      },
      4,
    ),
  ).toMatchObject({ success: false });
  expect(sent).toEqual(["explain"]);
  await call.stop();
});

test("cancellation rejects a missing answer and disposes the owned transport", async () => {
  const rpc = new MemoryRpc();
  rpc.sendSdp = false;
  const abort = new AbortController();
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request() {
        return "answer";
      },
      async status() {
        return "idle";
      },
    },
    emit() {},
    signal: abort.signal,
  });
  const starting = call.start("offer");
  abort.abort();
  await expect(starting).rejects.toThrow();
  const stopping = call.stop();
  expect(call.stop()).toBe(stopping);
  await stopping;
  expect(rpc.disposed).toBe(1);
});

test("forwards bounded transcripts and terminates on a provider error", async () => {
  const rpc = new MemoryRpc();
  const events: unknown[] = [];
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request() {
        return "answer";
      },
      async status() {
        return "idle";
      },
    },
    emit(event) {
      events.push(event);
    },
    signal: new AbortController().signal,
  });
  await call.start("offer");
  rpc.notifyHandler("thread/realtime/transcript/done", {
    threadId: "voice-thread",
    role: "assistant",
    text: "x".repeat(2500),
  });
  rpc.notifyHandler("thread/realtime/error", {
    threadId: "voice-thread",
    message: "private provider detail",
  });
  expect(events).toEqual([
    { kind: "transcript", role: "assistant", text: "x".repeat(2000) },
    {
      kind: "error",
      message:
        "GPT-Live reported a call error. Check host login and GPT-Live support, then try again.",
    },
  ]);
  expect(rpc.disposed).toBe(1);
});

test("missing host realtime support fails clearly without exposing provider diagnostics", async () => {
  const rpc = new MemoryRpc();
  rpc.failMethod = "thread/realtime/start";
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request() {
        return "answer";
      },
      async status() {
        return "idle";
      },
    },
    emit() {},
    signal: new AbortController().signal,
  });
  await expect(call.start("offer")).rejects.toThrow(
    "Could not start GPT-Live. Check the host's Codex login, installed realtime support, and GPT-Live entitlement.",
  );
  expect(rpc.disposed).toBe(1);
});

test("starts v3 WebRTC with native delegation acknowledgment and discovers the control model", async () => {
  const rpc = new MemoryRpc();
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "My Pi",
      cwd: "/tmp/pi",
      async request() {
        return "answer";
      },
      async status() {
        return "idle";
      },
    },
    emit() {},
    signal: new AbortController().signal,
  });
  expect(await call.start("offer")).toBe("answer");
  expect(rpc.requests.find((r) => r.method === "thread/realtime/start")?.params).toMatchObject({
    version: "v3",
    transport: { type: "webrtc", sdp: "offer" },
    delegationAckFiller: true,
    includeStartupContext: false,
  });
  expect(rpc.requests.find((r) => r.method === "thread/start")?.params).toMatchObject({
    model: "control-default",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  await call.stop();
  expect(rpc.disposed).toBe(1);
});
