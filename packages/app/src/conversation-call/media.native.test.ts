import { beforeEach, expect, test, vi } from "vitest";

const hardware = vi.hoisted(() => ({
  start: vi.fn(),
  setDefaultAudioRoute: vi.fn(),
  remove: vi.fn(),
  routeChanged: (_status: { selectedAudioDevice: string; availableAudioDeviceList: string }) => {},
  stop: vi.fn(),
  stopProximitySensor: vi.fn(),
  setKeepScreenOn: vi.fn(),
  getUserMedia: vi.fn(),
  release: vi.fn(),
  stopTrack: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 36 },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: "microphone", BLUETOOTH_CONNECT: "bluetooth" },
    RESULTS: { GRANTED: "granted" },
    request: async () => "granted",
  },
  NativeModules: { InCallManager: hardware },
  DeviceEventEmitter: {
    addListener: (_name: string, listener: typeof hardware.routeChanged) => {
      hardware.routeChanged = listener;
      return { remove: hardware.remove };
    },
  },
}));
vi.mock("react-native-incall-manager", () => ({ default: hardware }));
vi.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: hardware.getUserMedia },
  RTCPeerConnection: class {
    iceGatheringState = "complete";
    localDescription = { type: "offer", sdp: "native offer" };
    createDataChannel() {}
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
    close = hardware.close;
  },
}));
// Exercise the real native adapter and NativeCallMedia, with native APIs as boundaries.
import { createCallMedia } from "./media.native";

beforeEach(() => {
  vi.clearAllMocks();
  const track = { enabled: true, stop: hardware.stopTrack };
  hardware.setDefaultAudioRoute.mockResolvedValue({
    selectedAudioDevice: "EARPIECE",
    availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE"]',
  });
  hardware.getUserMedia.mockResolvedValue({
    getAudioTracks: () => [track],
    getTracks: () => [track],
    release: hardware.release,
  });
});

test("native route events and fallback acknowledgements reach the call media client", async () => {
  const audioOutput = vi.fn();
  const media = createCallMedia({ connected() {}, failed() {}, playbackBlocked() {}, audioOutput });
  try {
    await media.offer();
    hardware.routeChanged({
      selectedAudioDevice: "SPEAKER_PHONE",
      availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE"]',
    });
    expect(audioOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ route: "speaker", canToggle: true }),
    );
    await media.setSpeaker?.(false);
    expect(hardware.setDefaultAudioRoute).toHaveBeenCalledWith("EARPIECE");
    expect(audioOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ route: "earpiece", pending: false }),
    );
  } finally {
    media.stop();
  }
  expect(hardware.remove).toHaveBeenCalledOnce();
});

test("hands-free calls request speaker fallback with automatic headset routing, then release once", async () => {
  const media = createCallMedia({ connected() {}, failed() {}, playbackBlocked() {} });
  try {
    expect(await media.offer()).toBe("native offer");
    // InCallManager's video preset means speaker fallback, not camera capture.
    // auto=true retains the library's Bluetooth > wired > default route policy.
    expect(hardware.start).toHaveBeenCalledWith({ media: "video", auto: true });
    expect(hardware.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(hardware.stopProximitySensor).toHaveBeenCalledOnce();
    expect(hardware.setKeepScreenOn).toHaveBeenCalledWith(false);
  } finally {
    media.stop();
    media.stop();
  }
  expect(hardware.stop).toHaveBeenCalledExactlyOnceWith();
  expect(hardware.close).toHaveBeenCalledOnce();
  expect(hardware.stopTrack).toHaveBeenCalledOnce();
  expect(hardware.release).toHaveBeenCalledOnce();
});
