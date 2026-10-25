import { expect, test } from "vitest";
import { createCallMedia } from "./media.js";

test("native fallback needs no DOM and keeps existing chat and dictation independent", async () => {
  const media = createCallMedia({ connected() {}, failed() {}, playbackBlocked() {} });
  await expect(media.offer()).rejects.toThrow(
    "GPT-Live calls are available in the browser. Chat and dictation are unchanged.",
  );
  media.mute(true);
  media.stop();
  expect(await media.play()).toBe(false);
});
