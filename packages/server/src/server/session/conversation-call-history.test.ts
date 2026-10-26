import { expect, test } from "vitest";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { conversationHistory } from "./conversation-call-history.js";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { MemoryCallRpc } from "./test-utils/call-rpc.js";

test("read cancellation is request-scoped and a slow status cannot rewind catchup", async () => {
  const rpc = new MemoryCallRpc();
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let historySignal: AbortSignal | undefined;
  let requestSignal: AbortSignal | undefined;
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-01-01T00:00:00Z",
      item: { type: "assistant_message", text: "startup" },
    },
  ];
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request(_instruction, signal) {
        requestSignal = signal;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true }),
        );
        return "unreachable";
      },
      async status() {
        await statusGate;
        return "Pi status: running";
      },
      async history(input, signal) {
        if (input.before === 2) {
          historySignal = signal;
          await historyGate;
        }
        signal.throwIfAborted();
        return { ...conversationHistory(rows, input), epoch: "original" };
      },
    },
    emit() {},
    signal: new AbortController().signal,
  });
  await call.start("offer");
  const tool = (name: string, id: number, args = {}) =>
    rpc.tool({ threadId: "voice-thread", callId: String(id), tool: name, arguments: args }, id);
  const request = tool("paseo_pi_request", 1, { instruction: "one task" });
  const slowStatus = tool("paseo_pi_status", 2);
  const slowHistory = tool("paseo_pi_history", 3, { before: 2 });
  rows.push({
    seq: 5,
    timestamp: "2026-01-01T00:00:01Z",
    item: { type: "assistant_message", text: "posted later" },
  });
  expect(await tool("paseo_pi_catchup", 4)).toMatchObject({ success: true });
  rpc.notifyHandler("serverRequest/resolved", { threadId: "voice-thread", requestId: 1 });
  expect(await request).toMatchObject({ success: false });
  expect(requestSignal?.aborted).toBe(true);
  expect(historySignal?.aborted).toBe(false);
  releaseHistory();
  expect(await slowHistory).toMatchObject({ success: true });
  releaseStatus();
  expect(await slowStatus).toMatchObject({ success: true });
  const result = (await tool("paseo_pi_catchup", 5)) as { contentItems: Array<{ text: string }> };
  expect(JSON.parse(result.contentItems[0]!.text)).toMatchObject({
    messages: [],
    deliveredCursor: 5,
  });
  await call.stop();
});

test("interrupted-result recovery stays byte bounded alongside offer metadata", async () => {
  const rows: AgentTimelineRow[] = [];
  const rpc = new MemoryCallRpc();
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      subscribe() {
        return () => {};
      },
      async request() {
        throw new Error("no work");
      },
      async status() {
        return "idle";
      },
      async history(input) {
        return { ...conversationHistory(rows, input), epoch: "one" };
      },
    },
    emit() {},
    signal: new AbortController().signal,
  });
  await call.start("offer");
  rows.push(
    ...[1, 2].map(
      (seq): AgentTimelineRow => ({
        seq,
        timestamp: "2026-01-01T00:00:00Z",
        item: { type: "assistant_message", text: "z".repeat(4670) },
      }),
    ),
  );
  const tool = (id: number) =>
    rpc.tool(
      { threadId: "voice-thread", callId: String(id), tool: "paseo_pi_catchup", arguments: {} },
      id,
    );
  await tool(1);
  const result = (await tool(2)) as { contentItems: Array<{ text: string }> };
  expect(Buffer.byteLength(result.contentItems[0]!.text)).toBeLessThanOrEqual(10000);
  expect(JSON.parse(result.contentItems[0]!.text).lastReturnedPage.messages.at(-1).seq).toBe(2);
  await call.stop();
});

