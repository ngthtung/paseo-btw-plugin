import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { startSideQuestion } from "./server/codex.ts";
import {
  cancelQuestion,
  listQuestions,
  startQuestion,
  type Question,
} from "./shared/btw.ts";

type StoredQuestion = {
  agentId: string;
  view: Question;
  cancel: () => void;
};

export default function contribute(server: PluginServerContext) {
  const questions = new Map<string, StoredQuestion>();
  let disposed = false;

  server.handle(startQuestion, async ({ agentId, question }, { paseo }) => {
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    if (disposed) throw new Error("Plugin unavailable");
    const snapshot = agent.current();
    if (!snapshot) throw new Error(`Agent not found: ${agentId}`);
    const runtime = agent.runtimeInfo;
    if (runtime?.provider !== "codex")
      throw new Error("Codex session unavailable");
    const threadId = runtime.sessionId;
    const cwd = agent.cwd;
    if (!threadId || !cwd) throw new Error("Codex session unavailable");
    const model = runtime.model ?? snapshot.model;
    const reasoningEffort =
      runtime.thinkingOptionId ??
      snapshot.effectiveThinkingOptionId ??
      snapshot.thinkingOptionId;

    const id = randomUUID();
    const run = startSideQuestion({
      threadId,
      cwd,
      question,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    const stored: StoredQuestion = {
      agentId,
      view: { id, question, status: "running" },
      cancel: run.cancel,
    };
    questions.set(id, stored);
    void run.result.then(
      ({ answer }) => {
        if (stored.view.status === "running") {
          stored.view = { id, question, status: "complete", answer };
        }
      },
      (error: unknown) => {
        if (stored.view.status === "running") {
          stored.view = {
            id,
            question,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    return { id };
  });

  server.handle(listQuestions, async ({ agentId }) => ({
    questions: [...questions.values()]
      .filter((entry) => entry.agentId === agentId)
      .map((entry) => entry.view),
  }));

  server.handle(cancelQuestion, async ({ agentId, id }) => {
    const entry = questions.get(id);
    if (entry?.agentId === agentId && entry.view.status === "running") {
      entry.view = { id, question: entry.view.question, status: "cancelled" };
      entry.cancel();
    }
    return {};
  });

  return () => {
    disposed = true;
    for (const entry of questions.values()) entry.cancel();
    questions.clear();
  };
}
