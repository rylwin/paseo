import { describe, expect, test } from "vitest";

import {
  handoffVoiceDraft,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "./workspace-tab-core";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { createWorkspaceDraftVoiceSession } from "./create-agent-request";

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    isConnected: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("reports an offline host before an absent catalog or pending model defaults", () => {
    expect(
      validate({
        isConnected: false,
        composerState: {
          ...baseComposerState,
          providerDefinitions: [],
          selectedProvider: null,
          isModelLoading: true,
        },
      }),
    ).toBe("Host is not connected");
  });

  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft voice", () => {
  test("preserves unsent text and attachments when speech opens the agent chat", () => {
    const draft = {
      text: "Still composing this",
      attachments: [
        {
          kind: "workspace_file" as const,
          path: "README.md",
          selection: { kind: "whole_file" as const },
        },
      ],
    };
    useDraftStore.getState().saveDraftInput({ draftKey: "voice-source", draft });
    const context = {
      kind: "chat_history" as const,
      id: "fork-context",
      attachment: {
        type: "text" as const,
        mimeType: "text/plain" as const,
        contextKind: "chat_history" as const,
        title: "Chat history",
        text: "Keep this context",
      },
      source: { serverId: "host-1", agentId: "source-agent" },
    };
    useWorkspaceAttachmentsStore
      .getState()
      .setWorkspaceAttachments({ scopeKey: "voice-source-scope", attachments: [context] });
    handoffVoiceDraft({
      sourceDraftKey: "voice-source",
      targetDraftKey: "voice-target",
      sourceScopeKey: "voice-source-scope",
      targetScopeKey: "voice-target-scope",
    });
    expect(
      useWorkspaceAttachmentsStore.getState().attachmentsByScope["voice-target-scope"],
    ).toEqual([context]);
    expect(
      useWorkspaceAttachmentsStore.getState().attachmentsByScope["voice-source-scope"],
    ).toBeUndefined();
    expect(useDraftStore.getState().getDraftInput("voice-target")).toEqual(draft);
    expect(useDraftStore.getState().getDraftInput("voice-source")).toBeUndefined();
  });
  test("creates an agent with the selected settings but no initial message, and defers opening it", async () => {
    const requests: unknown[] = [];
    const opened: string[] = [];
    const discarded: string[] = [];
    const config = { provider: "pi", cwd: "/tmp/project/subdir", model: "chosen-model" };
    const session = createWorkspaceDraftVoiceSession({
      client: {
        createAgent: async (request) => {
          requests.push(request);
          return { id: "voice-agent" };
        },
        deleteAgent: async (agentId) => {
          discarded.push(agentId);
        },
      },
      workspaceId: "workspace-1",
      config,
      onCreated: (agent) => {
        opened.push(agent.id);
      },
    });
    expect(await session.createAgent()).toBe("voice-agent");
    expect(requests).toEqual([{ workspaceId: "workspace-1", config }]);
    expect(opened).toEqual([]);
    session.onCommit();
    expect(opened).toEqual(["voice-agent"]);
    await session.discardAgent("unused-agent");
    expect(discarded).toEqual(["unused-agent"]);
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });
});
