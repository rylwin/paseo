import { expect, test } from "vitest";
import { ConversationCallController } from "./controller";
import { NativeCallMedia, type NativeMediaDependencies } from "./native-media";

function fixture() {
  const track = {
    enabled: true,
    stopped: 0,
    stop() {
      this.stopped++;
    },
  };
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  const channelListeners = new Map<string, (event: { data: unknown }) => void>();
  const channel = {
    addEventListener(name: string, listener: (event: { data: unknown }) => void) {
      channelListeners.set(name, listener);
    },
  };
  const peer = {
    createDataChannel() {
      return channel;
    },
    connectionState: "new",
    iceGatheringState: "complete",
    localDescription: { type: "offer", sdp: "native offer" },
    async createOffer() {
      return this.localDescription;
    },
    async setLocalDescription() {
      calls.push("local");
    },
    async setRemoteDescription(description: { sdp: string }) {
      calls.push(description.sdp);
    },
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, listener);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    close() {
      calls.push("close");
    },
  };
  const microphone = {
    tracks: [track],
    release() {
      calls.push("release");
    },
    openPeer() {
      calls.push("peer");
      return peer;
    },
  };
  const timers = new Map<number, () => void>();
  const dependencies: NativeMediaDependencies = {
    reserveMicrophone: () => () => {},
    schedule(callback, ms) {
      timers.set(ms, callback);
      return () => {
        timers.delete(ms);
      };
    },
    async requestPermission() {
      return false;
    },
    async acquire() {
      calls.push("acquire");
      return microphone;
    },
    startAudio() {
      calls.push("route");
    },
    stopAudio() {
      calls.push("unroute");
    },
  };
  const media = new NativeCallMedia(dependencies, {
    connected() {
      calls.push("connected");
    },
    failed(message) {
      calls.push(message);
    },
    playbackBlocked() {},
  });
  return {
    media,
    dependencies,
    track,
    calls,
    microphone,
    peer,
    listeners,
    timers,
    channelListeners,
  };
}

test("a call already stopped before offer cannot reserve the microphone or request permission", async () => {
  const f = fixture();
  f.dependencies.reserveMicrophone = () => {
    f.calls.push("reserved");
    return () => {};
  };
  f.dependencies.requestPermission = async () => {
    f.calls.push("permission");
    return true;
  };
  f.media.stop();
  await expect(f.media.offer()).rejects.toThrow("Call ended");
  expect(f.calls).toEqual([]);
});

test("cancel while foreground service starts never acquires audio and stops the late service", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  let ready!: () => void;
  f.dependencies.background = {
    start: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    stop: () => {
      f.calls.push("service-stop");
    },
  };
  const offering = f.media.offer();
  await Promise.resolve();
  expect(f.calls).toEqual([]);
  f.media.stop();
  ready();
  await expect(offering).rejects.toThrow("Call ended");
  expect(f.calls).toEqual(["service-stop"]);
});

test("native negotiation sends audio, applies answer, mutes tracks and releases resources once", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  expect(await f.media.offer()).toBe("native offer");
  await f.media.answer("remote answer");
  f.media.mute(true);
  expect(f.track.enabled).toBe(false);
  f.media.mute(false);
  expect(f.track.enabled).toBe(false);
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  expect(f.track.enabled).toBe(false);
  expect(f.timers.has(95000)).toBe(true);
  f.channelListeners.get("open")?.({ data: undefined });
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.track.enabled).toBe(true);
  f.media.stop();
  f.media.stop();
  expect(f.track.stopped).toBe(1);
  expect(f.calls).toEqual([
    "route",
    "acquire",
    "peer",
    "local",
    "remote answer",
    "connected",
    "close",
    "release",
    "unroute",
  ]);
});

test("cancel during microphone acquisition releases late tracks without creating a peer", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  let grant!: (value: typeof f.microphone) => void;
  f.dependencies.acquire = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const offering = f.media.offer();
  await Promise.resolve();
  f.media.stop();
  grant(f.microphone);
  await expect(offering).rejects.toThrow("Call ended");
  expect(f.calls).toEqual(["route", "unroute", "release"]);
  expect(f.track.stopped).toBe(1);
});

test("cancel while Android permission is pending never starts audio or acquires a microphone", async () => {
  const f = fixture();
  let grant!: (value: boolean) => void;
  f.dependencies.requestPermission = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const offering = f.media.offer();
  f.media.stop();
  grant(true);
  await expect(offering).rejects.toThrow("Call ended");
  expect(f.calls).toEqual([]);
});

test("connection events reach the controller and no events survive stop", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  await f.media.offer();
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  expect(f.calls).not.toContain("connected");
  f.channelListeners.get("open")?.({ data: undefined });
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.calls.at(-1)).toBe("connected");
  f.peer.connectionState = "failed";
  f.listeners.get("connectionstatechange")?.();
  expect(f.calls.at(-1)).toBe(
    "Audio connection lost. Pi may still be working; check its status before resending.",
  );
  f.media.stop();
  expect(f.listeners.size).toBe(0);
});

test("offer waits for ICE and cancellation settles gathering without a late offer", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  f.peer.iceGatheringState = "gathering";
  const offering = f.media.offer();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.listeners.has("icegatheringstatechange")).toBe(true);
  f.media.stop();
  await expect(offering).rejects.toThrow("Call ended");
  expect(f.listeners.size).toBe(0);
  expect(f.timers.size).toBe(0);
});

