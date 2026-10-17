import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface WorkspaceRestoreResult {
  workspaceId: string;
  status: "restored" | "already_active";
}

const workspaceRestoreSchema: OutputSchema<WorkspaceRestoreResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 18 },
  ],
};

interface RestoreDependencies {
  connectToDaemon(
    options: ConnectOptions,
  ): Promise<Pick<DaemonClient, "inspectWorkspaceRecovery" | "restoreWorkspace" | "close">>;
}

function restoreFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw { code: "WORKSPACE_RESTORE_FAILED", message } satisfies CommandError;
}

export async function runRestoreCommand(
  workspaceId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRestoreResult>> {
  return runRestoreCommandWithDeps(workspaceId, options, { connectToDaemon });
}

export async function runRestoreCommandWithDeps(
  workspaceId: string,
  options: CommandOptions,
  deps: RestoreDependencies,
): Promise<SingleResult<WorkspaceRestoreResult>> {
  const client = await deps.connectToDaemon({ target: options.daemonTarget });
  try {
    const state = await client.inspectWorkspaceRecovery(workspaceId).catch(restoreFailure);
    if (state.kind === "unavailable" && state.reason === "workspace_not_archived") {
      return {
        type: "single",
        data: { workspaceId, status: "already_active" },
        schema: workspaceRestoreSchema,
      };
    }
    if (state.kind === "unavailable") {
      throw {
        code: "WORKSPACE_RESTORE_UNAVAILABLE",
        message: state.message,
        details: {
          workspaceId,
          reason: state.reason,
          recovery:
            "Check the workspace ID and restore any missing project directory, workspace directory, or worktree branch on the host, then retry.",
        },
      } satisfies CommandError;
    }
    await client.restoreWorkspace(workspaceId).catch(restoreFailure);
    return {
      type: "single",
      data: { workspaceId, status: "restored" },
      schema: workspaceRestoreSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