test("catchup continues after quiet startup, preserves bounded pages, and history never moves its cursor", async () => {
  const rows: AgentTimelineRow[] = [];
  function append(text: string, user = false) {
    rows.push({
      seq: rows.length + 1,
      timestamp: "2026-01-01T00:00:00Z",
      item: { type: user ? "user_message" : "assistant_message", text },
    });
  }
  append("older", true);
  append("recent");
  const rpc = new MemoryCallRpc();
  const reads: unknown[] = [];
  let epoch = "original";
  let failRead = false;
  let rejectDelivery = false;
  let releaseRead: (() => void) | null = null;
  let readGate: Promise<void> | null = null;
  const call = new CodexConversationCall(rpc, {
    agent: {
      title: "Pi",
      cwd: "/tmp",
      async request() {
        throw new Error("must not send");
      },
      async status() {
        return "idle";
      },
      async history(input, signal) {
        signal.throwIfAborted();
        reads.push(input);
        if (readGate) await readGate;
        if (failRead) throw new DOMException("Observation cancelled", "AbortError");
        return { ...conversationHistory(rows, input), epoch };
      },
    },
    emit(event) {
      if (event.kind === "delegation" && event.status === "answered" && rejectDelivery)
        throw new Error("backpressure");
    },
    signal: new AbortController().signal,
  });
  await call.start("offer");
  let id = 0;
  async function tool(name: string, args: unknown = {}) {
    const result = (await rpc.tool(
      { threadId: "voice-thread", callId: String(++id), tool: name, arguments: args },
      id,
    )) as { success: boolean; contentItems: Array<{ text: string }> };
    expect(result.success).toBe(true);
    return JSON.parse(result.contentItems[0]!.text);
  }
  const first = await tool("paseo_pi_catchup", { limit: 1 });
  expect(first).toMatchObject({
    messages: [],
    skippedOlder: false,
    deliveredCursor: 2,
  });
  append("next question", true);
  append("reply one");
  append("another question", true);
  append("reply two");
  await tool("paseo_pi_history", { before: 2 });
  await tool("paseo_pi_history", { after: 0 });
  expect(
    await rpc.tool(
      { threadId: "voice-thread", callId: "cheap-status", tool: "paseo_pi_status", arguments: {} },
      100,
    ),
  ).toMatchObject({ success: true });
  expect(
    (await tool("paseo_pi_catchup", { limit: 2 })).messages.map(
      (message: { seq: number }) => message.seq,
    ),
  ).toEqual([3, 4]);
  const last = await tool("paseo_pi_catchup", { limit: 2 });
  expect(last).toMatchObject({ hasMore: false, deliveredCursor: 6 });
  expect(last.messages.map((message: { seq: number }) => message.seq)).toEqual([5, 6]);
  const replayable = await tool("paseo_pi_catchup");
  expect(replayable.messages).toEqual([]);
  expect(replayable.lastReturnedPage).toMatchObject({
    messages: [
      { seq: 5, text: "another question" },
      { seq: 6, text: "reply two" },
    ],
  });
  expect(replayable.deliveryNote).toContain("not proof");
  expect(reads).toEqual([
    { limit: 20 },
    { after: 2, limit: 1 },
    { before: 2 },
    { after: 0 },
    { after: 2, limit: 2 },
    { after: 4, limit: 2 },
    { after: 6 },
  ]);
  append("typed while away", true);
  append("a".repeat(15000));
  append("typed again", true);
  append("b".repeat(15000));
  async function failedAttempt() {
    return rpc.tool(
      { threadId: "voice-thread", callId: String(++id), tool: "paseo_pi_catchup", arguments: {} },
      id,
    );
  }
  failRead = true;
  expect(await failedAttempt()).toMatchObject({ success: false });
  failRead = false;
  rejectDelivery = true;
  expect(await failedAttempt()).toMatchObject({ success: false });
  rejectDelivery = false;
  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const cancelled = failedAttempt();
  rpc.notifyHandler("serverRequest/resolved", { requestId: id });
  releaseRead!();
  expect(await cancelled).toMatchObject({ success: false });
  readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const pending = tool("paseo_pi_catchup");
  expect(await failedAttempt()).toMatchObject({ success: false });
  releaseRead!();
  const bounded = await pending;
  readGate = null;
  expect(bounded.messages.map((message: { seq: number }) => message.seq)).toEqual([7, 8, 9]);
  expect(bounded).toMatchObject({ hasMore: true, deliveredCursor: 9 });
  expect(bounded.messages[1].textTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(10000);
  expect(
    (await tool("paseo_pi_catchup")).messages.map((message: { seq: number }) => message.seq),
  ).toEqual([10]);
  expect(reads.slice(7)).toEqual([
    { after: 6 },
    { after: 6 },
    { after: 6 },
    { after: 6 },
    { after: 9 },
  ]);
  epoch = "rewound";
  append("rewritten timeline", true);
  expect(await failedAttempt()).toMatchObject({ success: false });
  await call.stop();
});
