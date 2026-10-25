export function isCallPreviewEnabled(
  development: boolean,
  demo: string | undefined,
  live: string | undefined,
) {
  return demo === "1" && (development || live === "1");
}

export type DemoConnection = "connecting" | "connected" | "reconnecting" | "failed" | "ended";

export interface CallDemoState {
  connection: DemoConnection;
  muted: boolean;
  expanded: boolean;
  piWorking: boolean;
}

export const initialCallDemoState: CallDemoState = {
  connection: "connecting",
  muted: false,
  expanded: true,
  piWorking: true,
};

export type CallDemoAction =
  | { type: "toggleMute" | "toggleExpanded" | "hangUp" | "retry" }
  | { type: "simulate"; connection: DemoConnection };

export function reduceCallDemo(state: CallDemoState, action: CallDemoAction): CallDemoState {
  if (action.type === "simulate") return { ...state, connection: action.connection };
  if (action.type === "retry") return { ...state, connection: "connecting" };
  if (action.type === "hangUp") return { ...state, connection: "ended" };
  if (action.type === "toggleExpanded") return { ...state, expanded: !state.expanded };
  if (state.connection === "ended" || state.connection === "failed") return state;
  return { ...state, muted: !state.muted };
}

const presentation = {
  connecting: { label: "Connecting...", detail: "Waiting for the simulated connection" },
  connected: { label: "Connected", detail: "Simulated voice activity" },
  reconnecting: { label: "Reconnecting...", detail: "Audio paused while reconnecting" },
  failed: { label: "Connection failed", detail: "Try again to restart the simulated connection" },
  ended: { label: "Call ended", detail: "Pi keeps working independently of this call" },
};

export function presentCallDemo(state: CallDemoState) {
  return {
    ...presentation[state.connection],
    audioActive: state.connection === "connected" && !state.muted,
    canRetry: state.connection === "failed" || state.connection === "ended",
  };
}
