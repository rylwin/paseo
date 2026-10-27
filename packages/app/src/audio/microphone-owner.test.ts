import { expect, test } from "vitest";
import { createMicrophoneOwner } from "./microphone-owner";

test("call and existing dictation/voice capture cannot acquire the microphone concurrently", () => {
  const microphone = createMicrophoneOwner();
  const releaseDictation = microphone.acquire();
  expect(() => microphone.acquire()).toThrow(
    "Microphone is in use. End dictation, voice mode, or the call before trying again.",
  );
  releaseDictation();
  const releaseCall = microphone.acquire();
  releaseDictation();
  expect(() => microphone.acquire()).toThrow("Microphone is in use");
  releaseCall();
  microphone.acquire()();
});
