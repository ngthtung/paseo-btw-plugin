import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { startSideQuestion } from "../server/codex.ts";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(testsDirectory, "fixtures", "fake-codex.mjs");
const sourceThreadId = "36a47c5a-c0d0-4fbc-8061-d0580c495ec1";
const forkThreadId = "5799398b-cbb9-478a-b984-a412021e4c3f";
const sourceTranscript =
  '{"type":"user","text":"Main task remains in progress"}\n';

type Scenario = {
  mode:
    | "success"
    | "turn-failed"
    | "missing-completion"
    | "process-failed"
    | "hang";
  question: string;
  answer?: string;
  model?: string;
  reasoningEffort?: string;
};

async function setup(t: TestContext, scenario: Scenario) {
  const temporaryRoot = path.join(testsDirectory, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(temporaryRoot, "workspace with spaces-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const transcriptPath = path.join(cwd, "main-transcript.jsonl");
  await writeFile(transcriptPath, sourceTranscript);
  await writeFile(
    path.join(cwd, "scenario.json"),
    JSON.stringify({ ...scenario, sourceThreadId, forkThreadId }),
  );
  return { cwd, transcriptPath };
}

async function eventually(check: () => Promise<void>) {
  const deadline = Date.now() + 2500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error("Condition was not observed");
}

test(
  "answers in an ephemeral read-only fork while preserving question, selected cwd, and main transcript",
  { timeout: 5000 },
  async (t) => {
    const answer = "Đáp án từ chat phụ.\nMain task continues.";
    const { cwd, transcriptPath } = await setup(t, {
      mode: "success",
      question: "placeholder",
    });
    const shellMarker = path.join(cwd, "shell-was-executed");
    const question = `Explain this without changing anything.\n$(touch '${shellMarker}')\n\`touch '${shellMarker}'\`\nQuotes: 'single' and "double"; $HOME & | >`;
    await writeFile(
      path.join(cwd, "scenario.json"),
      JSON.stringify({
        mode: "success",
        question,
        answer,
        sourceThreadId,
        forkThreadId,
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
      }),
    );

    const run = startSideQuestion({
      threadId: sourceThreadId,
      cwd,
      question,
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      codexPath: fixturePath,
    });
    t.after(() => run.cancel());
    const result = await run.result;

    assert.deepEqual(result, { answer, threadId: forkThreadId });
    const captured: unknown = JSON.parse(
      await readFile(path.join(cwd, "captured.json"), "utf8"),
    );
    assert.ok(
      typeof captured === "object" &&
        captured !== null &&
        "cwd" in captured &&
        "input" in captured,
    );
    assert.equal(captured.cwd, cwd);
    assert.equal(captured.input, question);
    assert.equal(await readFile(transcriptPath, "utf8"), sourceTranscript);
    await assert.rejects(access(shellMarker), { code: "ENOENT" });
  },
);

test(
  "works without overriding the user's selected model or reasoning settings",
  { timeout: 5000 },
  async (t) => {
    const question = "What does this function return?";
    const answer = "It returns the current value.";
    const { cwd } = await setup(t, { mode: "success", question, answer });
    const run = startSideQuestion({
      threadId: sourceThreadId,
      cwd,
      question,
      codexPath: fixturePath,
    });
    t.after(() => run.cancel());
    assert.deepEqual(await run.result, { answer, threadId: forkThreadId });
  },
);

for (const mode of [
  "turn-failed",
  "missing-completion",
  "process-failed",
] satisfies Scenario["mode"][]) {
  test(
    `rejects ${mode} instead of returning a successful answer`,
    { timeout: 5000 },
    async (t) => {
      const question = "A side question that cannot finish.";
      const { cwd, transcriptPath } = await setup(t, { mode, question });
      const run = startSideQuestion({
        threadId: sourceThreadId,
        cwd,
        question,
        codexPath: fixturePath,
      });
      t.after(() => run.cancel());

      await assert.rejects(
        run.result,
        (error: unknown) => error instanceof Error && error.message.length > 0,
      );
      assert.equal(await readFile(transcriptPath, "utf8"), sourceTranscript);
    },
  );
}

test(
  "rejects when the Codex executable cannot be started",
  { timeout: 5000 },
  async (t) => {
    const question = "Will never reach Codex.";
    const { cwd } = await setup(t, { mode: "success", question });
    const run = startSideQuestion({
      threadId: sourceThreadId,
      cwd,
      question,
      codexPath: path.join(cwd, "missing-codex"),
    });
    t.after(() => run.cancel());
    await assert.rejects(
      run.result,
      (error: unknown) => error instanceof Error && error.message.length > 0,
    );
  },
);

test(
  "cancel stops the subprocess and rejects the pending side question",
  { timeout: 5000 },
  async (t) => {
    const question = "Please wait indefinitely.";
    const { cwd, transcriptPath } = await setup(t, { mode: "hang", question });
    const run = startSideQuestion({
      threadId: sourceThreadId,
      cwd,
      question,
      codexPath: fixturePath,
    });
    t.after(() => run.cancel());
    const rejected = assert.rejects(
      run.result,
      (error: unknown) => error instanceof Error && error.message.length > 0,
    );

    let pid: number | undefined;
    await eventually(async () => {
      const captured: unknown = JSON.parse(
        await readFile(path.join(cwd, "captured.json"), "utf8"),
      );
      assert.ok(
        typeof captured === "object" &&
          captured !== null &&
          "pid" in captured &&
          typeof captured.pid === "number",
      );
      pid = captured.pid;
    });

    run.cancel();
    await rejected;
    await eventually(async () => {
      assert.equal(typeof pid, "number");
      if (typeof pid !== "number")
        throw new Error("Fixture pid was not captured");
      const capturedPid = pid;
      assert.throws(() => process.kill(capturedPid, 0), { code: "ESRCH" });
    });
    assert.equal(await readFile(transcriptPath, "utf8"), sourceTranscript);
  },
);
