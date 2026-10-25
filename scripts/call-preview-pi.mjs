export const TRIAL_AGENT = "e60df84c-20d9-4629-af7c-5f1b60ae5f24";
export const TRIAL_TITLE = "PHONE-CALL-PASEO-CODING";
export const TRIAL_CWD = "/tmp/paseo-call-prototype-20260719";

/** The target is operator-bound, never supplied by the model or browser. */
export class BoundPiSession {
  constructor(execute, signal, now = () => new Date().toISOString()) {
    this.execute = execute;
    this.signal = signal;
    this.now = now;
    this.since = null;
  }

  async status() {
    const result = await this.execute("paseo", ["inspect", TRIAL_AGENT, "--json"], {
      timeout: 30000,
      maxBuffer: 256 * 1024,
      signal: this.signal,
    });
    const state = JSON.parse(result.stdout);
    const since = this.since ? ["--since", this.since] : [];
    const answer = await this.execute(
      "paseo",
      ["logs", TRIAL_AGENT, ...since, "--filter", "assistant_message", "--tail", "20", "--json"],
      { timeout: 30000, maxBuffer: 256 * 1024, signal: this.signal },
    );
    return {
      success: true,
      text: `Pi status: ${state.Status}. Pending permissions: ${state.PendingPermissions?.length ?? 0}. Latest assistant reply: ${answer.stdout.trim()}`,
    };
  }

  async request(instruction) {
    this.since = this.now();
    const sent = await this.execute(
      "paseo",
      ["send", TRIAL_AGENT, `--prompt=${instruction}`, "--behavior", "steer", "--json"],
      { timeout: 90000, maxBuffer: 256 * 1024, signal: this.signal },
    );
    const status = JSON.parse(sent.stdout).status;
    if (status !== "completed")
      return {
        success: false,
        text: `Pi request status: ${String(status).slice(0, 40)}. The task may still be active; ask for status or resolve permissions in Paseo.`,
      };
    const answer = await this.execute(
      "paseo",
      [
        "logs",
        TRIAL_AGENT,
        "--since",
        this.since,
        "--filter",
        "assistant_message",
        "--tail",
        "20",
        "--json",
      ],
      { timeout: 30000, maxBuffer: 256 * 1024, signal: this.signal },
    );
    const text = answer.stdout.trim();
    if (!text || text === "No activity to display.")
      return {
        success: false,
        text: "Pi completed but no fresh assistant reply is available. Ask for status; do not assume success.",
      };
    return { success: true, text: `Pi replied: ${text}`.slice(0, 12000) };
  }
}
