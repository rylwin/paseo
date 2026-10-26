import { expect, test } from "vitest";
import { CallReadiness } from "./readiness";

test("a connected peer alone cannot enable input or announce ready", () => {
  const actions: string[] = [];
  const readiness = new CallReadiness(
    () => actions.push("ready"),
    () => actions.push("failed"),
  );
  readiness.peerConnected();
  expect(actions).toEqual([]);
  readiness.channelOpened();
  expect(actions).toEqual([]);
  readiness.message(
    JSON.stringify({ type: "session.started", session: { id: "rtc_test", status: "active" } }),
  );
  expect(actions).toEqual(["ready"]);
});

test("provider readiness may precede transport readiness and only announces once", () => {
  const actions: string[] = [];
  const readiness = new CallReadiness(
    () => actions.push("ready"),
    () => actions.push("failed"),
  );
  readiness.message('{"type":"session.started","session":{"status":"active"}}');
  readiness.peerConnected();
  expect(actions).toEqual([]);
  readiness.channelOpened();
  readiness.peerConnected();
  readiness.channelOpened();
  expect(actions).toEqual(["ready"]);
});

test("provider errors reject readiness but unrelated and malformed events do not", () => {
  const actions: string[] = [];
  const readiness = new CallReadiness(
    () => actions.push("ready"),
    (message) => actions.push(message),
  );
  readiness.peerConnected();
  readiness.channelOpened();
  readiness.message("not JSON");
  readiness.message('{"type":"session.started","session":{"status":"starting"}}');
  expect(actions).toEqual([]);
  readiness.message('{"type":"error","error":{"message":"provider detail"}}');
  readiness.message('{"type":"session.started","session":{"status":"active"}}');
  expect(actions).toEqual(["Voice session failed to connect. Try calling again."]);
});

test.each([
  ["stop", []],
  ["channelClosed", ["failed"]],
  ["channelError", ["failed"]],
] as const)("%s permanently prevents readiness", (action, expected) => {
  const actions: string[] = [];
  const readiness = new CallReadiness(
    () => actions.push("ready"),
    () => actions.push("failed"),
  );
  readiness[action]();
  readiness.peerConnected();
  readiness.channelOpened();
  readiness.message('{"type":"session.started","session":{"status":"active"}}');
  expect(actions).toEqual(expected);
});
