# paseo-btw-plugin

A custom Paseo plugin that opens ephemeral Codex side chats with `/btw`.

Use `/btw <prompt>` in a Codex agent to open a separate tab with an answer based on an ephemeral, read-only fork of its saved context. `/btw` without a prompt opens the tab. You can also type a question in the tab and select Send or press Enter. Shift+Enter inserts a newline; Enter while confirming IME composition does not send. Each question starts a separate fork; it is not a follow-up to the previous side question.

## Contents and review

- `index.client.tsx`, `client/`: slash command and Paseo panel.
- `index.server.ts`, `server/codex.ts`: in-memory jobs and isolated Codex subprocess.
- `shared/`: validated RPC contracts.
- `tests/`: process-level tests using a local executable fixture. Tests do not call a model.

The source uses Paseo's host-provided plugin SDK, React Native, React, and Zod. `devDependencies` describe development types and tools. No other plugin source is included.

## Validation

Run `node --test tests/*.test.ts` with Node.js 24 or later. The test fixtures and temporary workspaces stay inside `tests/.tmp/` and are removed after each test.

`npm run test:client` checks the compiled panel with React and jsdom on this Mac. It requires the development dependencies listed in `package.json`. When reusing existing development dependencies from another directory, set `PASEO_TEST_DEPS_ROOT` to that directory. No model calls are made.

`npm run typecheck` requires the development types listed in `package.json`. The build can also be checked with Paseo's own installed compiler without installing or enabling this plugin.

## Limits

The fork reads saved history; the latest unflushed part of a running turn may not be present. The existing `codex` on the daemon's PATH supplies the model provider, credentials, and general configuration. The plugin forwards the Paseo model and reasoning effort when available. It does not copy launch-only environment overrides from the main agent.

The `read-only` sandbox governs the side Codex process. External tools available through your existing Codex configuration retain their own permissions. No extra tools, services, API keys, or plugins are configured by this source.

Questions and answers live only in plugin memory. Reloading the plugin or daemon discards them. With composer attachments present, Paseo does not invoke plugin slash commands.

## Local installation

Load the source directory with `paseo plugin install /absolute/path/to/paseo-btw-plugin`. Paseo must have plugins enabled. This local source has no preparation commands or dependency-install step.

After editing the source, use `paseo plugin reload paseo-btw`.

## Sources

- https://paseo.sh/docs/plugins/reference.md
- https://paseo.sh/docs/sdk/agents.md
- https://developers.openai.com/codex/cli/slash-commands/
- https://developers.openai.com/codex/cli/reference/
- https://developers.openai.com/codex/noninteractive/
