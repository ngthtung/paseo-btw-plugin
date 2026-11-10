import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot =
  process.env.PASEO_BTW_PLUGIN_ROOT ??
  path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const depsRoot = process.env.PASEO_TEST_DEPS_ROOT ?? pluginRoot;
const archiveRoot = "/Applications/Paseo.app/Contents/Resources/app.asar";
const sdkRoot = `${archiveRoot}/node_modules/@getpaseo/plugin/dist`;
const pluginsRoot = `${archiveRoot}/node_modules/@getpaseo/server/dist/server/server/plugins`;
const depsRequire = createRequire(path.join(depsRoot, "package.json"));
const React = depsRequire("react");
const { JSDOM } = depsRequire("jsdom");
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost",
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, waitFor, fireEvent, act } = depsRequire(
  "@testing-library/react",
);
afterEach(cleanup);
after(() => dom.window.close());

const RpcContext = React.createContext(null);
const sdkClient = {
  useRpc(contract) {
    const invoke = React.useContext(RpcContext);
    assert.equal(typeof invoke, "function");
    return React.useCallback(
      (input) => invoke(contract.name, input),
      [invoke, contract.name],
    );
  },
};

const native = { StyleSheet: { create: (styles) => styles } };
for (const [name, tag] of [
  ["View", "div"],
  ["ScrollView", "div"],
  ["Text", "span"],
]) {
  native[name] = ({ children }) => React.createElement(tag, null, children);
}
native.Pressable = ({ children, disabled, onPress, accessibilityLabel }) =>
  React.createElement(
    "button",
    {
      disabled,
      onClick: onPress,
      "aria-label": accessibilityLabel,
    },
    children,
  );
native.TextInput = ({
  value,
  onChangeText,
  onKeyPress,
  placeholder,
  editable,
  accessibilityLabel,
}) =>
  React.createElement("textarea", {
    value,
    placeholder,
    disabled: editable === false,
    "aria-label": accessibilityLabel,
    onChange: (event) => onChangeText?.(event.target.value),
    onKeyDown: onKeyPress,
  });
native.ActivityIndicator = () =>
  React.createElement("span", { role: "progressbar" });

const { compileDirectoryPlugin } = await import(
  pathToFileURL(`${pluginsRoot}/compiler.js`).href
);
const sharedRuntime = await import(pathToFileURL(`${sdkRoot}/index.js`).href);
const zod = await import(
  pathToFileURL(`${archiveRoot}/node_modules/zod/index.js`).href
);
const compiled = await compileDirectoryPlugin(pluginRoot, "0.15.3");
assert.equal(typeof compiled.clientBundle, "string");
const hostModules = {
  "@getpaseo/plugin": sharedRuntime,
  "@getpaseo/plugin/client": sdkClient,
  react: React,
  "react/jsx-runtime": depsRequire("react/jsx-runtime"),
  "react-native": native,
  zod,
};
const factory = globalThis.eval(compiled.clientBundle);
assert.equal(typeof factory, "function");
const exports = factory((name) => {
  assert.ok(
    Object.hasOwn(hostModules, name),
    `Unexpected client dependency: ${name}`,
  );
  return hostModules[name];
});
let Panel;
exports.default({
  addAgentPanel(registration) {
    assert.equal(registration.id, "btw");
    Panel = registration.Component;
    return () => {};
  },
  addSlashCommand() {
    return () => {};
  },
});
assert.equal(typeof Panel, "function");

function mount(invoke) {
  return render(
    React.createElement(
      RpcContext.Provider,
      { value: invoke },
      React.createElement(Panel, {
        theme: { colors: {} },
        layout: { compact: false },
        params: { agentId: "source-agent" },
        revision: 1,
      }),
    ),
  );
}

async function loaded(view) {
  await waitFor(() =>
    assert.equal(view.queryAllByRole("progressbar").length, 0),
  );
}

test("a running question polls to completion and replaces Cancel and the spinner with its answer", async () => {
  let lists = 0;
  const view = mount(async (name, input) => {
    assert.equal(name, "btw.list");
    assert.deepEqual(input, { agentId: "source-agent" });
    lists += 1;
    return {
      questions: [
        lists === 1
          ? {
              id: "question-1",
              question: "Existing question",
              status: "running",
            }
          : {
              id: "question-1",
              question: "Existing question",
              status: "complete",
              answer: "Finished answer",
            },
      ],
    };
  });
  await waitFor(() => assert.ok(view.getByRole("button", { name: "Cancel" })));
  await waitFor(() => assert.ok(view.getByText("Finished answer")), {
    timeout: 2500,
  });
  assert.equal(view.queryByRole("button", { name: "Cancel" }), null);
  assert.equal(view.queryAllByRole("progressbar").length, 0);
  assert.equal(lists, 2);
});

test("a running question recovers automatically after one failed list RPC without reopening the panel", async () => {
  let lists = 0;
  const view = mount(async (name, input) => {
    assert.equal(name, "btw.list");
    assert.deepEqual(input, { agentId: "source-agent" });
    lists += 1;
    if (lists === 2) throw new Error("Temporary list transport error");
    return {
      questions: [
        lists === 1
          ? {
              id: "recovering-question",
              question: "Recover this question",
              status: "running",
            }
          : {
              id: "recovering-question",
              question: "Recover this question",
              status: "complete",
              answer: "Recovered side answer",
            },
      ],
    };
  });
  await waitFor(() => assert.ok(view.getByRole("button", { name: "Cancel" })));
  await waitFor(
    () => assert.ok(view.getByText("Temporary list transport error")),
    { timeout: 2500 },
  );
  await waitFor(() => assert.ok(view.getByText("Recovered side answer")), {
    timeout: 3000,
  });
  assert.equal(view.queryByText("Temporary list transport error"), null);
  assert.equal(view.queryByRole("button", { name: "Cancel" }), null);
  assert.equal(view.queryAllByRole("progressbar").length, 0);
  assert.equal(lists, 3);
});

