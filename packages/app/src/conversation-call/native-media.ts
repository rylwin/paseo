import type { CallMedia, MediaEvents } from "./controller";

interface Description {
  type: string | null;
  sdp: string;
}
export interface NativePeer {
  connectionState: string;
  iceGatheringState: string;
  localDescription: Description | null;
  createOffer(): Promise<Description>;
  setLocalDescription(description: Description): Promise<void>;
  setRemoteDescription(description: Description): Promise<void>;
  addEventListener(
    name: "connectionstatechange" | "icegatheringstatechange",
    listener: () => void,
  ): void;
  removeEventListener(
    name: "connectionstatechange" | "icegatheringstatechange",
    listener: () => void,
  ): void;
  close(): void;
}
export interface NativeMicrophone {
  tracks: Array<{ enabled: boolean; stop(): void }>;
  release(): void;
  openPeer(): NativePeer;
}
export interface NativeMediaDependencies {
  reserveMicrophone(): () => void;
  schedule(callback: () => void, ms: number): () => void;
  requestPermission(): Promise<boolean>;
  acquire(): Promise<NativeMicrophone>;
  startAudio(): void;
  stopAudio(): void;
}

/** The hardware boundary is injected so cancellation can be tested without a phone. */
export class NativeCallMedia implements CallMedia {
  private stopped = false;
  private routed = false;
  private cancelGather = () => {};
  private cancelDeadline = () => {};
  private releaseMicrophone = () => {};
  private microphone: NativeMicrophone | null = null;
  private peer: NativePeer | null = null;
  private readonly connectionChanged = () => {
    if (this.stopped) return;
    if (this.peer?.connectionState === "connected") {
      this.cancelDeadline();
      this.events.connected();
    }
    if (this.peer?.connectionState === "disconnected" || this.peer?.connectionState === "failed") {
      this.events.failed(
        "Audio connection lost. Pi may still be working; check its status before resending.",
      );
    }
  };
  constructor(
    private readonly dependencies: NativeMediaDependencies,
    private readonly events: MediaEvents,
  ) {}
  async offer(): Promise<string> {
    this.releaseMicrophone = this.dependencies.reserveMicrophone();
    if (!(await this.dependencies.requestPermission())) {
      throw new Error(
        "Microphone permission denied. Allow microphone access in Android settings, then try again.",
      );
    }
    if (this.stopped) throw new Error("Call ended");
    this.cancelDeadline = this.dependencies.schedule(() => {
      if (!this.stopped)
        this.events.failed("Call connection timed out. Check the host and try again.");
    }, 95000);
    this.routed = true;
    this.dependencies.startAudio();
    const microphone = await this.dependencies.acquire();
    if (this.stopped) {
      microphone.tracks.forEach((track) => track.stop());
      microphone.release();
      throw new Error("Call ended");
    }
    this.microphone = microphone;
    const peer = this.microphone.openPeer();
    this.peer = peer;
    peer.addEventListener("connectionstatechange", this.connectionChanged);
    await peer.setLocalDescription(await peer.createOffer());
    await this.gather(peer);
    if (this.stopped) throw new Error("Call ended");
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("No audio offer available. Try again.");
    return sdp;
  }
  private gather(peer: NativePeer): Promise<void> {
    if (this.stopped || peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const cancelTimeout = this.dependencies.schedule(done, 8000);
      const check = () => {
        if (peer.iceGatheringState === "complete") done();
      };
      function done() {
        if (finished) return;
        finished = true;
        cancelTimeout();
        peer.removeEventListener("icegatheringstatechange", check);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      }
      this.cancelGather = done;
      peer.addEventListener("icegatheringstatechange", check);
      check();
    });
  }
  async answer(sdp: string) {
    if (!this.stopped) await this.peer?.setRemoteDescription({ type: "answer", sdp });
  }
  mute(muted: boolean) {
    this.microphone?.tracks.forEach((track) => {
      track.enabled = !muted;
    });
  }
  async play() {
    return true;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelGather();
    this.cancelDeadline();
    this.peer?.removeEventListener("connectionstatechange", this.connectionChanged);
    this.peer?.close();
    this.peer = null;
    this.microphone?.tracks.forEach((track) => track.stop());
    this.microphone?.release();
    this.microphone = null;
    if (this.routed) this.dependencies.stopAudio();
    this.routed = false;
    this.releaseMicrophone();
  }
}
