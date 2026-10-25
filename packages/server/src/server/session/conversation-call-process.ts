import { spawn } from "node:child_process";
import pino from "pino";
import { CodexAppServerClient } from "../agent/providers/codex/app-server-transport.js";
import { CodexConversationCall } from "./conversation-call-provider.js";
import { ConversationCalls, type CallProviderOptions } from "./conversation-call.js";
import { resolveCallAgent } from "./conversation-call-agent.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { SessionAuthorization } from "../authorization/index.js";
import type { SessionDelivery } from "./owned-subscriptions/index.js";

interface SessionCallsOptions {
  binary: string | undefined;
  delivery: SessionDelivery;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  authorization: SessionAuthorization;
  logger: pino.Logger;
}

export function createSessionCalls(options: SessionCallsOptions): ConversationCalls | null {
  const binary = options.binary;
  if (!binary) return null;
  return new ConversationCalls({
    delivery: options.delivery,
    resolveAgent: (agentId) =>
      resolveCallAgent({
        agentId,
        agentManager: options.agentManager,
        agentStorage: options.agentStorage,
        logger: options.logger,
        allows: () =>
          options.authorization.allowsPermission("workspace.write") &&
          options.authorization.allowsPermission("workspace.read"),
      }),
    createProvider: (call) => createCallProvider(binary, call),
  });
}

export function createCallProvider(binary: string, options: CallProviderOptions) {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  const child = spawn(
    binary,
    [
      "app-server",
      "--enable",
      "realtime_conversation",
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "shell_snapshot",
      "-c",
      "mcp_servers={}",
      "-c",
      'web_search="disabled"',
      "-c",
      "analytics.enabled=false",
    ],
    { cwd: options.agent.cwd, env, stdio: "pipe" },
  );
  // App-server traces can contain conversation content. This call does not log provider frames.
  const rpc = new CodexAppServerClient(child, pino({ level: "silent" }));
  return new CodexConversationCall(rpc, options);
}
