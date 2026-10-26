import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Platform, Text, View, type LayoutChangeEvent } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Phone,
  PhoneOutgoing,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  Smartphone,
  Headphones,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import { BORDER_WIDTH, SPACING } from "@/styles/theme";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useVoiceOptional } from "@/contexts/voice-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  ConversationCallController,
  type CallSignaling,
  type CallTarget,
  type CallSnapshot,
} from "./controller";
import { createCallMedia, supportsCalls } from "./media";

const CallContext = createContext<ConversationCallController | null>(null);
const NATIVE_STRIP_HEIGHT = CONTROL_HEIGHTS.compact + 2 * SPACING[1] + BORDER_WIDTH[1];
const ThemedMic = withUnistyles(Mic, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));
const ThemedMicOff = withUnistyles(MicOff, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));
const ThemedPhoneOff = withUnistyles(PhoneOff, (theme) => ({
  color: theme.colors.statusDanger,
  size: theme.iconSize.md,
}));
const ThemedPhone = withUnistyles(Phone, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.md,
}));
const ThemedLivePhone = withUnistyles(Phone, (theme) => ({
  color: theme.colors.statusSuccess,
  size: theme.iconSize.md,
}));
const ThemedConnectingPhone = withUnistyles(PhoneOutgoing, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));

const ThemedSpeaker = withUnistyles(Volume2, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));
const ThemedHandset = withUnistyles(Smartphone, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));
const ThemedHeadphones = withUnistyles(Headphones, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.md,
}));

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foreground,
  size: 14,
}));

function ConnectingIndicator() {
  const reducedMotion = useReducedMotion();
  return (
    <View style={styles.connectingIcon}>
      {reducedMotion ? <ThemedConnectingPhone /> : <ThemedSpinner />}
    </View>
  );
}

const phoneIcon = <ThemedPhone />;
const livePhoneIcon = <ThemedLivePhone />;
const connectingPhoneIcon = <ConnectingIndicator />;

function signaling(client: DaemonClient): CallSignaling {
  return {
    supported: client.getLastServerInfoMessage()?.features?.conversationCalls === true,
    start: (input) => client.startConversationCall(input),
    async end(callId) {
      await client.endConversationCall(callId);
    },
    subscribe(listener) {
      return client.on("conversation.call.event", (message) =>
        listener(message.payload.callId, message.payload.event),
      );
    },
    disconnected(listener) {
      return client.subscribeConnectionStatus((state) => {
        if (state.status !== "connected") listener();
      });
    },
  };
}

function useCall() {
  const controller = useContext(CallContext);
  if (!controller) throw new Error("ConversationCallProvider is required");
  return controller;
}

export function ConversationCallProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(
    () =>
      new ConversationCallController({
        createMedia: createCallMedia,
        newId: () => crypto.randomUUID(),
      }),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const insets = useSafeAreaInsets();
  const target = snapshot.phase === "idle" ? null : snapshot.target;
  const [hostMeasurement, setHostMeasurement] = useState<{
    target: CallTarget | null;
    height: number;
  }>({ target: null, height: NATIVE_STRIP_HEIGHT });
  const hostHeight =
    hostMeasurement.target === target ? hostMeasurement.height : NATIVE_STRIP_HEIGHT;
  const measureHost = useCallback(
    (event: LayoutChangeEvent) => {
      const current = controller.getSnapshot();
      if (current.phase === "idle" || current.target !== target) return;
      setHostMeasurement({
        target,
        height: Math.max(NATIVE_STRIP_HEIGHT, event.nativeEvent.layout.height),
      });
    },
    [controller, target],
  );
  const ownsTopInset =
    !isWeb &&
    supportsCalls &&
    snapshot.phase !== "idle" &&
    !(Platform.OS === "android" && snapshot.phase === "ended");
  const contentInsets = useMemo(
    () => (ownsTopInset ? { ...insets, top: insets.top + hostHeight } : insets),
    [insets, ownsTopInset, hostHeight],
  );
  useEffect(() => () => controller.end(), [controller]);
  return (
    <CallContext.Provider value={controller}>
      {supportsCalls ? (
        <View style={styles.root}>
          {ownsTopInset ? (
            <View
              testID="conversation-call-safe-area"
              style={[
                styles.safeArea,
                { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right },
              ]}
            >
              <ConversationCallHost onLayout={measureHost} />
            </View>
          ) : (
            <ConversationCallHost />
          )}
          <SafeAreaInsetsContext.Provider value={contentInsets}>
            <View style={styles.root}>{children}</View>
          </SafeAreaInsetsContext.Provider>
        </View>
      ) : (
        children
      )}
    </CallContext.Provider>
  );
}

