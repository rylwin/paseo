import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { BrowserLiveCall, initialLiveCall } from "./browser-live-call.web";

const variants: Record<string, StatusBadgeVariant> = {
  idle: "muted",
  connecting: "muted",
  connected: "success",
  ended: "muted",
  failed: "error",
};
const labels = {
  idle: "Ready to call",
  connecting: "Connecting...",
  connected: "Connected",
  ended: "Call ended",
  failed: "Call failed",
};

export function LiveCallPanel() {
  const [state, setState] = useState(initialLiveCall);
  const [token, setToken] = useState("");
  const [expanded, setExpanded] = useState(true);
  const audio = useRef<HTMLAudioElement>(null);
  const call = useRef<BrowserLiveCall | null>(null);
  const active = state.status === "connecting" || state.status === "connected";
  let microphoneLabel = "Microphone off";
  if (active) microphoneLabel = state.muted ? "Microphone muted" : "Microphone on";
  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const supplied = fragment.get("callToken");
    if (supplied) {
      setToken(supplied);
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (!audio.current) return;
    const owner = new BrowserLiveCall(audio.current, setState);
    call.current = owner;
    const end = () => owner.end();
    window.addEventListener("pagehide", end);
    return () => {
      window.removeEventListener("pagehide", end);
      owner.end();
      call.current = null;
    };
  }, []);
  const start = useCallback(() => {
    void call.current?.start(token.trim());
  }, [token]);
  const end = useCallback(() => call.current?.end(), []);
  const mute = useCallback(() => call.current?.toggleMute(), []);
  const play = useCallback(() => {
    void call.current?.playAudio();
  }, []);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={styles.panel} testID="live-call-panel">
      <audio ref={audio} autoPlay playsInline />
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          GPT-Live call
        </Text>
        <Button variant="ghost" style={styles.touch} onPress={toggleExpanded}>
          {expanded ? "Minimize call" : "Expand call"}
        </Button>
      </View>
      <Text style={styles.metadata}>{state.identity}</Text>
      <View accessibilityLiveRegion="polite">
        <StatusBadge label={labels[state.status]} variant={variants[state.status]} />
      </View>
      {expanded ? (
        <>
          <Text style={styles.body}>
            {
              'Talk to Pi about this Paseo worktree. Try: "Ask Pi for its working directory and explain scripts/call-preview.mjs without changing files."'
            }
          </Text>
          <Text style={styles.metadata}>
            Your requests go to the Pi session above, with ordinary coding permissions. It can edit
            files when you ask. Other sessions are not accessible.
          </Text>
          {!active ? (
            <EditingTextInput
              accessibilityLabel="Trial access token"
              placeholder={token ? "Trial token loaded" : "Paste the scoped trial token"}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setToken}
              style={styles.input}
            />
          ) : null}
          <Text style={styles.body} accessibilityLiveRegion="polite">
            {state.pi}
          </Text>
          {state.transcript ? <Text style={styles.metadata}>{state.transcript}</Text> : null}
        </>
      ) : null}
      {state.error ? <Alert variant="error" title="Call failed" description={state.error} /> : null}
      {state.playbackBlocked ? (
        <Alert
          variant="warning"
          title="Audio playback paused"
          description="Your browser requires a tap to play the remote voice."
        >
          <Button variant="outline" style={styles.touch} onPress={play}>
            Play call audio
          </Button>
        </Alert>
      ) : null}
      <View style={styles.controls}>
        {active ? (
          <>
            <Button
              variant="outline"
              style={styles.touch}
              disabled={state.status !== "connected"}
              onPress={mute}
            >
              {state.muted ? "Unmute microphone" : "Mute microphone"}
            </Button>
            <Button variant="outline" style={styles.touch} onPress={end}>
              End call
            </Button>
          </>
        ) : (
          <Button variant="default" style={styles.touch} disabled={!token.trim()} onPress={start}>
            Start call
          </Button>
        )}
      </View>
      <Text style={styles.metadata}>
        {microphoneLabel} / ending the call does not delete the test Pi session
      </Text>
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
    gap: theme.spacing[3],
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
  },
  input: {
    minHeight: 48,
    paddingHorizontal: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    fontSize: theme.fontSize.content,
  },
  controls: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
  touch: { minHeight: 48, minWidth: 48 },
}));
