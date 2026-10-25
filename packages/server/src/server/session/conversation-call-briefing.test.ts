import { expect, test } from "vitest";
import { generateCallBriefing } from "./conversation-call-briefing.js";
import { conversationHistory } from "./conversation-call-history.js";
import type { CallAgent } from "./conversation-call.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";

function fixture() {
  const rows: AgentTimelineRow[] = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    timestamp: "2026-01-01T00:00:00Z",
    item: { type: index % 2 ? "assistant_message" : "user_message", text: `message ${index}` },
  }));
  const agent: CallAgent = {
    title: "Pi",
    cwd: "/tmp",
    async request() {
      throw new Error("No tasks");
    },
    async status() {
      return "idle";
    },
    async history(input) {
      return { ...conversationHistory(rows, input), epoch: "one" };
    },
  };
  return { rows, agent };
}

test("an epoch change during snapshot discards source before any generation", async () => {
  const f = fixture();
  const startup = await f.agent.history({ limit: 20 }, new AbortController().signal);
  const inputs: string[] = [];
  const agent: CallAgent = {
    ...f.agent,
    async history(input, signal) {
      return { ...(await f.agent.history(input, signal)), epoch: "rewritten" };
    },
  };
  await expect(
    generateCallBriefing(
      agent,
      startup,
      {
        async generate(text) {
          inputs.push(text);
          return "summary";
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Pi timeline changed");
  expect(inputs).toEqual([]);
});

test("briefing preserves source truncation and its exact snapshot cutoff, excluding later arrivals", async () => {
  const f = fixture();
  f.rows[0]!.item = { type: "user_message", text: "old ".repeat(10000) };
  const signal = new AbortController().signal;
  const startup = await f.agent.history({ limit: 20 }, signal);
  f.rows.push({
    seq: 31,
    timestamp: "2026-01-01T00:00:01Z",
    item: { type: "user_message", text: "later override" },
  });
  let input = "";
  const result = await generateCallBriefing(
    f.agent,
    startup,
    {
      async generate(text) {
        input = text;
        return "Earlier decision";
      },
    },
    signal,
  );
  expect(result).toMatchObject({
    status: "ready",
    coverage: { epoch: "one", from: 1, cutoff: 30, omittedOlder: false, truncatedSeqs: [1] },
  });
  expect(input).not.toContain("later override");
  expect(input).toContain("Recent and newer messages override");
  expect(Buffer.byteLength(input)).toBeLessThan(64000);
});
