import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { CallPanel } from "./call-panel";
import { LiveCallPanel } from "./live-call-panel";
import {
  initialCallDemoState,
  reduceCallDemo,
  type CallDemoAction,
  type DemoConnection,
} from "./call-demo-state";

const FLEX = { flex: 1 };

const scenarios: { connection: DemoConnection; label: string }[] = [
  { connection: "connecting", label: "Connecting" },
  { connection: "connected", label: "Connected" },
  { connection: "reconnecting", label: "Reconnecting" },
  { connection: "failed", label: "Failed" },
  { connection: "ended", label: "Ended" },
];

/** Both variants remain behind the development-only open-project gate. */
export function CallDemoScreen() {
  if (process.env.EXPO_PUBLIC_CALL_LIVE === "1") {
    return (
      <View style={styles.root}>
        <SafeAreaView style={FLEX}>
          <ScrollView contentContainerStyle={styles.frame} keyboardShouldPersistTaps="handled">
            <LiveCallPanel />
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }
  return <SimulatedCallDemoScreen />;
}

/** No network, microphone, or real agent actions in the scenario variant. */
function SimulatedCallDemoScreen() {
  const [state, dispatch] = useReducer(reduceCallDemo, initialCallDemoState);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([]);
  const input = useRef<EditingTextInputHandle>(null);
  const nextMessageId = useRef(0);
  const scenarioAccessibilityState = useMemo(() => ({ expanded: scenariosOpen }), [scenariosOpen]);
  const toggleScenarios = useCallback(() => setScenariosOpen((open) => !open), []);
  const sendDemoMessage = useCallback(() => {
    if (!draft.trim()) return;
    const message = { id: nextMessageId.current++, text: draft.trim() };
    setMessages((previous) => [...previous, message]);
    setDraft("");
    input.current?.reset();
  }, [draft]);

  return (
    <View style={styles.root}>
      <SafeAreaView style={FLEX}>
        <KeyboardAvoidingView style={FLEX} behavior="padding">
          <View style={styles.frame}>
            <View style={styles.header}>
              <View style={styles.heading}>
                <Text style={styles.title} accessibilityRole="header">
                  Call UI demo
                </Text>
                <Text style={styles.muted}>
                  Simulation only / no microphone or agent connection
                </Text>
              </View>
              <Button
                variant="ghost"
                style={styles.touchTarget}
                accessibilityLabel="Toggle simulation scenarios"
                accessibilityState={scenarioAccessibilityState}
                onPress={toggleScenarios}
              >
                Scenarios
              </Button>
            </View>
            {scenariosOpen ? (
              <View style={styles.scenarios}>
                <Text style={styles.muted}>
                  Choose a simulated connection state. Nothing changes automatically.
                </Text>
                <View style={styles.scenarioButtons}>
                  {scenarios.map(({ connection, label }) => (
                    <ScenarioButton
                      key={connection}
                      connection={connection}
                      label={label}
                      selected={state.connection === connection}
                      dispatch={dispatch}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            <CallPanel agentName="Workspace assistant" state={state} dispatch={dispatch} />
            <ScrollView style={styles.chat} keyboardShouldPersistTaps="handled" testID="demo-chat">
              <View style={styles.chatContent}>
                <Text style={styles.title} accessibilityRole="header">
                  Chat / local demo
                </Text>
                <Text style={styles.muted}>Pi is working (simulated)</Text>
                <Text style={styles.message}>
                  The call and Pi work have separate lifetimes. Minimize the call to keep chatting;
                  hang up without stopping Pi.
                </Text>
                {messages.map((message) => (
                  <DemoMessage key={message.id} text={message.text} />
                ))}
              </View>
            </ScrollView>
            <View style={styles.composer}>
              <EditingTextInput
                ref={input}
                style={styles.input}
                accessibilityLabel="Local demo chat message"
                placeholder="Write a local demo message"
                onChangeText={setDraft}
                onSubmitEditing={sendDemoMessage}
                returnKeyType="send"
              />
              <Button
                style={styles.touchTarget}
                variant="secondary"
                disabled={!draft.trim()}
                onPress={sendDemoMessage}
              >
                Send
              </Button>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function DemoMessage({ text }: { text: string }) {
  return (
    <View style={styles.sentMessage}>
      <Text style={styles.muted}>You / local only</Text>
      <Text style={styles.message}>{text}</Text>
    </View>
  );
}

function ScenarioButton({
  connection,
  label,
  selected,
  dispatch,
}: {
  connection: DemoConnection;
  label: string;
  selected: boolean;
  dispatch: (action: CallDemoAction) => void;
}) {
  const select = useCallback(
    () => dispatch({ type: "simulate", connection }),
    [dispatch, connection],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      style={styles.touchTarget}
      accessibilityLabel={`Simulate ${label.toLowerCase()}`}
      accessibilityState={accessibilityState}
      onPress={select}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  frame: {
    flex: 1,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  heading: { flex: 1, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  scenarios: { gap: theme.spacing[2] },
  scenarioButtons: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  touchTarget: { minHeight: 48, minWidth: 48 },
  chat: { flex: 1 },
  chatContent: { gap: theme.spacing[3], paddingVertical: theme.spacing[4] },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
  },
  sentMessage: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  composer: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.content,
  },
}));
