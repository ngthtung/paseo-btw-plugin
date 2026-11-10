import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type SideQuestionOptions = {
  threadId: string;
  cwd: string;
  question: string;
  model?: string;
  reasoningEffort?: string;
  codexPath?: string;
};

type SideQuestionResult = { answer: string; threadId: string };

type CodexEvent =
  | { kind: "thread"; threadId: string }
  | { kind: "answer"; text: string }
  | { kind: "completed" }
  | { kind: "failed"; message: string }
  | { kind: "ignored" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(line: string): CodexEvent {
  const event: unknown = JSON.parse(line);
  if (!isObject(event)) throw new Error("Invalid Codex event");

  switch (event.type) {
    case "thread.started":
      if (typeof event.thread_id !== "string" || !event.thread_id) {
        throw new Error("Codex did not identify the side conversation");
      }
      return { kind: "thread", threadId: event.thread_id };
    case "item.completed":
      if (!isObject(event.item) || event.item.type !== "agent_message") {
        return { kind: "ignored" };
      }
      if (typeof event.item.text !== "string") {
        throw new Error("Invalid Codex answer");
      }
      return { kind: "answer", text: event.item.text };
    case "turn.completed":
      return { kind: "completed" };
    case "turn.failed":
      return {
        kind: "failed",
        message:
          isObject(event.error) && typeof event.error.message === "string"
            ? event.error.message
            : "Codex could not answer the side question",
      };
    case "error":
      return {
        kind: "failed",
        message:
          typeof event.message === "string"
            ? event.message
            : "Codex reported an error",
      };
    default:
      return { kind: "ignored" };
  }
}

export function startSideQuestion(options: SideQuestionOptions): {
  result: Promise<SideQuestionResult>;
  cancel: () => void;
} {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "fork",
    options.threadId,
    "--json",
    "--ephemeral",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.reasoningEffort) {
    args.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
    );
  }
  args.push("-");

  const child = spawn(options.codexPath ?? "codex", args, {
    cwd: options.cwd,
    shell: false,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let settled = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};

  const result = new Promise<SideQuestionResult>((resolve, reject) => {
    let threadId: string | undefined;
    let answer: string | undefined;
    let completed = false;
    let stderr = "";

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (!closed) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 1000);
        killTimer.unref();
      }
      reject(error);
    };
    cancel = () => fail(new Error("Side question cancelled"));

    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    lines.on("error", fail);
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      try {
        const event = parseEvent(line);
        switch (event.kind) {
          case "thread":
            threadId = event.threadId;
            break;
          case "answer":
            answer = event.text;
            break;
          case "completed":
            completed = true;
            break;
          case "failed":
            fail(new Error(event.message));
            break;
          case "ignored":
            break;
        }
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error("Invalid Codex output"),
        );
      }
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(killTimer);
      lines.close();
      if (settled) return;
      if (code !== 0) {
        fail(new Error(stderr.trim() || `Codex exited with ${signal ?? code}`));
      } else if (
        !completed ||
        !threadId ||
        threadId === options.threadId ||
        !answer?.trim()
      ) {
        fail(new Error("Codex did not complete the side question"));
      } else {
        settled = true;
        resolve({ answer, threadId });
      }
    });
    child.stdin.end(options.question);
  });

  return { result, cancel: () => cancel() };
}