function CallMuteAction() {
  const controller = useCall();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const mute = useCallback(() => controller.toggleMute(), [controller]);
  if (snapshot.phase !== "connecting" && snapshot.phase !== "connected") return null;
  return (
    <ToolbarButton
      label={snapshot.muted ? "Unmute microphone" : "Mute microphone"}
      selected={snapshot.muted}
      aria-pressed={snapshot.muted}
      onPress={mute}
      compact={!isWeb}
      round={!isWeb}
      hitSlop={8}
      style={isWeb ? styles.touchTarget : undefined}
    >
      {snapshot.muted ? <ThemedMicOff /> : <ThemedMic />}
    </ToolbarButton>
  );
}

function CallSpeakerAction() {
  const controller = useCall();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const toggle = useCallback(() => {
    void controller.toggleSpeaker();
  }, [controller]);
  // Native calls currently ship on Android only. Web owns its browser-selected output.
  if (isWeb || snapshot.phase === "idle") return null;
  const output = snapshot.audioOutput;
  const speaker = output?.route === "speaker";
  const headset = output?.route === "headset";
  let label = "Audio output unavailable";
  let icon = <ThemedHandset />;
  if (output?.route === "earpiece") label = "Speaker off. Switch to speaker";
  if (speaker) {
    label = "Speaker on. Switch to earpiece";
    icon = <ThemedSpeaker />;
  }
  if (headset) {
    label = "Headset audio connected";
    icon = <ThemedHeadphones />;
  }
  return (
    <ToolbarButton
      label={label}
      testID="conversation-call-speaker"
      onPress={toggle}
      selected={speaker}
      aria-pressed={speaker}
      disabled={!output?.canToggle || output.pending}
      compact
      round
      hitSlop={8}
    >
      {icon}
    </ToolbarButton>
  );
}

/** Only the normal active-agent composer supplies this slot; drafts keep their controls. */
export function ConversationCallAction({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const controller = useCall();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const title = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId)?.title);
  const { t } = useTranslation();
  const voice = useVoiceOptional();
  const busy = snapshot.phase === "connecting" || snapshot.phase === "connected";
  const isTarget =
    busy && snapshot.target.serverId === serverId && snapshot.target.agentId === agentId;
  const disabled =
    !connected ||
    (busy && !isTarget) ||
    voice?.isVoiceMode === true ||
    voice?.isVoiceSwitching === true;
  const toggle = useCallback(() => {
    if (isTarget) {
      controller.end();
      return;
    }
    if (!client) return;
    const target: CallTarget = { serverId, agentId, label: title || t("agentList.fallbackTitle") };
    void controller.start(target, signaling(client));
  }, [agentId, client, controller, isTarget, serverId, title, t]);
  if (!supportsCalls || provider !== "pi") return null;
  let label = "Call this Pi agent with GPT-Live";
  let icon = phoneIcon;
  if (isTarget) {
    label = snapshot.phase === "connecting" ? "Cancel call" : "End call";
    icon = snapshot.phase === "connecting" ? connectingPhoneIcon : livePhoneIcon;
  }
  return (
    <View style={styles.controls}>
      <ToolbarButton
        label={label}
        tooltip={
          isTarget && snapshot.phase === "connecting" ? "Connecting... Cancel call" : undefined
        }
        selected={isTarget}
        aria-pressed={isTarget}
        testID="conversation-call-start"
        onPress={toggle}
        disabled={disabled}
        round
        hitSlop={8}
        style={styles.composerAction}
      >
        {icon}
      </ToolbarButton>
    </View>
  );
}

function CallIdentity({ snapshot }: { snapshot: CallSnapshot }) {
  const target = snapshot.phase === "idle" ? null : snapshot.target;
  const [acknowledgedTarget, setAcknowledgedTarget] = useState<CallTarget | null>(null);
  useEffect(() => {
    if (snapshot.phase !== "connected") return;
    // This timer only retires the acknowledgement; media events determine readiness.
    const timeout = setTimeout(() => setAcknowledgedTarget(target), 1800);
    return () => clearTimeout(timeout);
  }, [snapshot.phase, target]);
  let statusLabel = snapshot.phase === "idle" ? "" : snapshot.target.label;
  if (snapshot.phase === "connecting") statusLabel = "Connecting...";
  if (snapshot.phase === "connected" && acknowledgedTarget !== target) statusLabel = "Ready";
  return (
    <Text
      numberOfLines={1}
      style={styles.identityText}
      accessibilityLiveRegion="polite"
      testID="conversation-call-status"
    >
      {statusLabel}
    </Text>
  );
}

