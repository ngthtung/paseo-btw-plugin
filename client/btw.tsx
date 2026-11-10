import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputKeyPressEventData,
  View,
} from "react-native";
import {
  cancelQuestion,
  listQuestions,
  startQuestion,
  type Question,
} from "../shared/btw";

export function BtwPanel({
  theme,
  layout,
  params,
  revision,
}: PluginAgentPanelProps) {
  const list = useRpc(listQuestions);
  const cancel = useRpc(cancelQuestion);
  const start = useRpc(startQuestion);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCancelling, setIsCancelling] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: theme.colors.surface0 },
        history: { flex: 1 },
        content: { padding: layout.compact ? 16 : 24, gap: 16 },
        footer: {
          padding: layout.compact ? 16 : 24,
          gap: 12,
          borderTopWidth: 1,
          borderColor: theme.colors.border,
        },
        input: {
          padding: 12,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        sendButton: {
          alignSelf: "flex-end",
          padding: 12,
          backgroundColor: theme.colors.accent,
        },
        sendText: { color: theme.colors.accentForeground },
        question: {
          padding: 16,
          gap: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
        text: { color: theme.colors.foreground },
        error: { color: theme.colors.statusDanger },
        running: { flexDirection: "row", alignItems: "center", gap: 12 },
        button: { padding: 8, backgroundColor: theme.colors.surface2 },
      }),
    [theme, layout.compact],
  );

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    async function update() {
      try {
        const result = await list({ agentId: params.agentId });
        if (disposed) return;
        setQuestions(result.questions);
        setError(null);
        setLoading(false);
        if (
          result.questions.some((question) => question.status === "running")
        ) {
          timer = setTimeout(update, 1000);
        }
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
        timer = setTimeout(update, 1000);
      }
    }
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [list, params.agentId, revision, refresh]);

  async function cancelRunningQuestion(id: string) {
    setIsCancelling(true);
    try {
      await cancel({ agentId: params.agentId, id });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsCancelling(false);
    }
  }

  async function submitQuestion() {
    if (isSubmitting || !draft.trim()) return;
    setIsSubmitting(true);
    try {
      await start({ agentId: params.agentId, question: draft });
      setDraft("");
      setError(null);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyPress(
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) {
    const nativeEvent = event.nativeEvent;
    if (
      nativeEvent.key !== "Enter" ||
      ("shiftKey" in nativeEvent && nativeEvent.shiftKey === true) ||
      ("isComposing" in nativeEvent && nativeEvent.isComposing === true) ||
      ("keyCode" in nativeEvent && nativeEvent.keyCode === 229)
    ) {
      return;
    }
    event.preventDefault();
    void submitQuestion();
  }

  return (
    <View style={styles.root}>
      <ScrollView style={styles.history} contentContainerStyle={styles.content}>
        {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {error ? (
          <Text selectable style={styles.error}>
            {error}
          </Text>
        ) : null}
        {questions.map((question) => (
          <View key={question.id} style={styles.question}>
            <Text selectable style={styles.text}>
              {question.question}
            </Text>
            {question.status === "running" ? (
              <View style={styles.running}>
                <ActivityIndicator color={theme.colors.accent} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  disabled={isCancelling}
                  style={styles.button}
                  onPress={() => void cancelRunningQuestion(question.id)}
                >
                  <Text style={styles.text}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
            {question.status === "complete" ? (
              <Text selectable style={styles.text}>
                {question.answer}
              </Text>
            ) : null}
            {question.status === "error" ? (
              <Text selectable style={styles.error}>
                {question.error}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onKeyPress={handleKeyPress}
          placeholder="Message..."
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Message agent..."
          editable={!isSubmitting}
          multiline
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={isSubmitting || !draft.trim()}
          style={styles.sendButton}
          onPress={() => void submitQuestion()}
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
