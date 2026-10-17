import { describe, expect, it } from "vitest";
import { createWorkspaceCommand } from "./index.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { render } from "../../output/index.js";
import { runRestoreCommandWithDeps } from "./restore.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Only the daemon boundary is faked: these tests prove CLI routing and output,
// not the daemon's filesystem recovery implementation.
function daemon(
  overrides: Partial<
    Pick<DaemonClient, "inspectWorkspaceRecovery" | "restoreWorkspace" | "close">
  > = {},
) {
  const calls: string[] = [];
  return {
    calls,
    connectToDaemon: async () => ({
      inspectWorkspaceRecovery: async (workspaceId: string) => {
        calls.push(`inspect:${workspaceId}`);
        return {
          kind: "recoverable" as const,
          workspaceId,
          workspaceName: "Work",
          action: "unarchive" as const,
          branch: null,
        };
      },
      restoreWorkspace: async (workspaceId: string) => {
        calls.push(`restore:${workspaceId}`);
      },
      close: async () => {
        calls.push("close");
      },
      ...overrides,
    }),
  };
}

describe("workspace restore", () => {
  it("restores the original id and returns structured output, then closes", async () => {
    const host = daemon();
    const result = await runRestoreCommandWithDeps("ws-original", { daemonTarget }, host);
    expect(result).toMatchObject({
      type: "single",
      data: { workspaceId: "ws-original", status: "restored" },
    });
    expect(JSON.parse(render(result, { format: "json" }))).toEqual({
      workspaceId: "ws-original",
      status: "restored",
    });
    expect(host.calls).toEqual(["inspect:ws-original", "restore:ws-original", "close"]);
  });
  it("returns already_active without issuing a restore for an active workspace", async () => {
    const host = daemon({
      inspectWorkspaceRecovery: async (workspaceId) => ({
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_archived",
        message: "Not archived",
      }),
    });
    const result = await runRestoreCommandWithDeps("ws-active", { daemonTarget }, host);
    expect(result.data).toEqual({ workspaceId: "ws-active", status: "already_active" });
    expect(host.calls).toEqual(["close"]);
  });

  it.each([
    "workspace_not_found",
    "project_not_found",
    "project_directory_missing",
    "workspace_directory_missing",
    "worktree_branch_missing",
  ] as const)("reports %s with a recovery reason and closes without restoring", async (reason) => {
    const host = daemon({
      inspectWorkspaceRecovery: async (workspaceId) => ({
        kind: "unavailable",
        workspaceId,
        reason,
        message: "Host recovery explanation",
      }),
    });
    await expect(
      runRestoreCommandWithDeps("ws-unavailable", { daemonTarget }, host),
    ).rejects.toEqual({
      code: "WORKSPACE_RESTORE_UNAVAILABLE",
      message: "Host recovery explanation",
      details: {
        workspaceId: "ws-unavailable",
        reason,
        recovery:
          "Check the workspace ID and restore any missing project directory, workspace directory, or worktree branch on the host, then retry.",
      },
    });
    expect(host.calls).toEqual(["close"]);
  });

  it("normalizes restore RPC failures and closes even when closing also fails", async () => {
    const host = daemon({
      restoreWorkspace: async () => {
        throw Object.assign(new Error("Recovery rejected"), { code: undefined });
      },
      close: async () => {
        host.calls.push("close");
        throw new Error("Close failed");
      },
    });
    await expect(runRestoreCommandWithDeps("ws-rpc", { daemonTarget }, host)).rejects.toEqual({
      code: "WORKSPACE_RESTORE_FAILED",
      message: "Recovery rejected",
    });
    expect(host.calls).toEqual(["inspect:ws-rpc", "close"]);
  });

  it("normalizes inspection RPC failures without attempting a restore", async () => {
    const host = daemon({
      inspectWorkspaceRecovery: async () => {
        throw new Error("Inspection failed");
      },
    });
    await expect(runRestoreCommandWithDeps("ws-inspect", { daemonTarget }, host)).rejects.toEqual({
      code: "WORKSPACE_RESTORE_FAILED",
      message: "Inspection failed",
    });
    expect(host.calls).toEqual(["close"]);
  });

  it("preserves normalized connection errors and selects the requested target", async () => {
    const connectionError = {
      code: "AUTH_REQUIRED",
      message: "Authentication required for example.test:12345",
      details: "Pair with this daemon before connecting.",
    };
    await expect(
      runRestoreCommandWithDeps(
        "ws-offline",
        { daemonTarget },
        {
          connectToDaemon: async (options) => {
            expect(options.target).toEqual(daemonTarget);
            throw connectionError;
          },
        },
      ),
    ).rejects.toBe(connectionError);
  });

  it("registers the workspace id and standard output and target options", () => {
    const restore = createWorkspaceCommand().commands.find(
      (command) => command.name() === "restore",
    );
    expect(
      restore?.registeredArguments.map((argument) => [argument.name(), argument.required]),
    ).toEqual([["workspace-id", true]]);
    expect(restore?.options.map((option) => option.long)).toEqual(["--json", "--host", "--home"]);
  });
});
