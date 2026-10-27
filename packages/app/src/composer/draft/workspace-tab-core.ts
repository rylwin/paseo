import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";

export function handoffVoiceDraft(input: {
  sourceDraftKey: string;
  targetDraftKey: string;
  sourceScopeKey: string;
  targetScopeKey: string;
}): void {
  const drafts = useDraftStore.getState();
  const draft = drafts.getDraftInput(input.sourceDraftKey);
  if (draft) {
    drafts.saveDraftInput({ draftKey: input.targetDraftKey, draft });
    drafts.clearDraftInput({ draftKey: input.sourceDraftKey, lifecycle: "sent" });
  }
  const attachments = useWorkspaceAttachmentsStore.getState();
  for (const attachment of attachments.attachmentsByScope[input.sourceScopeKey] ?? []) {
    attachments.addWorkspaceAttachment({ scopeKey: input.targetScopeKey, attachment });
  }
  attachments.clearWorkspaceAttachments({ scopeKey: input.sourceScopeKey });
}

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  isConnected: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
