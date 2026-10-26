import { expect, test } from "vitest";
import { BrowserCallMedia } from "./media.web";

test("real WebRTC transport cannot enable the microphone before the provider session starts", async () => {
  const context = new AudioContext();
  const stream = context.createMediaStreamDestination().stream;
  const track = stream.getAudioTracks()[0];
  const audio = document.createElement("audio");
  const remote = new RTCPeerConnection();
  const actions: string[] = [];
  const media = new BrowserCallMedia(
    audio,
    {
      connected: () => actions.push("ready"),
      failed: (message) => actions.push(message),
      playbackBlocked() {},
    },
    async () => stream,
    { play: () => actions.push("cue"), stop() {} },
  );
  let channel!: RTCDataChannel;
  remote.addEventListener("datachannel", (event) => {
    channel = event.channel;
  });
  try {
    const offer = await media.offer();
    expect(track.enabled).toBe(false);
    await remote.setRemoteDescription({ type: "offer", sdp: offer });
    await remote.setLocalDescription(await remote.createAnswer());
    await expect.poll(() => remote.iceGatheringState).toBe("complete");
    await media.answer(remote.localDescription!.sdp);
    await expect.poll(() => remote.connectionState).toBe("connected");
    await expect.poll(() => channel?.readyState).toBe("open");
    expect(actions).toEqual([]);
    expect(track.enabled).toBe(false);
    channel.send(
      JSON.stringify({ type: "session.started", session: { id: "owned-test", status: "active" } }),
    );
    await expect.poll(() => actions).toEqual(["ready", "cue"]);
    expect(track.enabled).toBe(true);
    media.mute(true);
    expect(track.enabled).toBe(false);
  } finally {
    media.stop();
    remote.close();
    await context.close();
  }
}, 20000);
