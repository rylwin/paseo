import { expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

test("accepts bounded conversation call signaling without changing legacy voice", () => {
  const request = {
    type: "conversation.call.start.request",
    requestId: "r1",
    callId: "call1",
    agentId: "agent1",
    sdp: "v=0\r\n",
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(true);
  expect(
    SessionInboundMessageSchema.safeParse({ ...request, sdp: "a".repeat(65537) }).success,
  ).toBe(false);
  expect(
    SessionOutboundMessageSchema.safeParse({
      type: "conversation.call.start.response",
      payload: { requestId: "r1", callId: "call1", agentId: "agent1", sdp: "v=0\r\n" },
    }).success,
  ).toBe(true);
});

test("correlates end and bounded per-call status events", () => {
  expect(
    SessionInboundMessageSchema.safeParse({
      type: "conversation.call.end.request",
      requestId: "r2",
      callId: "call1",
    }).success,
  ).toBe(true);
  expect(
    SessionOutboundMessageSchema.safeParse({
      type: "conversation.call.event",
      payload: {
        callId: "call1",
        event: { kind: "transcript", role: "assistant", text: "Pi says hello" },
      },
    }).success,
  ).toBe(true);
  expect(
    SessionOutboundMessageSchema.safeParse({
      type: "conversation.call.event",
      payload: {
        callId: "call1",
        event: { kind: "transcript", role: "assistant", text: "x".repeat(2001) },
      },
    }).success,
  ).toBe(false);
});
