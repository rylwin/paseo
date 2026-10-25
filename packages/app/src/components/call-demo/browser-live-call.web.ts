export type LiveCallStatus = "idle" | "connecting" | "connected" | "ended" | "failed";
export interface LiveCallSnapshot {
  status: LiveCallStatus;
  muted: boolean;
  playbackBlocked: boolean;
  error: string;
  identity: string;
  pi: string;
  transcript: string;
}
export const initialLiveCall: LiveCallSnapshot = {
  status: "idle",
  muted: false,
  playbackBlocked: false,
  error: "",
  identity:
    "titanium / PHONE-CALL-PASEO-CODING\ne60df84c-20d9-4629-af7c-5f1b60ae5f24\n/tmp/paseo-call-prototype-20260719",
  pi: "Ready for coding questions and requests in the bound Pi session",
  transcript: "",
};

/** Development-only browser media owner. A closed generation cannot acquire late media. */
export class BrowserLiveCall {
  private snapshot = initialLiveCall;
  private generation = 0;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private audio: HTMLAudioElement,
    private changed: (state: LiveCallSnapshot) => void,
  ) {}

  private update(patch: Partial<LiveCallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed(this.snapshot);
  }

  async start(token: string) {
    if (this.snapshot.status === "connecting" || this.snapshot.status === "connected") return;
    this.cleanup();
    const generation = this.generation;
    this.update({ ...initialLiveCall, status: "connecting" });
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.fail("Microphone requires HTTPS (or localhost). Open the secure preview and try again.");
      return;
    }
    this.deadline = setTimeout(
      () => this.fail("Call connection timed out. Check the bridge and try again."),
      90000,
    );
    // Attempt inside the start gesture; a blocked mobile browser gets an explicit retry control.
    void this.audio.play().catch(() => {});
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      peer.createDataChannel("realtime-events");
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.addEventListener("track", (event) => {
        if (generation !== this.generation) return;
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.playAudio();
      });
      peer.addEventListener("connectionstatechange", () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === "connected") {
          if (this.deadline) clearTimeout(this.deadline);
          this.update({ status: "connected" });
        }
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected")
          this.fail("Audio connection lost. Ended the call; try again.");
      });
      await peer.setLocalDescription(await peer.createOffer());
      // SDP is sent only once; gather candidates before handing the offer to app-server.
      await new Promise<void>((resolve) => {
        let finished = false;
        const timeout = setTimeout(done, 8000);
        function done() {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", check);
          // The finished guard makes the timeout/ICE race resolve exactly once.
          // oxlint-disable-next-line promise/no-multiple-resolved
          resolve();
        }
        function check() {
          if (peer.iceGatheringState === "complete") done();
        }
        peer.addEventListener("icegatheringstatechange", check);
        check();
      });
      if (generation !== this.generation) return;
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/call-api`,
      );
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (generation !== this.generation) return;
        socket.send(JSON.stringify({ type: "start", token, sdp: peer.localDescription?.sdp }));
      });
      socket.addEventListener("message", (event) => {
        if (generation !== this.generation) return;
        void this.receive(event.data, peer).catch(() => {
          if (generation === this.generation)
            this.fail("Invalid call signaling. Ended the call; try again.");
        });
      });
      socket.addEventListener("error", () => {
        if (generation === this.generation)
          this.fail("Call bridge unavailable. Check the secure preview connection and try again.");
      });
      socket.addEventListener("close", (event) => {
        if (generation !== this.generation) return;
        this.fail(
          event.code === 1008
            ? "Trial access denied or expired. Get a fresh token and try again."
            : "Call bridge disconnected. Ended the call; try again.",
        );
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError")
        this.fail(
          "Microphone permission denied. Allow microphone access in browser settings, then try again.",
        );
      else if (name === "NotFoundError")
        this.fail("No microphone found. Connect a microphone and try again.");
      else
        this.fail(
          "Could not start microphone or audio connection. Check your device and try again.",
        );
    }
  }

  private async receive(raw: string, peer: RTCPeerConnection) {
    const message = JSON.parse(raw);
    if (message.type === "answer")
      await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
    if (message.type === "error") this.fail(String(message.message).slice(0, 240));
    if (message.type === "identity")
      this.update({
        identity: `${message.host} / ${message.title}\n${message.agentId}\n${message.cwd}`,
      });
    if (message.type === "pi")
      this.update({
        pi:
          message.status === "working"
            ? "Waiting for the bound Pi session..."
            : String(message.text).slice(0, 12000),
      });
    if (message.type === "transcript" && message.text)
      this.update({ transcript: String(message.text).slice(0, 2000) });
  }

  toggleMute() {
    if (!this.stream) return;
    const muted = !this.snapshot.muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
    this.update({ muted });
  }

  async playAudio() {
    const generation = this.generation;
    try {
      await this.audio.play();
      if (generation === this.generation) this.update({ playbackBlocked: false });
    } catch {
      if (generation === this.generation) this.update({ playbackBlocked: true });
    }
  }

  private fail(error: string) {
    this.cleanup();
    this.update({ status: "failed", error, muted: false, playbackBlocked: false });
  }

  end() {
    this.cleanup();
    this.update({ status: "ended", muted: false, playbackBlocked: false, error: "" });
  }

  private cleanup() {
    ++this.generation;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.peer?.close();
    this.peer = null;
    this.socket?.close();
    this.socket = null;
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
