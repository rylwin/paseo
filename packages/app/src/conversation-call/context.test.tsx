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
  voice: { isVoiceMode: false, isVoiceSwitching: false },
  events: null as MediaEvents | null,
  answer: vi.fn(),
  end: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
}));
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
  }: {
    label: string;
    selected?: boolean;
    disabled?: boolean;
    onPress: () => void;
    testID?: string;
  }) => (
    <button
      type="button"
      aria-label={label}
      aria-selected={selected}
      disabled={disabled}
      onClick={onPress}
      data-testid={testID}
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
  };
});
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
import { ConversationCallAction, ConversationCallProvider } from "./context";

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
function render(agentId = "pi") {
  boundary.focused = agentId;
  act(() =>
    root.render(
      <ConversationCallProvider>
        <ConversationCallAction serverId="host" agentId={agentId} />
      </ConversationCallProvider>,
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

test("autoplay recovery remains actionable on the target without a diagnostic panel", async () => {
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

test("failure keeps captured identity and recovery without transcript or raw IDs", async () => {
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
});

test("untitled calls use the normal agent fallback, never a raw ID or host name", async () => {
  boundary.title = undefined;
  render();
  await click();
  render("other");
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.textContent).toContain(i18n.t("agentList.fallbackTitle"));
  expect(container.querySelector('[aria-label="Return to call with New session"]')).not.toBeNull();
});

test("native uses the same connecting toggle and compact mute/end strip, then offers retry after ending", async () => {
  boundary.native = true;
  render();
  await click();
  expect(phone().getAttribute("aria-label")).toBe("Cancel call");
  const host = container.querySelector('[data-testid="conversation-call-host"]')!;
  expect(host.textContent).toContain("Original agent");
  expect(host.querySelector('[aria-label="Mute microphone"]')).not.toBeNull();
  await click();
  expect(boundary.stop).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Call ended");
  expect(container.textContent).toContain("Call again");
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
