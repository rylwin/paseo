/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MediaEvents } from "./controller";
import { i18n } from "@/i18n/i18next";

const boundary = vi.hoisted(() => ({
  connected: true,
  native: false,
  focused: "pi" as string | null,
  title: "Original agent" as string | undefined,
  navigate: vi.fn(),
  play: vi.fn(),
  setSpeaker: vi.fn(),
  voice: { isVoiceMode: false, isVoiceSwitching: false },
  events: null as MediaEvents | null,
  answer: vi.fn(),
  end: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
}));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get OS() {
        return boundary.native ? "android" : "web";
      },
    },
  };
});
vi.mock("react-native-safe-area-context", async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { createContext, useContext } = await import("react");
  const SafeAreaInsetsContext = createContext({ top: 24, bottom: 16, left: 0, right: 0 });
  return {
    ...actual,
    SafeAreaInsetsContext,
    useSafeAreaInsets: () => useContext(SafeAreaInsetsContext),
  };
});
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () =>
    boundary.focused ? { serverId: "host", workspaceId: "workspace" } : null,
}));
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: (select: (state: unknown) => unknown) =>
    select({ layoutByWorkspace: { "host:workspace": { root: {}, focusedPaneId: "pane" } } }),
  collectAllTabs: () => [{ tabId: "tab", target: { kind: "agent", agentId: boundary.focused } }],
  findPaneById: () => ({
    focusedTabId: "tab",
    tabs: [{ tabId: "tab", target: { kind: "agent", agentId: boundary.focused } }],
  }),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: boundary.navigate }));
vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return !boundary.native;
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          agents: new Map([
            ["pi", { provider: "pi", title: boundary.title }],
            ["other", { provider: "pi", title: "Other agent" }],
          ]),
        },
      },
    }),
}));
vi.mock("@/contexts/voice-context", () => ({ useVoiceOptional: () => boundary.voice }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({
      getLastServerInfoMessage: () => ({ features: { conversationCalls: true } }),
      startConversationCall: boundary.start,
      endConversationCall: boundary.end,
      on: () => () => {},
      subscribeConnectionStatus: () => () => {},
    }),
  }),
  useHostRuntimeIsConnected: () => boundary.connected,
  useHostRuntimeClient: () => ({
    getLastServerInfoMessage: () => ({ features: { conversationCalls: true } }),
    startConversationCall: boundary.start,
    endConversationCall: boundary.end,
    on: () => () => {},
    subscribeConnectionStatus: () => () => {},
  }),
}));
// Browser media is the external boundary; retain the real controller and React subscriptions.
vi.mock("./media", () => ({
  supportsCalls: true,
  createCallMedia: (events: MediaEvents) => {
    boundary.events = events;
    return {
      offer: async () => "offer",
      answer: boundary.answer,
      stop: boundary.stop,
      mute: vi.fn(),
      play: boundary.play,
      setSpeaker: boundary.setSpeaker,
    };
  },
}));
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: ({
    label,
    selected,
    disabled,
    onPress,
    testID,
    style,
    round,
    hitSlop,
  }: {
    label: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
    testID?: string;
    style?: React.CSSProperties;
    round?: boolean;
    hitSlop?: number;
  }) => (
    <button
      type="button"
      aria-label={label}
      aria-selected={selected}
      disabled={disabled}
      onClick={onPress}
      data-testid={testID}
      style={style}
      data-round={round}
      data-hit-slop={hitSlop}
    />
  ),
}));
vi.mock("lucide-react-native", () => {
  const Icon = () => <span />;
  return {
    Phone: Icon,
    PhoneOff: Icon,
    PhoneOutgoing: Icon,
    Mic: Icon,
    MicOff: Icon,
    Minus: Icon,
    Maximize2: Icon,
    Info: Icon,
    CheckCircle2: Icon,
    AlertTriangle: Icon,
    CircleAlert: Icon,
    XCircle: Icon,
    Volume2: Icon,
    Smartphone: Icon,
    Headphones: Icon,
  };
});
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
import { ConversationCallAction, ConversationCallProvider } from "./context";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

function NavigationInsetProbe() {
  const insets = useSafeAreaInsets();
  return <output data-testid="navigation-insets">{JSON.stringify(insets)}</output>;
}

let root: Root;
let container: HTMLDivElement;
let resolveStart: (value: { sdp: string }) => void;
beforeEach(() => {
  boundary.connected = true;
  boundary.native = false;
  boundary.focused = "pi";
  boundary.title = "Original agent";
  boundary.voice = { isVoiceMode: false, isVoiceSwitching: false };
  boundary.events = null;
  vi.clearAllMocks();
  boundary.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  );
  boundary.end.mockResolvedValue(undefined);
  boundary.play.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(agentId = "pi", insets = { top: 24, bottom: 16, left: 0, right: 0 }) {
  boundary.focused = agentId;
  act(() =>
    root.render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <ConversationCallProvider>
          <ConversationCallAction serverId="host" agentId={agentId} />
          <NavigationInsetProbe />
        </ConversationCallProvider>
      </SafeAreaInsetsContext.Provider>,
    ),
  );
}
function phone() {
  return container.querySelector<HTMLButtonElement>('[data-testid="conversation-call-start"]')!;
}
async function click() {
  await act(async () => {
    phone().click();
  });
}

