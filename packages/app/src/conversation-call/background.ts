export interface CallService {
  start(callId: string): Promise<void>;
  stop(callId: string): void;
  activeId(): string | null;
  endedReason(callId: string): string | null;
  subscribe(listener: (event: { callId: string; reason: string }) => void): () => void;
  subscribeAppState(listener: (state: string) => void): () => void;
}

/** Native owns hardware; these observations only reconcile the shared call UI. */
export class BackgroundCallSession {
  private started = false;
  private dispose = () => {};
  constructor(
    private readonly callId: string,
    private readonly service: CallService,
    private readonly ended: () => void,
    private readonly failed: (message: string) => void,
  ) {}

  async start() {
    const unsubscribe = this.service.subscribe((event) => {
      if (event.callId !== this.callId) return;
      if (event.reason === "ended") this.ended();
      else
        this.failed(
          "Android stopped the call. Return to Paseo and try again. Pi work continues independently.",
        );
    });
    const unobserve = this.service.subscribeAppState((state) => {
      if (state === "active" && this.started && this.service.activeId() !== this.callId) {
        if (this.service.endedReason(this.callId) === "ended") this.ended();
        else
          this.failed(
            "Android stopped the call. Return to Paseo and try again. Pi work continues independently.",
          );
      }
    });
    this.dispose = () => {
      unsubscribe();
      unobserve();
    };
    await this.service.start(this.callId);
    if (this.service.activeId() !== this.callId) {
      if (this.service.endedReason(this.callId) === "ended") this.ended();
      throw new Error("Call ended");
    }
    this.started = true;
  }

  stop() {
    this.started = false;
    this.dispose();
    this.dispose = () => {};
    this.service.stop(this.callId);
  }
}
