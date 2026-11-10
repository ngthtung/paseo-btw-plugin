import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BtwPanel } from "./client/btw";
import { startQuestion } from "./shared/btw";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addAgentPanel({
    id: "btw",
    title: "/btw",
    icon: "MessageCircle",
    Component: BtwPanel,
  });
  const removeCommand = client.addSlashCommand({
    name: "btw",
    description: "Start an ephemeral side chat",
    argumentHint: "[prompt]",
    context: "agent",
    async onSubmit({ args, agent, rpc, openPanel }) {
      openPanel("btw");
      if (args.trim()) {
        await rpc(startQuestion, { agentId: agent.id, question: args });
        openPanel("btw");
      }
    },
  });
  return () => {
    removeCommand();
    removePanel();
  };
}