function ConversationCallHost({ onLayout }: { onLayout?: (event: LayoutChangeEvent) => void }) {
  const controller = useCall();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const end = useCallback(() => controller.end(), [controller]);
  const dismiss = useCallback(() => controller.dismiss(), [controller]);
  const play = useCallback(() => {
    void controller.play();
  }, [controller]);
  const retry = useCallback(() => {
    const state = controller.getSnapshot();
    if (state.phase === "idle") return;
    const client = getHostRuntimeStore().getClient(state.target.serverId);
    if (client) void controller.start(state.target, signaling(client));
  }, [controller]);
  const returnToCall = useCallback(() => {
    const state = controller.getSnapshot();
    if (state.phase !== "idle")
      navigateToAgent({ serverId: state.target.serverId, agentId: state.target.agentId });
  }, [controller]);
  const identity = useMemo(() => <CallIdentity snapshot={snapshot} />, [snapshot]);
  if (
    !supportsCalls ||
    snapshot.phase === "idle" ||
    ((isWeb || Platform.OS === "android") && snapshot.phase === "ended")
  )
    return null;
  const active = snapshot.phase === "connecting" || snapshot.phase === "connected";
  return (
    <View style={styles.host} testID="conversation-call-host" onLayout={onLayout}>
      <View style={styles.panel}>
        {active ? (
          <View style={styles.row}>
            <Button
              accessibilityLabel={`Return to call with ${snapshot.target.label}`}
              onPress={returnToCall}
              variant="ghost"
              size={isWeb ? "md" : "sm"}
              style={styles.identity}
              leftIcon={snapshot.phase === "connecting" ? connectingPhoneIcon : livePhoneIcon}
              trailing={identity}
            />
            <CallSpeakerAction />
            <CallMuteAction />
            <ToolbarButton
              label="End call"
              onPress={end}
              compact={!isWeb}
              round={!isWeb}
              hitSlop={8}
              style={isWeb ? styles.touchTarget : undefined}
            >
              <ThemedPhoneOff />
            </ToolbarButton>
          </View>
        ) : null}
        {!isWeb && active && snapshot.audioOutput?.error ? (
          <Text accessibilityRole="alert" style={styles.outputError}>
            {snapshot.audioOutput.error}
          </Text>
        ) : null}
        {snapshot.phase === "ended" ? (
          <Alert title="Call ended" description="Pi work continues independently.">
            <View style={styles.controls}>
              <Button onPress={retry} variant="outline">
                Call again
              </Button>
              <Button onPress={dismiss} variant="ghost">
                Dismiss call
              </Button>
            </View>
          </Alert>
        ) : null}
        {snapshot.error ? (
          <Alert
            variant="error"
            title={`Call failed with ${snapshot.target.label}`}
            description={snapshot.error}
          >
            <View style={styles.controls}>
              <Button onPress={retry} variant="outline">
                Call again
              </Button>
              <Button onPress={dismiss} variant="ghost">
                Dismiss call
              </Button>
            </View>
          </Alert>
        ) : null}
        {snapshot.playbackBlocked ? <Button onPress={play}>Play call audio</Button> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  // Native-stack screen sizes update after native layout. Keep its viewport unchanged when
  // the strip appears; the descendant top inset reserves the strip instead of a flex sibling.
  safeArea: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    backgroundColor: theme.colors.surface3,
  },
  host: {
    backgroundColor: theme.colors.surface3,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  panel: { width: "100%", maxWidth: 720, alignSelf: "center", gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  identity: { flex: 1, minWidth: 0, justifyContent: "flex-start" },
  identityText: { flexShrink: 1, fontSize: theme.fontSize.base, color: theme.colors.foreground },
  outputError: { fontSize: theme.fontSize.sm, color: theme.colors.statusDanger },
  // Match the neighboring voice/composer controls; hitSlop grows touch area without spacing.
  connectingIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  composerAction: { width: CONTROL_HEIGHTS.tight, height: CONTROL_HEIGHTS.tight },
  touchTarget: { minWidth: theme.spacing[12], minHeight: theme.spacing[12] },
}));
