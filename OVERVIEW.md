Start an ephemeral side chat with `/btw <prompt>` in a Codex agent. The plugin opens a separate Paseo tab and forks the agent's saved Codex context. The question and answer stay out of the main agent's transcript, and the main turn continues running.

Requires Paseo 0.15.3 or later, Node.js 24 or later, and Codex CLI with `codex exec fork --ephemeral` support. The source was built against Paseo 0.15.3 and Codex CLI 0.167.0.

The plugin runs your existing `codex` executable with the `read-only` sandbox and existing Codex configuration and authentication. It does not need a separate API key. Side questions are sent to the model provider configured in your Codex installation. The selected Paseo model and reasoning effort are forwarded when available.

Each question uses a new ephemeral fork of saved history. Unflushed context from the current main turn may be missing. Answers are kept in plugin memory until it is unloaded. Cancel stops only the side-question subprocess. Paseo does not dispatch plugin slash commands when the composer has attachments.
