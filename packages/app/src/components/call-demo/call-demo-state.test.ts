import { describe, expect, it } from "vitest";
import { initialCallDemoState, reduceCallDemo, presentCallDemo } from "./call-demo-state";

describe("simulated call", () => {
  it("minimizes and expands without losing mute or connection state", () => {
    const minimized = reduceCallDemo(initialCallDemoState, { type: "toggleExpanded" });
    expect(minimized).toEqual({ ...initialCallDemoState, expanded: false });
    expect(reduceCallDemo(minimized, { type: "toggleExpanded" })).toEqual(initialCallDemoState);
  });
  it("ends only the call, preserving simulated Pi work and panel position", () => {
    const state = {
      ...initialCallDemoState,
      connection: "connected" as const,
      expanded: false,
      piWorking: true,
    };
    expect(reduceCallDemo(state, { type: "hangUp" })).toEqual({ ...state, connection: "ended" });
  });

  it.each([
    ["connecting", "Connecting...", "Waiting for the simulated connection"],
    ["connected", "Connected", "Simulated voice activity"],
    ["reconnecting", "Reconnecting...", "Audio paused while reconnecting"],
    ["failed", "Connection failed", "Try again to restart the simulated connection"],
    ["ended", "Call ended", "Pi keeps working independently of this call"],
  ] as const)("presents %s independently of Pi work", (connection, label, detail) => {
    expect(presentCallDemo({ ...initialCallDemoState, connection })).toMatchObject({
      label,
      detail,
    });
  });

  it("lets the harness connect, interrupt and fail before an explicit retry", () => {
    let state = reduceCallDemo(initialCallDemoState, { type: "simulate", connection: "connected" });
    expect(state.connection).toBe("connected");
    expect(presentCallDemo(state).audioActive).toBe(true);
    state = reduceCallDemo(state, { type: "simulate", connection: "reconnecting" });
    expect(presentCallDemo(state).audioActive).toBe(false);
    state = reduceCallDemo(state, { type: "simulate", connection: "failed" });
    expect(presentCallDemo(state).canRetry).toBe(true);
    expect(reduceCallDemo({ ...state, muted: true }, { type: "retry" })).toEqual({
      ...state,
      connection: "connecting",
      muted: true,
    });
  });

  it("silences activity when muted and leaves a finished call unchanged on mute", () => {
    const connected = { ...initialCallDemoState, connection: "connected" as const };
    expect(presentCallDemo(reduceCallDemo(connected, { type: "toggleMute" })).audioActive).toBe(
      false,
    );
    const ended = reduceCallDemo(connected, { type: "hangUp" });
    expect(reduceCallDemo(ended, { type: "toggleMute" })).toEqual(ended);
  });

  it("toggles mute without changing the call connection", () => {
    const muted = reduceCallDemo(initialCallDemoState, { type: "toggleMute" });
    expect(muted).toEqual({ ...initialCallDemoState, muted: true });
    expect(reduceCallDemo(muted, { type: "toggleMute" })).toEqual(initialCallDemoState);
  });
});
