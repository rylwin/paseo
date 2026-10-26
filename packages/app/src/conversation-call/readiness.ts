import { z } from "zod";

const SessionEvent = z.object({
  type: z.string(),
  session: z.object({ status: z.string() }).optional(),
});

/** GPT-Live's data channel announces input readiness independently of ICE/DTLS. */
export class CallReadiness {
  private peer = false;
  private channel = false;
  private session = false;
  private announced = false;
  private stopped = false;

  constructor(
    private readonly ready: () => void,
    private readonly failed: (message: string) => void,
  ) {}

  peerConnected() {
    this.peer = true;
    this.check();
  }

  channelOpened() {
    this.channel = true;
    this.check();
  }

  message(data: unknown) {
    if (typeof data !== "string" || this.stopped) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = SessionEvent.safeParse(decoded);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "error" || event.type === "session.error") {
      this.channelError();
      return;
    }
    if (event.type === "session.started" && event.session?.status === "active") {
      this.session = true;
      this.check();
    }
  }

  stop() {
    this.stopped = true;
  }

  channelClosed() {
    this.fail("Voice session closed. Try calling again; Pi work is unchanged.");
  }

  channelError() {
    this.fail("Voice session failed to connect. Try calling again.");
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.failed(message);
  }

  private check() {
    if (this.stopped || this.announced || !this.peer || !this.channel || !this.session) return;
    this.announced = true;
    this.ready();
  }
}