test("the panel has a message input and disables Send for empty or whitespace-only drafts", async () => {
  const calls = [];
  const view = mount(async (name, input) => {
    calls.push({ name, input });
    assert.equal(name, "btw.list");
    return { questions: [] };
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  const send = view.getByRole("button", { name: "Send message" });
  assert.equal(send.disabled, true);
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.change(input, { target: { value: " \n\t " } });
  assert.equal(send.disabled, true);
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.click(send);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["btw.list"],
  );
});

test("Send preserves the draft until acceptance, starts with the current agent, then clears and refreshes", async () => {
  const question = "  Keep exact whitespace, quotes ' and \".\nSecond line.\n ";
  const calls = [];
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  let lists = 0;
  const view = mount(async (name, input) => {
    calls.push({ name, input });
    if (name === "btw.list") {
      lists += 1;
      return {
        questions:
          lists === 1
            ? []
            : [
                {
                  id: "accepted-question",
                  question,
                  status: "complete",
                  answer: "New side answer",
                },
              ],
      };
    }
    assert.equal(name, "btw.start");
    return accepted;
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    assert.deepEqual(
      calls.find((call) => call.name === "btw.start"),
      {
        name: "btw.start",
        input: { agentId: "source-agent", question },
      },
    ),
  );
  assert.equal(input.value, question);
  assert.equal(lists, 1);
  await act(async () => accept({ id: "accepted-question" }));
  await waitFor(() => assert.equal(input.value, ""));
  await waitFor(() => assert.ok(view.getByText("New side answer")));
  assert.equal(lists, 2);
});

test("a rejected start retains the draft, shows the error, and allows retry", async () => {
  const question = "Keep this question so I can retry.";
  let starts = 0;
  let lists = 0;
  const view = mount(async (name) => {
    if (name === "btw.list") {
      lists += 1;
      return { questions: [] };
    }
    assert.equal(name, "btw.start");
    starts += 1;
    throw new Error("Side question could not start");
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    assert.ok(view.getByText("Side question could not start")),
  );
  assert.equal(input.value, question);
  assert.equal(
    view.getByRole("button", { name: "Send message" }).disabled,
    false,
  );
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(starts, 2));
  assert.equal(lists, 1);
});

test("Enter starts the exact draft once for the current agent and clears it only after acceptance", async () => {
  const question = "  Preserve Enter question whitespace.\nSecond line.\n ";
  const starts = [];
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  let lists = 0;
  const view = mount(async (name, input) => {
    if (name === "btw.list") {
      lists += 1;
      return {
        questions:
          lists === 1
            ? []
            : [
                {
                  id: "keyboard-question",
                  question,
                  status: "complete",
                  answer: "Keyboard side answer",
                },
              ],
      };
    }
    assert.equal(name, "btw.start");
    starts.push(input);
    return accepted;
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  fireEvent.change(input, { target: { value: question } });
  const defaultAllowed = fireEvent.keyDown(input, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
  });
  assert.deepEqual(
    starts,
    [{ agentId: "source-agent", question }],
    "Enter must start the side question exactly once",
  );
  assert.equal(
    defaultAllowed,
    false,
    "submitting Enter must prevent insertion of a newline",
  );
  assert.equal(input.value, question);
  assert.equal(lists, 1);
  fireEvent.keyDown(input, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    repeat: true,
  });
  fireEvent.click(view.getByRole("button", { name: "Send message" }));
  assert.equal(
    starts.length,
    1,
    "pending submission must not start a duplicate question",
  );
  await act(async () => accept({ id: "keyboard-question" }));
  await waitFor(() => assert.equal(input.value, ""));
  await waitFor(() => assert.ok(view.getByText("Keyboard side answer")));
  assert.equal(lists, 2);
});

test("Shift+Enter leaves newline insertion enabled and does not submit", async () => {
  const calls = [];
  const view = mount(async (name, input) => {
    calls.push({ name, input });
    assert.equal(name, "btw.list");
    return { questions: [] };
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  const question = "First line";
  fireEvent.change(input, { target: { value: question } });
  const defaultAllowed = fireEvent.keyDown(input, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    shiftKey: true,
  });
  assert.equal(
    defaultAllowed,
    true,
    "Shift+Enter must preserve the native newline action",
  );
  assert.equal(calls.filter((call) => call.name === "btw.start").length, 0);
  fireEvent.change(input, { target: { value: `${question}\n` } });
  assert.equal(input.value, `${question}\n`);
});

test("Enter during IME composition preserves the native action without submitting", async () => {
  const calls = [];
  const view = mount(async (name, input) => {
    calls.push({ name, input });
    assert.equal(name, "btw.list");
    return { questions: [] };
  });
  await loaded(view);
  const input = view.getByPlaceholderText("Message...");
  const question = "Đang nhập tiếng Việt";
  fireEvent.change(input, { target: { value: question } });
  for (const composition of [
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ]) {
    const defaultAllowed = fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      ...composition,
    });
    assert.equal(
      defaultAllowed,
      true,
      "composing Enter must keep the native IME action",
    );
    assert.equal(input.value, question);
    assert.equal(calls.filter((call) => call.name === "btw.start").length, 0);
  }
});
