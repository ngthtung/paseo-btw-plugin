import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const archiveRoot = "/Applications/Paseo.app/Contents/Resources/app.asar";
const pluginsRoot = `${archiveRoot}/node_modules/@getpaseo/server/dist/server/server/plugins`;
const fixturePath = path.join(
  pluginRoot,
  "tests",
  "fixtures",
  "fake-codex.mjs",
);
const resultPath = path.join(
  path.dirname(pluginRoot),
  "paseo-btw-plugin-offline-check.json",
);
const { compileDirectoryPlugin } = await import(
  pathToFileURL(`${pluginsRoot}/compiler.js`).href
);
const { evaluateBundle } = await import(
  pathToFileURL(`${pluginsRoot}/bundle-evaluator.js`).href
);
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const children = new Set();
const handlers = new Map();
const snapshots = new Map();
let mainAgentMutations = 0;
let spawnCount = 0;
let dispose;

const temporaryRoot = path.join(pluginRoot, "tests", ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(temporaryRoot, "compiled-server-"));
const sourceThreadId = "36a47c5a-c0d0-4fbc-8061-d0580c495ec1";
const forkThreadId = "5799398b-cbb9-478a-b984-a412021e4c3f";
const transcript = '{"type":"user","text":"Main task remains in progress"}\n';

