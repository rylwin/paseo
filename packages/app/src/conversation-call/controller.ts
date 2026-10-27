import type { ConversationCallEvent } from "@getpaseo/protocol/messages";
import type { CallAudioOutput } from "./native-audio";

export interface CallTarget {
  serverId: string;
  agentId: string;
  label: string;
}
export interface CallMedia {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  mute(muted: boolean): void;
  setSpeaker?(enabled: boolean): Promise<void>;
  play(): Promise<boolean>;
  stop(): void;
}
export interface MediaEvents {
  ended?(): void;
  connected(): void;
  failed(message: string): void;
  playbackBlocked(blocked: boolean): void;
  audioOutput?(state: CallAudioOutput): void;
}
export interface CallSignaling {
  supported: boolean;
  start(input: { callId: string; agentId: string; sdp: string }): Promise<{ sdp: string }>;
  end(callId: string): Promise<void>;
  subscribe(listener: (callId: string, event: ConversationCallEvent) => void): () => void;
  disconnected(listener: () => void): () => void;
}
export interface CallIdentity {
  callId: string;
  target: CallTarget;
}
interface Dependencies {
  createMedia(events: MediaEvents, identity: CallIdentity): CallMedia;
  newId(): string;
}
export type CallSnapshot =
  | { phase: "idle" }
  | {
      phase: "connecting" | "connected" | "ended" | "failed";
      target: CallTarget;
      muted: boolean;
      minimized: boolean;
      playbackBlocked: boolean;
      audioOutput: CallAudioOutput | null;
      transcript: string;
      delegation: string;
      error: string;
    };
interface ActiveCall {
  callId: string;
  signaling: CallSignaling;
  media: CallMedia;
  requested: boolean;
  unsubscribe: () => void;
}

/** Navigation is not an input. A start gesture is the only place a target is captured. */
export class ConversationCallController {
  private snapshot: CallSnapshot = { phase: "idle" };
  private readonly listeners = new Set<() => void>();
  private active: ActiveCall | null = null;

  constructor(private readonly dependencies: Dependencies) {}
  getSnapshot = (): CallSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<Exclude<CallSnapshot, { phase: "idle" }>>) {
    if (this.snapshot.phase === "idle") return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(target: CallTarget, signaling: CallSignaling): Promise<void> {
    if (this.active) return;
    const capturedTarget = { ...target };
    this.snapshot = {
      phase: "connecting",
      target: capturedTarget,
      muted: false,
      minimized: false,
      playbackBlocked: false,
      audioOutput: null,
      transcript: "",
      delegation: "",
      error: "",
    };
    this.update({});
    if (!signaling.supported) {
      this.update({
        phase: "failed",
        error: "Update the host and enable conversation calls to use GPT-Live",
      });
      return;
    }
    const callId = this.dependencies.newId();
    const media = this.dependencies.createMedia(
      {
        ended: () => {
          if (this.active?.media === media) this.end();
        },
        connected: () => {
          if (this.active?.media === media) this.update({ phase: "connected" });
        },
        failed: (message) => {
          if (this.active?.media === media) this.fail(message);
        },
        playbackBlocked: (blocked) => {
          if (this.active?.media === media) this.update({ playbackBlocked: blocked });
        },
        audioOutput: (audioOutput) => {
          if (this.active?.media === media) this.update({ audioOutput });
        },
      },
      { callId, target: capturedTarget },
    );
    const call: ActiveCall = {
      callId,
      signaling,
      media,
      requested: false,
      unsubscribe: () => {},
    };
    this.active = call;
    const unsubscribe = signaling.subscribe((eventCallId, event) => {
      if (this.active !== call || eventCallId !== call.callId) return;
      if (event.kind === "transcript") this.update({ transcript: event.text });
      if (event.kind === "delegation") this.update({ delegation: event.text });
      if (event.kind === "error") this.fail(event.message);
    });
    const disconnect = signaling.disconnected(() => {
      if (this.active === call)
        this.fail("Host disconnected. Pi may still be working; reconnect and check its status.");
    });
    call.unsubscribe = () => {
      unsubscribe();
      disconnect();
    };
    try {
      const sdp = await media.offer();
      if (this.active !== call) return;
      if (this.snapshot.muted) media.mute(true);
      call.requested = true;
      const answer = await signaling.start({
        callId: call.callId,
        agentId: capturedTarget.agentId,
        sdp,
      });
      if (this.active !== call) return;
      await media.answer(answer.sdp);
    } catch (error) {
      if (this.active !== call) return;
      this.cleanup();
      this.update({
        phase: "failed",
        error: error instanceof Error ? error.message : "Call failed. Try again.",
      });
    }
  }

  toggleMute() {
    if (!this.active || this.snapshot.phase === "idle") return;
    const muted = !this.snapshot.muted;
    this.active.media.mute(muted);
    this.update({ muted });
  }

  async toggleSpeaker() {
    const call = this.active;
    if (!call || this.snapshot.phase === "idle") return;
    const output = this.snapshot.audioOutput;
    if (!output?.canToggle || output.pending) return;
    await call.media.setSpeaker?.(output.route !== "speaker");
  }

  async play() {
    const call = this.active;
    if (!call) return;
    const played = await call.media.play();
    if (this.active === call) this.update({ playbackBlocked: !played });
  }

  toggleMinimized() {
    if (this.snapshot.phase !== "idle") this.update({ minimized: !this.snapshot.minimized });
  }

  private fail(error: string) {
    this.cleanup();
    this.update({ phase: "failed", error, muted: false, playbackBlocked: false });
  }

  dismiss() {
    if (this.active) return;
    this.snapshot = { phase: "idle" };
    for (const listener of this.listeners) listener();
  }

  end() {
    this.cleanup();
    this.update({ phase: "ended", muted: false, playbackBlocked: false, error: "" });
  }

  private cleanup() {
    const call = this.active;
    this.active = null;
    if (!call) return;
    this.update({ audioOutput: null });
    call.unsubscribe();
    call.media.stop();
    if (call.requested) void call.signaling.end(call.callId).catch(() => {});
  }
}
