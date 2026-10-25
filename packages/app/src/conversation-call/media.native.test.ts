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
  permission: vi.fn(),
  prepare: vi.fn(),
  serviceStart: vi.fn(),
  nativeAcquire: vi.fn(),
  ownPeer: vi.fn(),
  activeId: () => "call",
}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => ({
    prepare: hardware.prepare,
    start: hardware.serviceStart,
    stop: hardware.stop,
    startAudio: () => hardware.start({ media: "video", auto: true }),
    acquire: hardware.nativeAcquire,
    ownPeer: hardware.ownPeer,
    activeId: hardware.activeId,
    endedReason: () => null,
    addListener: () => ({ remove() {} }),
  }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 36 },
  AppRegistry: { registerHeadlessTask() {} },
  AppState: { addEventListener: () => ({ remove() {} }) },
  PermissionsAndroid: {
    PERMISSIONS: {
      RECORD_AUDIO: "microphone",
      BLUETOOTH_CONNECT: "bluetooth",
      POST_NOTIFICATIONS: "notifications",
    },
    RESULTS: { GRANTED: "granted" },
    request: hardware.permission,
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
  MediaStream: class {
    getAudioTracks() {
      return [{ enabled: true, stop: hardware.stopTrack }];
    }
    getTracks() {
      return this.getAudioTracks();
    }
    release = hardware.release;
  },
  RTCPeerConnection: class {
    nativePeerConnectionId = 7;
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
  hardware.permission.mockResolvedValue("granted");
  const track = { enabled: true, stop: hardware.stopTrack };
  hardware.setDefaultAudioRoute.mockResolvedValue({
    selectedAudioDevice: "EARPIECE",
    availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE"]',
  });
  hardware.serviceStart.mockResolvedValue(undefined);
  hardware.nativeAcquire.mockResolvedValue({
    streamId: "stream",
    streamReactTag: "stream",
    tracks: [],
  });
  hardware.getUserMedia.mockResolvedValue({
    getAudioTracks: () => [track],
    getTracks: () => [track],
    release: hardware.release,
  });
});

test("notification denial never starts capture and does not imply microphone permission was revoked", async () => {
  hardware.permission.mockImplementation(async (permission: string) =>
    permission === "notifications" ? "denied" : "granted",
  );
  const media = createCallMedia(
    { connected() {}, failed() {}, playbackBlocked() {} },
    { callId: "call", target: { serverId: "host", agentId: "pi", label: "Pi" } },
  );
  try {
    await expect(media.offer()).rejects.toThrow(
      "Enable Paseo call notifications in Android settings, then try again. The call has not started.",
    );
    expect(hardware.prepare).not.toHaveBeenCalled();
    expect(hardware.nativeAcquire).not.toHaveBeenCalled();
    expect(hardware.start).not.toHaveBeenCalled();
  } finally {
    media.stop();
  }
});

test("native service startup rejection never reaches microphone acquisition or routing", async () => {
  hardware.serviceStart.mockRejectedValueOnce(
    new Error("Return to Paseo and start the call while the app is visible."),
  );
  const media = createCallMedia(
    { connected() {}, failed() {}, playbackBlocked() {} },
    { callId: "call", target: { serverId: "host", agentId: "pi", label: "Pi" } },
  );
  try {
    await expect(media.offer()).rejects.toThrow("Return to Paseo");
    expect(hardware.prepare).toHaveBeenCalledExactlyOnceWith("call");
    expect(hardware.nativeAcquire).not.toHaveBeenCalled();
    expect(hardware.start).not.toHaveBeenCalled();
  } finally {
    media.stop();
  }
  expect(hardware.stop).toHaveBeenCalledExactlyOnceWith("call");
});

test("native route events and fallback acknowledgements reach the call media client", async () => {
  const audioOutput = vi.fn();
  const media = createCallMedia(
    { connected() {}, failed() {}, playbackBlocked() {}, audioOutput },
    { callId: "call", target: { serverId: "host", agentId: "pi", label: "Pi" } },
  );
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
  const media = createCallMedia(
    { connected() {}, failed() {}, playbackBlocked() {} },
    { callId: "call", target: { serverId: "host", agentId: "pi", label: "Pi" } },
  );
  try {
    expect(await media.offer()).toBe("native offer");
    // InCallManager's video preset means speaker fallback, not camera capture.
    // auto=true retains the library's Bluetooth > wired > default route policy.
    expect(hardware.start).toHaveBeenCalledWith({ media: "video", auto: true });
    expect(hardware.prepare).toHaveBeenCalledExactlyOnceWith("call");
    expect(hardware.serviceStart).toHaveBeenCalledExactlyOnceWith(
      "call",
      "Pi",
      "paseo:///h/host/agent/pi",
    );
    expect(hardware.nativeAcquire).toHaveBeenCalledExactlyOnceWith("call");
    expect(hardware.ownPeer).toHaveBeenCalledExactlyOnceWith("call", 7);
    expect(hardware.stopProximitySensor).toHaveBeenCalledOnce();
    expect(hardware.setKeepScreenOn).toHaveBeenCalledWith(false);
  } finally {
    media.stop();
    media.stop();
  }
  expect(hardware.stop).toHaveBeenCalledExactlyOnceWith("call");
  expect(hardware.close).toHaveBeenCalledOnce();
  expect(hardware.stopTrack).toHaveBeenCalledOnce();
  expect(hardware.release).toHaveBeenCalledOnce();
});
