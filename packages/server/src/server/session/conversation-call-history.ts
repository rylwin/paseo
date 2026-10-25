import { z } from "zod";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";

const CursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const HistoryInputSchema = z
  .object({
    before: CursorSchema.optional(),
    after: CursorSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine((value) => value.before === undefined || value.after === undefined, {
    message: "before and after are mutually exclusive",
  });
export type HistoryInput = z.infer<typeof HistoryInputSchema>;
export interface HistoryMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
  textTruncated: boolean;
}
export interface HistoryPage {
  epoch?: string;
  messages: HistoryMessage[];
  direction: "before" | "after";
  nextCursor: number | null;
  hasMore: boolean;
  skippedOlder: boolean;
}

function boundedMessage(message: HistoryMessage): HistoryMessage {
  if (Buffer.byteLength(JSON.stringify(message)) <= 6000) return message;
  const characters = Array.from(message.text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = {
      ...message,
      text: characters.slice(0, middle).join(""),
      textTruncated: true,
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= 6000) low = middle;
    else high = middle - 1;
  }
  return { ...message, text: characters.slice(0, low).join(""), textTruncated: true };
}

/** Rows already use AgentManager's human-message projection, including envelope provenance. */
export function conversationHistory(rows: AgentTimelineRow[], input: HistoryInput): HistoryPage {
  const options = HistoryInputSchema.parse(input);
  const direction = options.after === undefined ? "before" : "after";
  const candidates = rows.flatMap((row): HistoryMessage[] => {
    if (row.item.type !== "user_message" && row.item.type !== "assistant_message") return [];
    if (options.before !== undefined && row.seq >= options.before) return [];
    if (options.after !== undefined && row.seq <= options.after) return [];
    return [
      {
        seq: row.seq,
        role: row.item.type === "user_message" ? "user" : "assistant",
        text: row.item.text,
        textTruncated: false,
      },
    ];
  });
  const limit = options.limit ?? 20;
  const ordered = direction === "before" ? candidates.toReversed() : candidates;
  const messages: HistoryMessage[] = [];
  // Reserve space for pagination metadata. Bound serialized UTF-8, including JSON escapes.
  let bytes = 512;
  for (const candidate of ordered.slice(0, limit)) {
    const message = boundedMessage(candidate);
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes + size > 10000) break;
    messages.push(message);
    bytes += size;
  }
  if (direction === "before") messages.reverse();
  const hasMore = candidates.length > messages.length;
  return {
    messages,
    direction,
    nextCursor: (direction === "before" ? messages[0]?.seq : messages.at(-1)?.seq) ?? null,
    hasMore,
    skippedOlder: direction === "before" && hasMore,
  };
}
