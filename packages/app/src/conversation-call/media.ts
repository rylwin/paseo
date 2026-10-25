import type { CallMedia, MediaEvents } from "./controller";

export function createCallMedia(_events: MediaEvents): CallMedia {
  return {
    async offer() {
      throw new Error(
        "GPT-Live calls are available in the browser. Chat and dictation are unchanged.",
      );
    },
    async answer() {},
    mute() {},
    async play() {
      return false;
    },
    stop() {},
  };
}
