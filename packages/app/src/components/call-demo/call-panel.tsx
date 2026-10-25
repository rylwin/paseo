import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, Mic, MicOff, PhoneOff, AudioLines } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Alert } from "@/components/ui/alert";
import { presentCallDemo, type CallDemoAction, type CallDemoState } from "./call-demo-state";

const ThemedMic = withUnistyles(Mic);
const ThemedMicOff = withUnistyles(MicOff);
const ThemedPhoneOff = withUnistyles(PhoneOff);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedAudioLines = withUnistyles(AudioLines);

interface CallPanelProps {
  agentName: string;
  state: CallDemoState;
  dispatch: (action: CallDemoAction) => void;
}

const statusVariant: Record<CallDemoState["connection"], StatusBadgeVariant> = {
  connecting: "muted",
  connected: "success",
  reconnecting: "warning",
  failed: "error",
  ended: "muted",
};

/** UI-only prototype. This component deliberately has no voice or agent client. */
export function CallPanel({ agentName, state, dispatch }: CallPanelProps) {
  const presentation = presentCallDemo(state);
  const terminal = presentation.canRetry;
  const toggleExpanded = useCallback(() => dispatch({ type: "toggleExpanded" }), [dispatch]);
  const toggleMute = useCallback(() => dispatch({ type: "toggleMute" }), [dispatch]);
  const hangUp = useCallback(() => dispatch({ type: "hangUp" }), [dispatch]);
  const retry = useCallback(() => dispatch({ type: "retry" }), [dispatch]);
  const controls = (
    <View style={styles.controls}>
      <ToolbarButton
        label={state.muted ? "Unmute microphone (simulated)" : "Mute microphone (simulated)"}
        selected={state.muted}
        disabled={terminal}
        style={styles.touchTarget}
        onPress={toggleMute}
      >
        {state.muted ? <ThemedMicOff style={styles.icon} /> : <ThemedMic style={styles.icon} />}
      </ToolbarButton>
      <ToolbarButton
        label="Hang up call"
        tooltip="End the simulated call, not the Pi agent"
        disabled={terminal}
        style={styles.touchTarget}
        onPress={hangUp}
      >
        <ThemedPhoneOff style={styles.icon} />
      </ToolbarButton>
    </View>
  );
  const recovery = terminal ? (
    <Button variant="outline" style={styles.touchTarget} onPress={retry}>
      {state.connection === "failed" ? "Try again" : "Call again"}
    </Button>
  ) : null;

  if (!state.expanded) {
    return (
      <View style={styles.panel} testID="call-minimized">
        <View style={styles.header}>
          <View style={styles.identity} accessibilityLiveRegion="polite">
            <Text style={styles.name} numberOfLines={1}>
              {agentName}
            </Text>
            <Text style={styles.metadata}>
              {presentation.label} / {state.muted ? "muted" : "simulated"}
            </Text>
          </View>
          {controls}
          <ToolbarButton label="Expand call" style={styles.touchTarget} onPress={toggleExpanded}>
            <ThemedChevronUp style={styles.icon} />
          </ToolbarButton>
        </View>
        {recovery}
        {state.connection === "failed" ? (
          <Text style={styles.error} accessibilityRole="alert">
            Simulated connection lost. Try again to reconnect.
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.panel} testID="call-expanded">
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text style={styles.name} numberOfLines={1}>
            {agentName}
          </Text>
          <Text style={styles.metadata}>Pi agent / simulated call</Text>
        </View>
        <ToolbarButton label="Minimize call" style={styles.touchTarget} onPress={toggleExpanded}>
          <ThemedChevronDown style={styles.icon} />
        </ToolbarButton>
      </View>
      <View style={styles.statusRow} accessibilityLiveRegion="polite">
        <StatusBadge label={presentation.label} variant={statusVariant[state.connection]} />
      </View>
      <View style={styles.body}>
        <View style={styles.activity}>
          <ThemedAudioLines style={presentation.audioActive ? styles.activeIcon : styles.icon} />
          <Text style={styles.activityLabel}>
            {state.connection === "connected" && state.muted
              ? "Microphone muted (simulated)"
              : presentation.detail}
          </Text>
        </View>
        <Text style={styles.metadata}>
          {state.piWorking ? "Pi is working" : "Pi is idle"} (simulated) / separate from voice
          activity
        </Text>
        {state.connection === "failed" ? (
          <Alert
            variant="error"
            title="Simulated connection lost"
            description="No audio is being sent. Try again, then choose Connected in Scenarios."
          />
        ) : null}
      </View>
      <View style={styles.footer}>
        {controls}
        {recovery}
        <Text style={styles.hint}>Hang up ends only the call</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  identity: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  body: { gap: theme.spacing[3], paddingVertical: theme.spacing[3] },
  activity: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3], minHeight: 48 },
  activityLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  icon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  activeIcon: {
    color: theme.colors.statusSuccess,
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  footer: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  controls: { flexDirection: "row", gap: theme.spacing[2], alignItems: "center", flexWrap: "wrap" },
  touchTarget: { minWidth: 48, minHeight: 48 },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
