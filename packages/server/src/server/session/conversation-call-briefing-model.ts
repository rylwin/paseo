import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  getStructuredAgentResponse,
  type StructuredGenerationProvider,
} from "../agent/agent-response-loop.js";
import type { PiRuntime, PiRuntimeSession } from "../agent/providers/pi/runtime.js";
import type { BriefingGenerator } from "./conversation-call-briefing.js";

// Feature-local explicit selection, not a change to the daemon's metadata defaults.
export const BRIEFING_MODEL = {
  provider: "pi",
  model: "openai-codex/gpt-6-luna",
  thinkingOptionId: "low",
} as const;

export function createPiBriefingGenerator(deps: {
  runtime: PiRuntime;
  resolveProviders(): Promise<StructuredGenerationProvider[]>;
  logger: Logger;
}): BriefingGenerator {
  return {
    async generate(text, signal) {
      const providers = await deps.resolveProviders();
      signal.throwIfAborted();
      const selected = providers.find((provider) => provider.provider === "pi");
      if (!selected?.model) throw new Error("No Pi briefing model available");
      const cwd = await mkdtemp(join(tmpdir(), "paseo-call-briefing-"));
      let session: PiRuntimeSession | undefined;
      try {
        session = await deps.runtime.startSession({
          cwd,
          signal,
          noSession: true,
          model: selected.model,
          thinkingOptionId: selected.thinkingOptionId,
          extraArgs: [
            "--no-tools",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--offline",
            "--system-prompt",
            "You summarize quoted conversation data. No tools, file access, or task execution. Return only the requested factual JSON.",
          ],
        });
        signal.throwIfAborted();
        deps.logger.info(
          {
            provider: selected.provider,
            model: selected.model,
            thinkingOptionId: selected.thinkingOptionId,
          },
          "Call briefing model selected",
        );
        const runtimeSession = session;
        const result = await getStructuredAgentResponse({
          prompt: text,
          schema: z.object({ briefing: z.string().trim().min(1).max(3000) }).strict(),
          maxRetries: 0,
          schemaName: "BoundPiCallBriefing",
          caller: (prompt) => runGeneration(runtimeSession, prompt, signal),
        });
        return result.briefing;
      } finally {
        await session?.close().catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

async function runGeneration(
  session: PiRuntimeSession,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  let unsubscribe = () => {};
  let abort = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => {
        reject(new Error("Briefing canceled"));
        // This owns only its private ephemeral generation process, never the bound Pi.
        void session.close().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      unsubscribe = session.onEvent((event) => {
        if (event.type === "process_exit") reject(new Error("Briefing process ended"));
        if (event.type === "agent_end" && !event.willRetry) {
          void session.getMessages().then((messages) => {
            const answer = messages.findLast((message) => message.role === "assistant");
            if (
              !answer ||
              answer.role !== "assistant" ||
              answer.errorMessage ||
              answer.stopReason === "error"
            ) {
              return reject(new Error("Briefing generation failed"));
            }
            return resolve(
              answer.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            );
          }, reject);
        }
      });
      if (signal.aborted) abort();
      else void session.prompt(prompt).catch(reject);
    });
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", abort);
  }
}
