#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const scenario = JSON.parse(
  await readFile(path.join(process.cwd(), "scenario.json"), "utf8"),
);
const args = process.argv.slice(2);
const option = (...names) => {
  for (let index = 0; index < args.length; index += 1) {
    if (names.includes(args[index])) return args[index + 1];
    for (const name of names) {
      if (args[index].startsWith(`${name}=`))
        return args[index].slice(name.length + 1);
    }
  }
  return undefined;
};
const configs = args.flatMap((arg, index) => {
  if (arg === "-c" || arg === "--config") return [args[index + 1]];
  if (arg.startsWith("--config=")) return [arg.slice("--config=".length)];
  return [];
});
const config = (name) => {
  const value = configs.findLast((entry) => entry?.startsWith(`${name}=`));
  return value
    ?.slice(name.length + 1)
    .replaceAll('"', "")
    .replaceAll("'", "");
};

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();

try {
  assert.equal(args[0], "exec", "must use non-interactive exec");
  assert.equal(
    args[args.indexOf("fork") + 1],
    scenario.sourceThreadId,
    "must fork the specified native thread id",
  );
  assert.ok(
    args.includes("fork"),
    "must fork rather than create a fresh conversation",
  );
  assert.ok(
    !args.includes("resume"),
    "must never append the side question to the source conversation",
  );
  assert.ok(args.includes("--ephemeral"), "fork must not be persisted");
  assert.ok(args.includes("--json"), "must request the event stream");
  assert.ok(args.includes("-"), "question must be read from stdin");
  assert.equal(
    option("--sandbox", "-s") ?? config("sandbox_mode"),
    "read-only",
    "side question must use a read-only sandbox",
  );
  assert.ok(
    !args.some(
      (arg) =>
        arg.startsWith("--dangerously-bypass") ||
        arg === "--approve-for-me" ||
        arg === "--full-auto",
    ),
  );
  assert.equal(
    input,
    scenario.question,
    "stdin must preserve the entire question without shell interpretation",
  );
  assert.equal(option("--model", "-m"), scenario.model);
  assert.equal(config("model_reasoning_effort"), scenario.reasoningEffort);
} catch (error) {
  process.stderr.write(`Fixture rejected invocation: ${error.message}\n`);
  process.exit(34);
}

await writeFile(
  path.join(process.cwd(), "captured.json"),
  JSON.stringify({ args, input, cwd: process.cwd(), pid: process.pid }),
);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: scenario.forkThreadId });
emit({ type: "turn.started" });

switch (scenario.mode) {
  case "success": {
    emit({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "do not return this",
        exit_code: 0,
        status: "completed",
      },
    });
    const line = Buffer.from(
      `${JSON.stringify({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: scenario.answer } })}\n`,
    );
    const unicodeIndex = line.indexOf(Buffer.from("á"));
    const split = unicodeIndex === -1 ? 19 : unicodeIndex + 1;
    process.stdout.write(line.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.stdout.write(line.subarray(split));
    emit({
      type: "turn.completed",
      usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 7 },
    });
    break;
  }
  case "turn-failed":
    emit({
      type: "turn.failed",
      error: { message: "Provider rejected side question" },
    });
    break;
  case "missing-completion":
    emit({
      type: "item.completed",
      item: {
        id: "partial",
        type: "agent_message",
        text: "Incomplete answer must not count as success",
      },
    });
    break;
  case "process-failed":
    emit({
      type: "item.completed",
      item: {
        id: "partial",
        type: "agent_message",
        text: "An answer before a failed process is not success",
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });
    process.stderr.write("Codex subprocess failed after emitting output\n");
    process.exitCode = 23;
    break;
  case "hang":
    setInterval(() => {}, 1000);
    break;
  default:
    throw new Error(`Unknown fixture scenario: ${scenario.mode}`);
}
