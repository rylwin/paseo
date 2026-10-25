import { isWeb } from "@/constants/platform";
import type { CallMedia, MediaEvents } from "./controller";

class BrowserCallMedia implements CallMedia {
  private stopped = false;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private readonly abort = new AbortController();
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly events: MediaEvents,
  ) {
    this.deadline = setTimeout(
      () => events.failed("Call connection timed out. Check the host and try again."),
      95000,
    );
  }

  async offer(): Promise<string> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Microphone requires HTTPS or localhost. Open a secure connection and try again.",
      );
    void this.play();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError")
        throw new Error(
          "Microphone permission denied. Allow microphone access in browser settings, then try again.",
          { cause: error },
        );
      throw new Error("No microphone available. Check your device and try again.", {
        cause: error,
      });
    }
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Call ended");
    }
    this.stream = stream;
    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.createDataChannel("realtime-events");
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.addEventListener("track", (event) => {
      if (this.stopped) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.play();
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.stopped) return;
      if (peer.connectionState === "connected") {
        clearTimeout(this.deadline);
        this.events.connected();
      }
      if (peer.connectionState === "disconnected" || peer.connectionState === "failed")
        this.events.failed(
          "Audio connection lost. Pi may still be working; check its status before resending.",
        );
    });
    await peer.setLocalDescription(await peer.createOffer());
    await this.gather(peer);
    if (this.stopped) throw new Error("Call ended");
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("No audio offer available. Try again.");
    return sdp;
  }

  private gather(peer: RTCPeerConnection): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const timeout = setTimeout(done, 8000);
      const signal = this.abort.signal;
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", check);
        signal.removeEventListener("abort", done);
        // The finished guard makes the abort/timeout/ICE race settle exactly once.
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      }
      function check() {
        if (peer.iceGatheringState === "complete") done();
      }
      peer.addEventListener("icegatheringstatechange", check);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
      check();
    });
  }

  async answer(sdp: string) {
    if (this.stopped || !this.peer) return;
    await this.peer.setRemoteDescription({ type: "answer", sdp });
  }
  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
  async play(): Promise<boolean> {
    try {
      await this.audio.play();
      if (!this.stopped) this.events.playbackBlocked(false);
      return true;
    } catch {
      if (!this.stopped) this.events.playbackBlocked(true);
      return false;
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.deadline);
    this.abort.abort();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.peer?.close();
    this.peer = null;
    this.audio.pause();
    this.audio.srcObject = null;
    this.audio.remove();
  }
}

export function createCallMedia(events: MediaEvents): CallMedia {
  if (!isWeb) throw new Error("GPT-Live calls are available in the browser");
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("data-testid", "conversation-call-audio");
  audio.style.display = "none";
  document.body.appendChild(audio);
  return new BrowserCallMedia(audio, events);
}
