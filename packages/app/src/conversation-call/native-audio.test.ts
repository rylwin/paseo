import { expect, test, vi } from "vitest";
import { NativeCallAudio } from "./native-audio";

const speaker = {
  selectedAudioDevice: "SPEAKER_PHONE",
  availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE"]',
};
const earpiece = { ...speaker, selectedAudioDevice: "EARPIECE" };
function fixture() {
  let report = (_status: typeof speaker) => {};
  const remove = vi.fn();
  const manager = {
    start: vi.fn(),
    stop: vi.fn(),
    stopProximitySensor: vi.fn(),
    setKeepScreenOn: vi.fn(),
    setDefaultAudioRoute: vi.fn().mockResolvedValue(speaker),
  };
  const states: Array<{ route: string; canToggle: boolean; pending: boolean; error: string }> = [];
  const audio = new NativeCallAudio(
    manager,
    (listener) => {
      report = listener;
      return remove;
    },
    (state) => states.push(state),
  );
  audio.start();
  report(speaker);
  return { audio, manager, remove, states, report };
}

test("speaker toggle changes only the default route, and waits for native acknowledgement", async () => {
  const f = fixture();
  expect(f.manager.start).toHaveBeenCalledWith({ media: "video", auto: true });
  let acknowledge!: (status: typeof speaker) => void;
  f.manager.setDefaultAudioRoute.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const changing = f.audio.setSpeaker(false);
  expect(f.manager.setDefaultAudioRoute).toHaveBeenCalledWith("EARPIECE");
  expect(f.states.at(-1)).toMatchObject({ route: "speaker", pending: true });
  acknowledge(earpiece);
  await changing;
  expect(f.states.at(-1)).toMatchObject({ route: "earpiece", pending: false, canToggle: true });
  f.manager.setDefaultAudioRoute.mockResolvedValue(speaker);
  await f.audio.setSpeaker(true);
  expect(f.manager.setDefaultAudioRoute).toHaveBeenLastCalledWith("SPEAKER_PHONE");
  expect(f.states.at(-1)?.route).toBe("speaker");
});

test.each(["WIRED_HEADSET", "BLUETOOTH"])(
  "%s remains preferred and disables the handset toggle",
  async (route) => {
    const f = fixture();
    f.report({
      selectedAudioDevice: route,
      availableAudioDeviceList: JSON.stringify([route, "SPEAKER_PHONE", "EARPIECE"]),
    });
    expect(f.states.at(-1)).toMatchObject({ route: "headset", canToggle: false });
    await f.audio.setSpeaker(true);
    expect(f.manager.setDefaultAudioRoute).not.toHaveBeenCalled();
    // A native disconnect report makes the handset toggle available again.
    f.report(earpiece);
    expect(f.states.at(-1)).toMatchObject({ route: "earpiece", canToggle: true });
  },
);

test("a rejected route switch leaves the actual route selected and call audio alive", async () => {
  const f = fixture();
  f.manager.setDefaultAudioRoute.mockRejectedValue(new Error("route unavailable"));
  await f.audio.setSpeaker(false);
  expect(f.states.at(-1)).toMatchObject({
    route: "speaker",
    pending: false,
    error: "Could not change audio output. Try again.",
  });
  expect(f.manager.stop).not.toHaveBeenCalled();
});

test("stop restores through InCallManager once, removes route subscription, and ignores late acknowledgements", async () => {
  const f = fixture();
  let acknowledge!: (status: typeof speaker) => void;
  f.manager.setDefaultAudioRoute.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const changing = f.audio.setSpeaker(false);
  f.audio.stop();
  f.audio.stop();
  const count = f.states.length;
  acknowledge(earpiece);
  await changing;
  f.report(speaker);
  expect(f.states).toHaveLength(count);
  expect(f.manager.stop).toHaveBeenCalledOnce();
  expect(f.remove).toHaveBeenCalledOnce();
});

test("unknown native routes and devices without an earpiece never claim speaker is on or offer an invalid switch", async () => {
  const f = fixture();
  f.report({ selectedAudioDevice: "NONE", availableAudioDeviceList: "bad payload" });
  expect(f.states.at(-1)).toMatchObject({ route: "unknown", canToggle: false });
  await f.audio.setSpeaker(true);
  expect(f.manager.setDefaultAudioRoute).not.toHaveBeenCalled();
  f.report({ ...speaker, availableAudioDeviceList: '["SPEAKER_PHONE"]' });
  expect(f.states.at(-1)).toMatchObject({ route: "speaker", canToggle: false });
});