test("connection timeout is visible and is cancelled once connected", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  await f.media.offer();
  f.timers.get(95000)?.();
  expect(f.calls.at(-1)).toBe("Call connection timed out. Check the host and try again.");
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  f.channelListeners.get("open")?.({ data: undefined });
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.calls).not.toContain("connected");
  expect(f.track.enabled).toBe(false);
  f.media.stop();
  expect(f.timers.size).toBe(0);
});

test("microphone ownership is released even when permission is denied", async () => {
  const f = fixture();
  let reserved = false;
  f.dependencies.reserveMicrophone = () => {
    reserved = true;
    return () => {
      reserved = false;
    };
  };
  await expect(f.media.offer()).rejects.toThrow("Microphone permission denied");
  expect(reserved).toBe(true);
  f.media.stop();
  expect(reserved).toBe(false);
});

test("controller failure cleans native route, tracks, peer, timers and microphone ownership", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  f.peer.setLocalDescription = async () => {
    throw new Error("Native offer failed");
  };
  let released = false;
  f.dependencies.reserveMicrophone = () => () => {
    released = true;
  };
  const controller = new ConversationCallController({
    createMedia: () => f.media,
    newId: () => "native-call",
  });
  await controller.start(
    { serverId: "host", agentId: "pi", label: "Pi" },
    {
      supported: true,
      async start() {
        throw new Error("Signaling must not start");
      },
      async end() {},
      subscribe: () => () => {},
      disconnected: () => () => {},
    },
  );
  expect(controller.getSnapshot()).toMatchObject({ phase: "failed", error: "Native offer failed" });
  expect(f.calls).toEqual(["route", "acquire", "peer", "close", "release", "unroute"]);
  expect(f.track.stopped).toBe(1);
  expect(f.timers.size).toBe(0);
  expect(released).toBe(true);
});

test("provider readiness before peer readiness preserves early mute and cues exactly once", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  f.dependencies.readyCue = () => {
    f.calls.push("cue");
  };
  f.media.mute(true);
  await f.media.offer();
  expect(f.track.enabled).toBe(false);
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  f.channelListeners.get("open")?.({ data: undefined });
  expect(f.calls).not.toContain("connected");
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  expect(f.track.enabled).toBe(false);
  expect(f.calls.slice(-2)).toEqual(["connected", "cue"]);
  f.listeners.get("connectionstatechange")?.();
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.calls.filter((call) => call === "cue")).toEqual(["cue"]);
  expect(f.timers.size).toBe(0);
  f.media.mute(false);
  expect(f.track.enabled).toBe(true);
  f.media.stop();
});

test("peer failure before provider readiness cannot be followed by a late cue or live microphone", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  f.dependencies.readyCue = () => {
    f.calls.push("cue");
  };
  await f.media.offer();
  f.peer.connectionState = "failed";
  f.listeners.get("connectionstatechange")?.();
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  f.channelListeners.get("open")?.({ data: undefined });
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.calls).not.toContain("connected");
  expect(f.calls).not.toContain("cue");
  expect(f.track.enabled).toBe(false);
  f.media.stop();
});

test.each(["close", "error"])(
  "a data channel %s during startup cannot announce ready",
  async (event) => {
    const f = fixture();
    f.dependencies.requestPermission = async () => true;
    f.dependencies.readyCue = () => {
      f.calls.push("cue");
    };
    await f.media.offer();
    f.channelListeners.get(event)?.({ data: undefined });
    f.peer.connectionState = "connected";
    f.listeners.get("connectionstatechange")?.();
    f.channelListeners.get("open")?.({ data: undefined });
    f.channelListeners.get("message")?.({
      data: '{"type":"session.started","session":{"status":"active"}}',
    });
    expect(f.calls).not.toContain("connected");
    expect(f.calls).not.toContain("cue");
    expect(f.track.enabled).toBe(false);
    f.media.stop();
  },
);

test("a blocked local cue leaves the call ready and does not create a playback error", async () => {
  const f = fixture();
  f.dependencies.requestPermission = async () => true;
  f.dependencies.readyCue = () => {
    throw new Error("No local tone output");
  };
  await f.media.offer();
  f.peer.connectionState = "connected";
  f.listeners.get("connectionstatechange")?.();
  f.channelListeners.get("open")?.({ data: undefined });
  f.channelListeners.get("message")?.({
    data: '{"type":"session.started","session":{"status":"active"}}',
  });
  expect(f.calls).toEqual(["route", "acquire", "peer", "local", "connected"]);
  expect(f.track.enabled).toBe(true);
  f.media.stop();
});

test("the startup deadline includes time waiting for microphone permission", async () => {
  const f = fixture();
  expect([...f.timers.keys()]).toEqual([95000]);
  f.media.stop();
});

test("permission rejection is actionable and never acquires the microphone", async () => {
  const f = fixture();
  await expect(f.media.offer()).rejects.toThrow(
    "Microphone permission denied. Allow microphone access in Android settings, then try again.",
  );
  f.media.stop();
  expect(f.calls).toEqual([]);
});
