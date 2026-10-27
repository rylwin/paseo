import { expect, test } from "vitest";
import { BackgroundCallSession, type CallService } from "./background";

function fixture() {
  let active: string | null = null;
  let nativeEnd: (event: { callId: string; reason: string }) => void = () => {};
  let stateChanged: (state: string) => void = () => {};
  const ended: string[] = [];
  let reason: string | null = null;
  let removed = 0;
  let quietEnds = 0;
  const failures: string[] = [];
  const service: CallService = {
    async start(id) {
      active = id;
    },
    stop(id) {
      ended.push(id);
      if (active === id) active = null;
    },
    activeId: () => active,
    endedReason: () => reason,
    subscribe(listener) {
      nativeEnd = listener;
      return () => {
        removed++;
      };
    },
    subscribeAppState(listener) {
      stateChanged = listener;
      return () => {
        removed++;
      };
    },
  };
  const session = new BackgroundCallSession(
    "one",
    service,
    () => {
      quietEnds++;
    },
    (message) => failures.push(message),
  );
  return {
    session,
    service,
    ended,
    failures,
    nativeEnd: (id: string, eventReason = "ended") =>
      nativeEnd({ callId: id, reason: eventReason }),
    state: (state: string) => stateChanged(state),
    setEndReason: (value: string) => {
      reason = value;
    },
    setActive: (id: string | null) => {
      active = id;
    },
    get quietEnds() {
      return quietEnds;
    },
    get removed() {
      return removed;
    },
  };
}

test("stale notification actions are ignored and matching End is quiet", async () => {
  const f = fixture();
  await f.session.start();
  f.nativeEnd("old");
  expect(f.quietEnds).toBe(0);
  f.nativeEnd("one");
  expect(f.quietEnds).toBe(1);
  expect(f.failures).toEqual([]);
  f.session.stop();
  f.session.stop();
  expect(f.removed).toBe(2);
});

test("service startup failure leaves no live subscriptions or native call", async () => {
  const f = fixture();
  f.service.start = async () => {
    throw new Error("background start forbidden");
  };
  await expect(f.session.start()).rejects.toThrow("background start forbidden");
  f.session.stop();
  expect(f.removed).toBe(2);
  expect(f.ended).toEqual(["one"]);
});

test("a native end before the startup acknowledgement cannot resurrect capture", async () => {
  const f = fixture();
  f.service.start = async () => {
    f.setActive(null);
    f.setEndReason("ended");
  };
  await expect(f.session.start()).rejects.toThrow("Call ended");
  expect(f.quietEnds).toBe(1);
  expect(f.failures).toEqual([]);
  f.session.stop();
});

test("resume stays quiet when notification End happened before JS could observe its event", async () => {
  const f = fixture();
  await f.session.start();
  f.setActive(null);
  f.setEndReason("ended");
  f.state("active");
  expect(f.quietEnds).toBe(1);
  expect(f.failures).toEqual([]);
  f.session.stop();
});

test("Home and lock keep a service-owned call; resume reconciles with native truth", async () => {
  const f = fixture();
  await f.session.start();
  f.state("background");
  f.state("inactive");
  f.state("active");
  expect(f.ended).toEqual([]);
  expect(f.quietEnds).toBe(0);
  f.setActive(null);
  f.state("active");
  expect(f.failures).toEqual([
    "Android stopped the call. Return to Paseo and try again. Pi work continues independently.",
  ]);
  f.session.stop();
  expect(f.removed).toBe(2);
});
