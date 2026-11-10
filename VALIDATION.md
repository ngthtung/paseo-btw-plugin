# Validation

Verified locally against Paseo 0.15.3 and Node.js 24.22.1. Subsequently installed from the reviewed local source: the daemon reports `running`, with startup log `Plugin ready`.

- Process tests: 7 passed, 0 failed or skipped. They exercise the real runner with a local executable fixture, including ephemeral read-only forks, exact stdin, failure handling, and cancellation.
- Strict TypeScript check: runner and process tests passed using the workspace's existing Studio compiler and Node types.
- Compiled-client behavior: 5 tests passed against the Paseo-compiled panel using existing React/RTL/jsdom dependencies. Cases cover running-to-complete updates, recovery after a failed status RPC without reopening, blank submission, draft preservation until acceptance, and draft retention after a rejected submission. The transient-error regression failed before the retry fix.
- Paseo compilation: both client and server entries compiled with the compiler bundled in the installed Paseo application.
- Compiled-server integration: passed using Paseo's actual bundle evaluator, plugin SDK and Zod, with only the external Codex subprocess redirected to the fixture. It checks validated RPC inputs/outputs, model and reasoning selection, question preservation, agent scoping, completion, cancellation, and unload cleanup.
- Independent source/rationale review: completed. The command is handled by the plugin client; the server creates an ephemeral Codex fork rather than sending to or resuming the source agent.

The pre-install checks made zero real model calls and did not change the main agent or install dependencies. The plugin was then enabled and installed locally at the user's request. Extracted Paseo reference sources are outside this package and are not included.

## Reproduce process tests

From this directory:

```sh
node --test tests/*.test.ts
```

## Reproduce compiled-server integration on this Mac

From this directory:

```sh
ELECTRON_RUN_AS_NODE=1 \
  '/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper' \
  tests/compiled-server.mjs
```

The integration check writes its JSON result beside this source directory. Temporary workspaces stay inside `tests/.tmp/` and are removed on exit.

## Remaining verification

Full client TypeScript checking was not run: the installed Paseo application omits SDK declaration files, and no packages were downloaded. The actual Paseo compiler accepted the client and server bundles. The client is now exercised through the compiled panel with mapped native UI/RPC boundaries. Native desktop interaction and a live provider answer have not been retested in these checks.