test("second composer press cancels connecting and ignores a late answer", async () => {
  render();
  await click();
  expect(phone().disabled).toBe(false);
  expect(phone().getAttribute("aria-selected")).toBe("true");
  expect(phone().getAttribute("aria-label")).toBe("Cancel call");
  await click();
  await act(async () => {
    resolveStart({ sdp: "late" });
    boundary.events!.connected();
  });
  expect(boundary.stop).toHaveBeenCalledTimes(1);
  expect(boundary.end).toHaveBeenCalledTimes(1);
  expect(boundary.answer).not.toHaveBeenCalled();
  expect(phone().getAttribute("aria-selected")).toBe("false");
  expect(phone().getAttribute("aria-label")).toBe("Call this Pi agent with GPT-Live");
});

test("connected composer stays selected, cannot retarget, and ends only the captured call", async () => {
  render();
  await click();
  await act(async () => {
    resolveStart({ sdp: "answer" });
  });
  act(() => boundary.events!.connected());
  expect(phone().getAttribute("aria-label")).toBe("End call");
  expect(phone().getAttribute("aria-selected")).toBe("true");
  render("other");
  expect(phone().disabled).toBe(true);
  expect(phone().getAttribute("aria-selected")).toBe("false");
  await click();
  expect(boundary.start).toHaveBeenCalledTimes(1);
  expect(boundary.end).not.toHaveBeenCalled();
  render();
  await click();
  expect(boundary.end).toHaveBeenCalledTimes(1);
  expect(phone().disabled).toBe(false);
  expect(phone().getAttribute("aria-selected")).toBe("false");
});

test("compact strip is always present and identity returns to the captured agent", async () => {
  render();
  await click();
  expect(container.querySelector('[data-testid="conversation-call-host"]')).not.toBeNull();
  const mute = container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!;
  expect(mute).not.toBeNull();
  act(() => mute.click());
  expect(container.querySelector('[aria-label="Unmute microphone"]')).not.toBeNull();
  render("other");
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.textContent).toContain("Original agent");
  expect(host.textContent).not.toMatch(/GPT-Live call|Voice interruptions|host \/|pi$/);
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Return to call with Original agent"]')!
      .click(),
  );
  expect(boundary.navigate).toHaveBeenCalledWith({ serverId: "host", agentId: "pi" });
  render();
  expect(container.querySelector('[data-testid="conversation-call-host"]')).not.toBeNull();
});

test.each([false, true])("autoplay recovery remains actionable (native=%s)", async (native) => {
  boundary.native = native;
  render();
  await click();
  act(() => boundary.events!.playbackBlocked(true));
  expect(container.textContent).toContain("Play call audio");
  const play = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
    (button) => button.textContent === "Play call audio",
  )!;
  await act(async () => play.click());
  expect(boundary.play).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="conversation-call-host"]')).not.toBeNull();
});

test.each([false, true])(
  "permission failure keeps identity and recovery (native=%s)",
  async (native) => {
    boundary.native = native;
    render();
    await click();
    act(() => boundary.events!.failed("Microphone permission denied"));
    render("other");
    const host = container.querySelector('[data-testid="conversation-call-host"]')!;
    expect(host.textContent).toContain("Original agent");
    expect(host.textContent).toContain("Microphone permission denied");
    expect(host.textContent).not.toMatch(/Voice interruptions|GPT-Live call|delegat|transcript/);
    const retry = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.textContent === "Call again",
    )!;
    await act(async () => retry.click());
    expect(boundary.start).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "pi" }));
  },
);

test("untitled calls use the normal agent fallback, never a raw ID or host name", async () => {
  boundary.title = undefined;
  render();
  await click();
  render("other");
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.textContent).toContain(i18n.t("agentList.fallbackTitle"));
  expect(container.querySelector('[aria-label="Return to call with New session"]')).not.toBeNull();
});

test("Android keeps the active strip but ends silently with an idle composer", async () => {
  boundary.native = true;
  render();
  await click();
  expect(phone().getAttribute("aria-label")).toBe("Cancel call");
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.textContent).toContain("Original agent");
  expect(host.querySelector('[aria-label="Mute microphone"]')).not.toBeNull();
  await click();
  expect(boundary.stop).toHaveBeenCalledTimes(1);
  expect(boundary.end).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="conversation-call-host"]')).toBeNull();
  expect(container.textContent).not.toContain("Call ended");
  expect(container.textContent).not.toContain("Call again");
  expect(phone().getAttribute("aria-selected")).toBe("false");
  expect(phone().getAttribute("aria-label")).toBe("Call this Pi agent with GPT-Live");
});

