import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { CallAgent } from "./conversation-call.js";
import { conversationHistory } from "./conversation-call-history.js";

interface Dependencies {
  agentId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  allows(): boolean;
  logger: Logger;
}

export async function resolveCallAgent(dependencies: Dependencies): Promise<CallAgent> {
  if (!dependencies.allows()) throw new Error("Call requires workspace authority");
  const { agentId, agentManager, agentStorage } = dependencies;
  const agent = agentManager.getAgent(agentId);
  const record = await agentStorage.get(agentId);
  const eligible =
    agent &&
    agent.provider === "pi" &&
    agent.lifecycle !== "closed" &&
    agent.lifecycle !== "initializing" &&
    !agent.internal &&
    !agent.owner &&
    record &&
    !record.archivedAt;
  if (!eligible || !agent) throw new Error("Target is not an eligible live Pi agent");
  return {
    title: agent.config.title ?? agentId,
    cwd: agent.cwd,
    async request(instruction, signal) {
      signal.throwIfAborted();
      const before = await agentManager.getTimelineRows(agentId);
      const lastSeq = before.at(-1)?.seq ?? 0;
      signal.throwIfAborted();
      if (agentManager.hasInFlightRun(agentId)) {
        const steered = await agentManager.steerAgentRun(agentId, instruction);
        if (steered.status !== "accepted")
          throw new Error(
            "Pi cannot accept steering right now; task was not resent or interrupted",
          );
      } else {
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId,
          prompt: instruction,
          activeTurnBehavior: "steer",
          clearPendingPermissions: false,
          unarchive: false,
          logger: dependencies.logger,
        });
      }
      // Abort stops observation only. Never pass the call's signal into Pi's provider turn.
      const observation = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
      const result = await agentManager.waitForAgentEvent(agentId, { signal: observation });
      if (result.permission)
        return "Pi is waiting for permissions. Resolve them in Paseo; do not resend the task.";
      if (result.status !== "idle")
        throw new Error("Pi did not complete successfully; ask for status");
      const rows = await agentManager.getTimelineRows(agentId);
      const fresh = rows.filter(
        (row) => row.seq > lastSeq && row.item.type === "assistant_message",
      );
      const text = fresh
        .map((row) => (row.item.type === "assistant_message" ? row.item.text : ""))
        .join("");
      if (!text) throw new Error("No fresh Pi answer is available; ask for status");
      return `Pi replied: ${text}`.slice(0, 12000);
    },
    async history(input, signal) {
      signal.throwIfAborted();
      await resolveCallAgent(dependencies);
      signal.throwIfAborted();
      const epoch = agentManager.fetchTimeline(agentId, { limit: 1 }).epoch;
      const rows = await agentManager.getTimelineRows(agentId);
      await resolveCallAgent(dependencies);
      signal.throwIfAborted();
      if (agentManager.fetchTimeline(agentId, { limit: 1 }).epoch !== epoch)
        throw new Error("Pi timeline changed during read");
      return { ...conversationHistory(rows, input), epoch };
    },
    async status(signal) {
      signal.throwIfAborted();
      const current = agentManager.getAgent(agentId);
      if (!current) throw new Error("Pi is no longer live");
      const answer = await agentManager.getLastAssistantMessage(agentId);
      return `Pi status: ${current.lifecycle}. Pending permissions: ${current.pendingPermissions.size}. Latest assistant reply: ${answer ?? "No reply yet"}`.slice(
        0,
        12000,
      );
    },
  };
}
