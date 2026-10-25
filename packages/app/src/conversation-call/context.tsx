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
import { AppState, Text, View } from "react-native";
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
import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useVoiceOptional } from "@/contexts/voice-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ConversationCallController, type CallSignaling, type CallTarget } from "./controller";
import { createCallMedia, supportsCalls } from "./media";
import { bindForegroundCall } from "./foreground";

const CallContext = createContext<ConversationCallController | null>(null);
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

const phoneIcon = <ThemedPhone />;
const livePhoneIcon = <ThemedLivePhone />;
const connectingPhoneIcon = <ThemedConnectingPhone />;

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
  const ownsTopInset = !isWeb && supportsCalls && snapshot.phase !== "idle";
  const contentInsets = useMemo(
    () => (ownsTopInset ? { ...insets, top: 0 } : insets),
    [insets, ownsTopInset],
  );
  useEffect(() => () => controller.end(), [controller]);
  useEffect(() => {
    if (isWeb || !supportsCalls) return;
    return bindForegroundCall({
      subscribe(listener) {
        const subscription = AppState.addEventListener("change", listener);
        return () => subscription.remove();
      },
      getPhase: () => controller.getSnapshot().phase,
      end: () => controller.end(),
    });
  }, [controller]);
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
              <ConversationCallHost />
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

function ConversationCallHost() {
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
  const targetLabel = snapshot.phase === "idle" ? "" : snapshot.target.label;
  const identity = useMemo(
    () => (
      <Text numberOfLines={1} style={styles.identityText}>
        {targetLabel}
      </Text>
    ),
    [targetLabel],
  );
  if (!supportsCalls || snapshot.phase === "idle" || (isWeb && snapshot.phase === "ended"))
    return null;
  const active = snapshot.phase === "connecting" || snapshot.phase === "connected";
  return (
    <View style={styles.host} testID="conversation-call-host">
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
          <Alert
            title="Call ended"
            description="Calls end when Paseo leaves the foreground. Pi work continues independently."
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
  safeArea: { backgroundColor: theme.colors.surface3 },
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
  composerAction: { width: CONTROL_HEIGHTS.tight, height: CONTROL_HEIGHTS.tight },
  touchTarget: { minWidth: theme.spacing[12], minHeight: theme.spacing[12] },
}));
