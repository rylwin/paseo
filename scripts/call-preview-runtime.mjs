import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readMarker, validateTool } from "./call-preview.mjs";

const exec = promisify(execFile);
export const TRIAL_AGENT = "68ed6457-f8bd-4340-98cc-b50f50209414";
const instructions =
  "You are the control agent for an isolated voice trial. Never use shell, filesystem, network, or other agents. The only allowed action is paseo_pi_marker with empty arguments, when asked for the harmless Pi marker test. Report its actual answer. All other requests must be declined. The host is titanium and the fixed Pi session is PHONE-CALL-TRIAL-MARKER-ONLY.";

/** One owned process per authenticated socket. No Codex credentials cross this boundary. */
export class TrialCall {
  constructor(send) {
    this.send = send;
    this.pending = new Map();
    this.sequence = 0;
    this.stopped = false;
    this.toolBusy = false;
    this.cliAbort = new AbortController();
  }

  write(message) {
    if (!this.stopped && this.child?.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  request(method, params) {
    if (this.stopped) return Promise.reject(new Error("Call ended"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Provider timed out. End the call and try again."));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async start(sdp) {
    this.child = spawn(
      "codex",
      [
        "app-server",
        "--enable",
        "realtime_conversation",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "shell_snapshot",
        "-c",
        "mcp_servers={}",
        "-c",
        'web_search="disabled"',
        "-c",
        "analytics.enabled=false",
      ],
      {
        cwd: new URL("..", import.meta.url),
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      },
    );
    this.child.on("error", () =>
      this.fail("Could not launch Codex. Check the local installation."),
    );
    this.child.on("exit", () => {
      if (!this.stopped) this.fail("Codex disconnected. End the call and try again.");
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {
        this.fail("Invalid provider response. End the call and try again.");
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "paseo-phone-call-trial", version: "0.1" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
    const models = await this.request("model/list", {});
    const model = models.data.find((entry) => entry.isDefault)?.model;
    if (!model) throw new Error("No default Codex model available.");
    const result = await this.request("thread/start", {
      cwd: new URL("..", import.meta.url).pathname,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      model,
      baseInstructions: instructions,
      developerInstructions: instructions,
      dynamicTools: [
        {
          type: "function",
          name: "paseo_pi_marker",
          description:
            "Run the harmless marker test against the one isolated Pi session and return its actual answer. No other operations are permitted.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    this.threadId = result.thread.id;
    if (this.stopped) return;
    await this.request("thread/realtime/start", {
      threadId: this.threadId,
      version: "v3",
      model: "gpt-live-1-codex",
      voice: "cove",
      outputModality: "audio",
      transport: { type: "webrtc", sdp },
      includeStartupContext: false,
      delegationAckFiller: false,
      realtimeStartInstructions: instructions,
    });
  }

  receive(message) {
    if (this.stopped) return;
    if (!message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error)
        waiter.reject(
          new Error("Codex rejected the request. Check login and GPT-Live entitlement locally."),
        );
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      void this.handleRequest(message).catch(() =>
        this.fail("Pi marker operation failed. End the call and try again."),
      );
      return;
    }
    const params = message.params ?? {};
    if (message.method === "thread/realtime/sdp") this.send({ type: "answer", sdp: params.sdp });
    if (message.method === "thread/realtime/transcript/done") {
      this.send({
        type: "transcript",
        text: String(params.text ?? params.transcript ?? "").slice(0, 2000),
        role: params.role,
      });
    }
    if (message.method === "thread/realtime/error")
      this.fail("GPT-Live reported a call error. End the call and try again.");
    if (message.method === "thread/realtime/closed")
      this.fail("GPT-Live ended the call. You can call again.");
  }

  async handleRequest(message) {
    let args = message.params?.arguments;
    try {
      if (typeof args === "string") args = JSON.parse(args);
    } catch {
      args = null;
    }
    if (
      message.method !== "item/tool/call" ||
      !validateTool(message.params?.tool, args) ||
      this.toolBusy
    ) {
      this.write({
        id: message.id,
        error: { code: -32601, message: "Operation not allowed in fixed marker trial" },
      });
      return;
    }
    this.toolBusy = true;
    this.send({ type: "pi", status: "working" });
    let success = false;
    let text = "Pi did not return the fresh marker. No success is confirmed.";
    try {
      const marker = `PI_CONTROL_OK_${randomBytes(4).toString("hex")}`;
      const options = { timeout: 90000, maxBuffer: 256 * 1024, signal: this.cliAbort.signal };
      // argv only: no model text, shell interpolation, or caller-selected target.
      const sent = await exec(
        "paseo",
        [
          "send",
          TRIAL_AGENT,
          `Reply exactly ${marker}. Do not use tools or change files.`,
          "--json",
        ],
        options,
      );
      if (JSON.parse(sent.stdout).status === "completed") {
        const logs = await exec("paseo", ["logs", TRIAL_AGENT, "--tail", "3", "--json"], options);
        success = readMarker(logs.stdout, marker);
        if (success) text = `Pi agent answered: ${marker}`;
      }
    } catch {
      text = "Pi marker test failed or timed out. No success is confirmed.";
    } finally {
      this.toolBusy = false;
    }
    if (this.stopped) return;
    this.send({ type: "pi", status: success ? "answered" : "failed", text });
    this.write({
      id: message.id,
      result: { success, contentItems: [{ type: "inputText", text }] },
    });
  }

  fail(message) {
    if (this.stopped) return;
    this.send({ type: "error", message });
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    if (this.threadId)
      this.write({
        id: ++this.sequence,
        method: "thread/realtime/stop",
        params: { threadId: this.threadId },
      });
    this.stopped = true;
    this.cliAbort.abort();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Call ended"));
    }
    this.pending.clear();
    this.lines?.close();
    const child = this.child;
    if (child?.pid) {
      const kill = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already exited. */
        }
      };
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 1500);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
}
