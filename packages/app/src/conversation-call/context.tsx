import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Phone, Mic, MicOff, Minus, Maximize2, PhoneOff } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { Alert } from "@/components/ui/alert";
import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useVoiceOptional } from "@/contexts/voice-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ConversationCallController, type CallSignaling, type CallTarget } from "./controller";
import { createCallMedia } from "./media";

const CallContext = createContext<ConversationCallController | null>(null);
const ThemedMic = withUnistyles(Mic, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const ThemedMicOff = withUnistyles(MicOff, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const ThemedPhoneOff = withUnistyles(PhoneOff, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const ThemedMinimize = withUnistyles(Minus, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const ThemedExpand = withUnistyles(Maximize2, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
const microphoneIcon = <ThemedMic />;
const mutedIcon = <ThemedMicOff />;
const hangupIcon = <ThemedPhoneOff />;
const ThemedPhone = withUnistyles(Phone, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.md,
}));

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
  useEffect(() => () => controller.end(), [controller]);
  return (
    <CallContext.Provider value={controller}>
      {isWeb ? (
        <View style={styles.root}>
          <ConversationCallHost />
          <View style={styles.root}>{children}</View>
        </View>
      ) : (
        children
      )}
    </CallContext.Provider>
  );
}

/** Only the normal active-agent composer supplies this slot; drafts and native keep their controls. */
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
  const voice = useVoiceOptional();
  const busy = snapshot.phase === "connecting" || snapshot.phase === "connected";
  const disabled =
    !connected || busy || voice?.isVoiceMode === true || voice?.isVoiceSwitching === true;
  const start = useCallback(() => {
    if (!client) return;
    const host = client.getLastServerInfoMessage()?.hostname ?? serverId;
    const target: CallTarget = { serverId, agentId, label: `${host} / ${title ?? agentId}` };
    void controller.start(target, signaling(client));
  }, [agentId, client, controller, serverId, title]);
  if (!isWeb || provider !== "pi") return null;
  return (
    <ToolbarButton
      label="Call this Pi agent with GPT-Live"
      testID="conversation-call-start"
      onPress={start}
      disabled={disabled}
    >
      <ThemedPhone />
    </ToolbarButton>
  );
}

function ConversationCallHost() {
  const controller = useCall();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const minimize = useCallback(() => controller.toggleMinimized(), [controller]);
  const mute = useCallback(() => controller.toggleMute(), [controller]);
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
  if (!isWeb || snapshot.phase === "idle") return null;
  const active = snapshot.phase === "connecting" || snapshot.phase === "connected";
  const phaseLabels = {
    connecting: "Connecting...",
    connected: "Connected",
    ended: "Call ended",
    failed: "Call failed",
  };
  return (
    <View style={styles.host} testID="conversation-call-host">
      <View style={styles.panel}>
        <View style={styles.row}>
          <View style={styles.identity}>
            <Text style={styles.heading}>GPT-Live call</Text>
            <Text style={styles.target} numberOfLines={2} selectable>
              {snapshot.target.label}
            </Text>
          </View>
          <StatusBadge
            label={phaseLabels[snapshot.phase]}
            variant={snapshot.phase === "connected" ? "success" : "muted"}
          />
          <ToolbarButton
            label={snapshot.minimized ? "Expand call" : "Minimize call"}
            onPress={minimize}
          >
            {snapshot.minimized ? <ThemedExpand /> : <ThemedMinimize />}
          </ToolbarButton>
        </View>
        {!snapshot.minimized && (
          <ScrollView style={styles.details}>
            <Text style={styles.meta} selectable>
              {snapshot.target.agentId}
            </Text>
            <Text style={styles.copy}>
              Voice interruptions do not stop Pi. Only a new delegated coding instruction can steer
              it. Pi keeps working when you end the call.
            </Text>
            {snapshot.delegation ? (
              <Text style={styles.copy} selectable testID="conversation-call-delegation">
                {snapshot.delegation}
              </Text>
            ) : null}
            {snapshot.transcript ? (
              <Text style={styles.copy} selectable testID="conversation-call-transcript">
                {snapshot.transcript}
              </Text>
            ) : null}
          </ScrollView>
        )}
        {snapshot.error ? (
          <Alert variant="error" title="Call failed" description={snapshot.error} />
        ) : null}
        <View style={styles.row}>
          {active ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onPress={mute}
                leftIcon={snapshot.muted ? mutedIcon : microphoneIcon}
              >
                {snapshot.muted ? "Unmute microphone" : "Mute microphone"}
              </Button>
              <Button size="sm" variant="outline" onPress={end} leftIcon={hangupIcon}>
                End call
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onPress={retry}>
                Call again
              </Button>
              <Button size="sm" variant="outline" onPress={dismiss}>
                Dismiss call
              </Button>
            </>
          )}
          {snapshot.playbackBlocked ? (
            <Button size="sm" variant="outline" onPress={play}>
              Play call audio
            </Button>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  host: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  panel: { width: "100%", maxWidth: 720, alignSelf: "center", gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  identity: { flex: 1, minWidth: 120 },
  heading: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  target: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  meta: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  copy: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
  },
  details: { maxHeight: 160 },
}));
