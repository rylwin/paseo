import { expect, test } from "vitest";
import pino from "pino";
import { FakePi } from "../agent/providers/pi/test-utils/fake-pi.js";
import { createPiBriefingGenerator } from "./conversation-call-briefing-model.js";

test("uses an isolated ephemeral Pi generation session without tools or startup context files", async () => {
  const runtime = new FakePi();
  let submitted!: () => void;
  const submission = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  runtime.queueSessionSetup((session) => {
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, images) => {
      const result = await prompt(text, images);
      submitted();
      return result;
    };
  });
  const generator = createPiBriefingGenerator({
    runtime,
    logger: pino({ level: "silent" }),
    resolveProviders: async () => [
      { provider: "pi", model: "openai-codex/gpt-6-luna", thinkingOptionId: "low" },
    ],
  });
  const result = generator.generate("quoted bound timeline", new AbortController().signal);
  await submission;
  const session = runtime.latestSession();
  expect(runtime.recordedLaunches[0]).toMatchObject({
    noSession: true,
    model: "openai-codex/gpt-6-luna",
    thinkingOptionId: "low",
  });
  expect(runtime.recordedLaunches[0]!.argv).toEqual(
    expect.arrayContaining([
      "--no-tools",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
    ]),
  );
  expect(session.prompts[0]!.message).toContain("quoted bound timeline");
  session.messages = [
    { role: "assistant", content: [{ type: "text", text: '{"briefing":"Decision: use blue."}' }] },
  ];
  session.emit({ type: "agent_end", messages: session.messages });
  expect(await result).toBe("Decision: use blue.");
});
