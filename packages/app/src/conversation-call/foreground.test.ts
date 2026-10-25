import { expect, test } from "vitest";
import { bindForegroundCall } from "./foreground";

test("Android background ends voice once, leaves accepted agent work alone and does not auto-redial", () => {
  let listener!: (state: string) => void;
  let ended = 0;
  let unsubscribed = false;
  let phase = "connected";
  const dispose = bindForegroundCall({
    subscribe(callback) {
      listener = callback;
      return () => {
        unsubscribed = true;
      };
    },
    getPhase: () => phase,
    end() {
      ended++;
      phase = "ended";
    },
  });
  listener("background");
  listener("inactive");
  listener("active");
  expect(ended).toBe(1);
  expect(phase).toBe("ended");
  dispose();
  expect(unsubscribed).toBe(true);
});