test("Android connected call hangup removes the strip without an ended notice", async () => {
  boundary.native = true;
  render();
  await click();
  await act(async () => resolveStart({ sdp: "answer" }));
  act(() => boundary.events!.connected());
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.querySelector('[aria-label="Mute microphone"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="End call"]')!.click());
  expect(container.querySelector('[data-testid="conversation-call-host"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(boundary.stop).toHaveBeenCalledTimes(1);
  expect(boundary.end).toHaveBeenCalledTimes(1);
  expect(phone().getAttribute("aria-selected")).toBe("false");
});

test("native speaker control reflects actual routes, waits for acknowledgement and preserves headset output", async () => {
  boundary.native = true;
  render();
  await click();
  const speaker = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="conversation-call-speaker"]')!;
  expect(speaker()).not.toBeNull();
  expect(speaker().disabled).toBe(true);
  act(() =>
    boundary.events!.audioOutput?.({
      route: "speaker",
      canToggle: true,
      pending: false,
      error: "",
    }),
  );
  expect(speaker().getAttribute("aria-label")).toBe("Speaker on. Switch to earpiece");
  expect(speaker().getAttribute("aria-selected")).toBe("true");
  await act(async () => speaker().click());
  expect(boundary.setSpeaker).toHaveBeenCalledWith(false);
  expect(speaker().getAttribute("aria-selected")).toBe("true");
  act(() =>
    boundary.events!.audioOutput?.({
      route: "earpiece",
      canToggle: true,
      pending: false,
      error: "",
    }),
  );
  expect(speaker().getAttribute("aria-label")).toBe("Speaker off. Switch to speaker");
  expect(speaker().getAttribute("aria-selected")).toBe("false");
  act(() =>
    boundary.events!.audioOutput?.({
      route: "headset",
      canToggle: false,
      pending: false,
      error: "",
    }),
  );
  expect(speaker().getAttribute("aria-label")).toBe("Headset audio connected");
  expect(speaker().disabled).toBe(true);
  act(() =>
    boundary.events!.audioOutput?.({
      route: "earpiece",
      canToggle: true,
      pending: false,
      error: "Could not change audio output. Try again.",
    }),
  );
  expect(container.textContent).toContain("Could not change audio output. Try again.");
  expect(container.querySelector('[aria-label="Mute microphone"]')).not.toBeNull();
});

test("native call strip owns the top inset once and updates after rotation, then restores it", async () => {
  boundary.native = true;
  render();
  const navigationInsets = () =>
    JSON.parse(container.querySelector('[data-testid="navigation-insets"]')!.textContent!);
  expect(navigationInsets()).toEqual({ top: 24, bottom: 16, left: 0, right: 0 });
  await click();
  const safeArea = () =>
    container.querySelector<HTMLElement>('[data-testid="conversation-call-safe-area"]')!;
  expect(safeArea()).not.toBeNull();
  expect(safeArea().style.paddingTop).toBe("24px");
  expect(navigationInsets()).toEqual({ top: 0, bottom: 16, left: 0, right: 0 });
  render("pi", { top: 0, bottom: 12, left: 30, right: 8 });
  expect(safeArea().style.paddingTop).toBe("0px");
  expect(safeArea().style.paddingLeft).toBe("30px");
  expect(safeArea().style.paddingRight).toBe("8px");
  expect(navigationInsets()).toEqual({ top: 0, bottom: 12, left: 30, right: 8 });
  await click();
  render();
  expect(safeArea()).toBeNull();
  expect(navigationInsets().top).toBe(24);
});

test("composer phone keeps the neighboring 28px circular geometry in all call states without a mute slot", async () => {
  render();
  const check = () => {
    expect(phone().style.width).toBe("28px");
    expect(phone().style.height).toBe("28px");
    expect(phone().style.minWidth).toBe("");
    expect(phone().getAttribute("data-round")).toBe("true");
    expect(phone().getAttribute("data-hit-slop")).toBe("8");
    expect(phone().parentElement!.querySelectorAll("button")).toHaveLength(1);
  };
  check();
  await click();
  check();
  act(() => boundary.events!.connected());
  check();
});

test("web retains its existing insets while the call strip is present", async () => {
  render();
  await click();
  expect(
    JSON.parse(container.querySelector('[data-testid="navigation-insets"]')!.textContent!).top,
  ).toBe(24);
  expect(container.querySelector('[data-testid="conversation-call-safe-area"]')).toBeNull();
  expect(container.querySelector('[data-testid="conversation-call-speaker"]')).toBeNull();
});

test("disconnected and voice-mode conflicts disable starting on web and native", () => {
  boundary.connected = false;
  render();
  expect(phone().disabled).toBe(true);
  boundary.connected = true;
  boundary.voice.isVoiceMode = true;
  render();
  expect(phone().disabled).toBe(true);
  boundary.voice.isVoiceMode = false;
  boundary.voice.isVoiceSwitching = true;
  render();
  expect(phone().disabled).toBe(true);
  boundary.native = true;
  render();
  expect(phone().disabled).toBe(true);
});
