import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload, CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { encodeImages } from "@/utils/encode-images";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { VoiceDraftSession } from "@/voice/voice-runtime";

export function createWorkspaceDraftVoiceSession<TAgent extends { id: string }>(input: {
  client: {
    createAgent(request: { config: AgentSessionConfig; workspaceId: string }): Promise<TAgent>;
    deleteAgent(agentId: string): Promise<void>;
  };
  config: AgentSessionConfig;
  workspaceId: string;
  onCreated(agent: TAgent): void;
}): VoiceDraftSession {
  let agent: TAgent | null = null;
  return {
    async createAgent() {
      agent = await input.client.createAgent({
        config: input.config,
        workspaceId: input.workspaceId,
      });
      return agent.id;
    },
    onCommit() {
      if (agent) input.onCreated(agent);
    },
    discardAgent: (agentId) => input.client.deleteAgent(agentId),
  };
}

export interface WorkspaceDraftAgentRequest {
  workspaceId: string;
  config: AgentSessionConfig;
  text: string;
  clientMessageId: string;
  images?: UserMessageImageAttachment[];
  attachments?: CreateAgentRequestMessage["attachments"];
}

/**
 * Shared by the workspace draft tab and by the new-workspace screen when it finishes creation
 * after the user has already navigated away and no draft tab will ever mount.
 */
export async function requestWorkspaceDraftAgent(
  client: DaemonClient,
  request: WorkspaceDraftAgentRequest,
): Promise<AgentSnapshotPayload> {
  const images = await encodeImages(request.images);
  return await client.createAgent({
    config: request.config,
    workspaceId: request.workspaceId,
    clientMessageId: request.clientMessageId,
    ...(request.text ? { initialPrompt: request.text } : {}),
    ...(images && images.length > 0 ? { images } : {}),
    ...(request.attachments && request.attachments.length > 0
      ? { attachments: request.attachments }
      : {}),
  });
}
