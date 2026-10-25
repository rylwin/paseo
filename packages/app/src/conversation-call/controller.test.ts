import { expect, test } from "vitest";
import {
  ConversationCallController,
  type CallMedia,
  type CallSignaling,
  type MediaEvents,
} from "./controller";
import type { ConversationCallEvent } from "@getpaseo/protocol/messages";

function fixture() {
  const offers: string[] = [];
  const ended: string[] = [];
  let stopped = 0;
  const mutes: boolean[] = [];
  const speakers: boolean[] = [];
  let disconnected = () => {};
  let events: MediaEvents | null = null;
  let receive: (callId: string, event: ConversationCallEvent) => void = () => {};
  let answer!: (result: { sdp: string }) => void;
  const remote = new Promise<{ sdp: string }>((resolve) => {
    answer = resolve;
  });
  const media: CallMedia = {
    async offer() {
      return "offer";
    },
    async answer() {},
    mute(value) {
      mutes.push(value);
    },
    async setSpeaker(value) {
      speakers.push(value);
    },
    async play() {
      return true;
    },
    stop() {
      stopped++;
    },
  };
  const signaling: CallSignaling = {
    supported: true,
    async start(input) {
      offers.push(input.agentId);
      return remote;
    },
    async end(id) {
      ended.push(id);
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
    disconnected(listener) {
      disconnected = listener;
      return () => {};
    },
  };
  const controller = new ConversationCallController({
    createMedia(callbacks) {
      events = callbacks;
      return media;
    },
    newId: () => "call1",
  });
  return {
    controller,
    signaling,
    offers,
    ended,
    answer,
    mutes,
    speakers,
    disconnect: () => disconnected(),
    receive: (id: string, event: ConversationCallEvent) => receive(id, event),
    get events() {
      if (!events) throw new Error("no media");
      return events;
    },
    get stopped() {
      return stopped;
    },
  };
}
const target = { serverId: "host1", agentId: "pi1", label: "Host one / Pi one" };

test("speaker state follows native reports, not button presses, and late reports cannot revive ended calls", async () => {
  const f = fixture();
  const starting = f.controller.start(target, f.signaling);
  f.events.audioOutput?.({ route: "speaker", canToggle: true, pending: false, error: "" });
  await f.controller.toggleSpeaker();
  expect(f.speakers).toEqual([false]);
  expect(f.controller.getSnapshot()).toMatchObject({ audioOutput: { route: "speaker" } });
  f.events.audioOutput?.({ route: "earpiece", canToggle: true, pending: false, error: "" });
  expect(f.controller.getSnapshot()).toMatchObject({ audioOutput: { route: "earpiece" } });
  f.events.audioOutput?.({ route: "headset", canToggle: false, pending: false, error: "" });
  await f.controller.toggleSpeaker();
  expect(f.speakers).toEqual([false]);
  f.controller.end();
  f.events.audioOutput?.({ route: "speaker", canToggle: true, pending: false, error: "" });
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "ended", audioOutput: null });
  f.answer({ sdp: "late" });
  await starting;
});

test("media receives the immutable owned call identity before acquisition", async () => {
  let identity: unknown;
  const f = fixture();
  const controller = new ConversationCallController({
    newId: () => "owned-call",
    createMedia(_events, captured) {
      identity = captured;
      return {
        async offer() {
          throw new Error("stop before signaling");
        },
        async answer() {},
        mute() {},
        async play() {
          return true;
        },
        stop() {},
      };
    },
  });
  await controller.start(target, f.signaling);
  expect(identity).toEqual({ callId: "owned-call", target });
});

test("native notification end quietly stops voice without canceling accepted Pi work or redialing", async () => {
  const f = fixture();
  const starting = f.controller.start(target, f.signaling);
  await Promise.resolve();
  f.events.ended?.();
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "ended", error: "" });
  expect(f.stopped).toBe(1);
  expect(f.ended).toEqual(["call1"]);
  f.answer({ sdp: "late answer" });
  await starting;
  f.events.connected();
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "ended" });
  expect(f.offers).toEqual(["pi1"]);
});