async function eventually(check) {
  const deadline = Date.now() + 5000;
  let lastError;
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

async function prepare(agentId, mode, question, answer) {
  const cwd = path.join(runRoot, agentId);
  await mkdir(cwd);
  await writeFile(path.join(cwd, "main-transcript.jsonl"), transcript);
  await writeFile(
    path.join(cwd, "scenario.json"),
    JSON.stringify({
      mode,
      question,
      answer,
      sourceThreadId,
      forkThreadId,
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    }),
  );
  const snapshot = {
    id: agentId,
    provider: "codex",
    cwd,
    workspaceId: "offline-workspace",
    model: "fallback-model-must-not-override-runtime",
    thinkingOptionId: "low",
    effectiveThinkingOptionId: "medium",
    status: "running",
    persistence: { provider: "codex", sessionId: sourceThreadId },
    runtimeInfo: {
      provider: "codex",
      sessionId: sourceThreadId,
      model: "gpt-6.1-sol",
      thinkingOptionId: "high",
      modeId: null,
    },
  };
  snapshots.set(agentId, snapshot);
  return snapshot;
}

async function invoke(name, input) {
  const registration = handlers.get(name);
  assert.ok(registration, `RPC ${name} must be registered`);
  const parsedInput = await registration.contract.input.parseAsync(input);
  const output = await registration.handler(parsedInput, { paseo });
  return registration.contract.output.parseAsync(output);
}

function forbiddenMainMutation() {
  mainAgentMutations += 1;
  throw new Error("The side-question plugin must not mutate the main agent");
}

const paseo = {
  agents: {
    ref(agentId) {
      let current = null;
      return {
        id: agentId,
        async refresh() {
          current = snapshots.get(agentId) ?? null;
          return { agent: current };
        },
        current: () => current,
        get runtimeInfo() {
          return current?.runtimeInfo ?? null;
        },
        get cwd() {
          return current?.cwd ?? null;
        },
        send: forbiddenMainMutation,
        run: forbiddenMainMutation,
        interrupt: forbiddenMainMutation,
        archive: forbiddenMainMutation,
        reload: forbiddenMainMutation,
      };
    },
  },
};

try {
  const compiled = await compileDirectoryPlugin(pluginRoot, "0.15.3");
  assert.equal(typeof compiled.clientBundle, "string");
  assert.equal(typeof compiled.serverBundle, "string");

  childProcess.spawn = (command, args, options) => {
    assert.equal(command, "codex", "only Codex execution may be intercepted");
    assert.equal(options.shell, false);
    spawnCount += 1;
    const child = originalSpawn(fixturePath, args, options);
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };

  const contribute = evaluateBundle(compiled.serverBundle);
  dispose = contribute({
    handle(contract, handler) {
      assert.ok(!handlers.has(contract.name), "RPC names must be unique");
      handlers.set(contract.name, { contract, handler });
    },
  });
  assert.equal(typeof dispose, "function");
  assert.deepEqual([...handlers.keys()].sort(), [
    "btw.cancel",
    "btw.list",
    "btw.start",
  ]);

  const questionA = "  \n\tKeep my indentation and trailing newline.\n ";
  const agentA = await prepare("agent-a", "hang", questionA);
  const startA = await invoke("btw.start", {
    agentId: agentA.id,
    question: questionA,
  });
  await eventually(async () => {
    const captured = JSON.parse(
      await readFile(path.join(agentA.cwd, "captured.json"), "utf8"),
    );
    assert.equal(
      captured.input,
      questionA,
      "RPC validation must not transform the question",
    );
  });

  const questionB = "What is the result?";
  const answerB = "Đáp án riêng, outside the main transcript.";
  const agentB = await prepare("agent-b", "success", questionB, answerB);
  const startB = await invoke("btw.start", {
    agentId: agentB.id,
    question: questionB,
  });
  assert.notEqual(startA.id, startB.id);
  await eventually(async () => {
    const listed = await invoke("btw.list", { agentId: agentB.id });
    assert.deepEqual(listed.questions, [
      {
        id: startB.id,
        question: questionB,
        status: "complete",
        answer: answerB,
      },
    ]);
  });
  assert.deepEqual(await invoke("btw.list", { agentId: "unrelated-agent" }), {
    questions: [],
  });

  await invoke("btw.cancel", { agentId: agentB.id, id: startA.id });
  assert.deepEqual(await invoke("btw.list", { agentId: agentA.id }), {
    questions: [{ id: startA.id, question: questionA, status: "running" }],
  });
  assert.equal(children.size, 1, "a different agent cannot cancel this job");
  await invoke("btw.cancel", { agentId: agentA.id, id: startA.id });
  await eventually(async () => assert.equal(children.size, 0));
  assert.deepEqual(await invoke("btw.list", { agentId: agentA.id }), {
    questions: [{ id: startA.id, question: questionA, status: "cancelled" }],
  });

  const countBeforeRejectedRequests = spawnCount;
  await assert.rejects(
    invoke("btw.start", { agentId: "missing-agent", question: "Never start" }),
  );
  await assert.rejects(
    invoke("btw.start", { agentId: agentA.id, question: " \n\t " }),
  );
  const nonCodexAgent = {
    ...agentA,
    id: "non-codex",
    runtimeInfo: { ...agentA.runtimeInfo, provider: "claude" },
  };
  snapshots.set(nonCodexAgent.id, nonCodexAgent);
  await assert.rejects(
    invoke("btw.start", { agentId: nonCodexAgent.id, question: "Never start" }),
  );
  const noSessionAgent = {
    ...agentA,
    id: "no-session",
    runtimeInfo: { ...agentA.runtimeInfo, sessionId: null },
  };
  snapshots.set(noSessionAgent.id, noSessionAgent);
  await assert.rejects(
    invoke("btw.start", {
      agentId: noSessionAgent.id,
      question: "Never start",
    }),
  );
  assert.equal(spawnCount, countBeforeRejectedRequests);

  const questionC = "Stop this question when the plugin unloads.";
  const agentC = await prepare("agent-c", "hang", questionC);
  await invoke("btw.start", { agentId: agentC.id, question: questionC });
  await eventually(async () => {
    await readFile(path.join(agentC.cwd, "captured.json"), "utf8");
    assert.equal(children.size, 1);
  });
  dispose();
  await eventually(async () => assert.equal(children.size, 0));
  assert.deepEqual(await invoke("btw.list", { agentId: agentC.id }), {
    questions: [],
  });
  assert.equal(mainAgentMutations, 0);
  for (const agent of [agentA, agentB, agentC]) {
    assert.equal(
      await readFile(path.join(agent.cwd, "main-transcript.jsonl"), "utf8"),
      transcript,
    );
  }

  const result = {
    status: "pass",
    paseoVersion: "0.15.3",
    checks: [
      "actual installed compiler and SDK/Zod bundle evaluation",
      "RPC names and schemas",
      "runtime snapshot and model/reasoning forwarding",
      "question whitespace preservation",
      "per-agent list and cancel scope",
      "completion answer",
      "invalid requests do not spawn",
      "cancel and unload stop children",
      "no main-agent mutations",
    ],
    fakeCodexRuns: spawnCount,
    realModelCalls: 0,
    mainAgentMutations,
    pluginInstalledOrEnabled: false,
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  dispose?.();
  childProcess.spawn = originalSpawn;
  for (const child of children) child.kill("SIGKILL");
  await rm(runRoot, { recursive: true, force: true });
}