test("unsupported hosts fail visibly before acquiring a microphone", async () => {
  const f = fixture();
  await f.controller.start(target, { ...f.signaling, supported: false });
  expect(f.controller.getSnapshot()).toMatchObject({
    phase: "failed",
    error: "Update the host and enable conversation calls to use GPT-Live",
    target,
  });
  expect(f.offers).toEqual([]);
  expect(f.stopped).toBe(0);
  f.controller.dismiss();
  expect(f.controller.getSnapshot()).toEqual({ phase: "idle" });
});

test("barge-in transcripts and navigation never dispatch, stop, steer, or retarget Pi", async () => {
  const f = fixture();
  const starting = f.controller.start(target, f.signaling);
  f.answer({ sdp: "answer" });
  await starting;
  f.events.connected();
  f.receive("other-call", { kind: "transcript", role: "user", text: "wrong call" });
  f.receive("call1", {
    kind: "transcript",
    role: "user",
    text: "Wait, I am speaking over the audio",
  });
  f.controller.toggleMinimized();
  await f.controller.start({ ...target, agentId: "pi2", serverId: "host2" }, f.signaling);
  expect(f.controller.getSnapshot()).toMatchObject({
    phase: "connected",
    target,
    minimized: true,
    transcript: "Wait, I am speaking over the audio",
  });
  expect(f.offers).toEqual(["pi1"]);
  expect(f.ended).toEqual([]);
  expect(f.stopped).toBe(0);
  f.controller.end();
});

test("mute, playback recovery and disconnect cleanup do not affect Pi", async () => {
  const f = fixture();
  const starting = f.controller.start(target, f.signaling);
  f.answer({ sdp: "answer" });
  await starting;
  f.events.connected();
  f.controller.toggleMute();
  expect(f.mutes).toEqual([true]);
  f.events.playbackBlocked(true);
  await f.controller.play();
  expect(f.controller.getSnapshot()).toMatchObject({ muted: true, playbackBlocked: false });
  f.disconnect();
  expect(f.controller.getSnapshot()).toMatchObject({
    phase: "failed",
    error: "Host disconnected. Pi may still be working; reconnect and check its status.",
  });
  expect(f.stopped).toBe(1);
  f.events.connected();
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "failed" });
});

test("later focus mutations cannot change the target while microphone permission is pending", async () => {
  const f = fixture();
  const selected = { ...target };
  const starting = f.controller.start(selected, f.signaling);
  selected.agentId = "later-focused-agent";
  f.answer({ sdp: "answer" });
  await starting;
  expect(f.offers).toEqual(["pi1"]);
  expect(f.controller.getSnapshot()).toMatchObject({ target });
  f.controller.end();
});

test("muting while permission is pending also mutes a microphone acquired later", async () => {
  let grant!: (sdp: string) => void;
  const permission = new Promise<string>((resolve) => {
    grant = resolve;
  });
  let acquired = false;
  let streamMuted = false;
  const f = fixture();
  const controller = new ConversationCallController({
    newId: () => "call1",
    createMedia() {
      return {
        async offer() {
          const sdp = await permission;
          acquired = true;
          return sdp;
        },
        async answer() {},
        mute(muted) {
          if (acquired) streamMuted = muted;
        },
        async play() {
          return true;
        },
        stop() {},
      };
    },
  });
  const starting = controller.start(target, f.signaling);
  controller.toggleMute();
  grant("offer");
  f.answer({ sdp: "answer" });
  await starting;
  expect(streamMuted).toBe(true);
  controller.end();
});

test("captures the original conversation target and cancels late signaling", async () => {
  const f = fixture();
  const starting = f.controller.start(target, f.signaling);
  await Promise.resolve();
  expect(f.offers).toEqual(["pi1"]);
  f.controller.end();
  f.answer({ sdp: "late answer" });
  await starting;
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "ended", target });
  expect(f.ended).toEqual(["call1"]);
  expect(f.stopped).toBe(1);
});
