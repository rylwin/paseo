import type { ConversationCallEvent } from "@getpaseo/protocol/messages";
import type { HistoryInput, HistoryPage } from "./conversation-call-history.js";
import type { BriefingGenerator } from "./conversation-call-briefing.js";
import type { SessionDelivery } from "./owned-subscriptions/index.js";

export interface CallAgent {
  title: string;
  cwd: string;
  request(instruction: string, signal: AbortSignal): Promise<string>;
  status(signal: AbortSignal): Promise<string>;
  history(input: HistoryInput, signal: AbortSignal): Promise<HistoryPage>;
  subscribe?(onChange: () => void): () => void;
}
export interface CallProvider {
  start(sdp: string): Promise<string>;
  stop(): Promise<void>;
}
export interface CallProviderOptions {
  agent: CallAgent;
  briefing?: BriefingGenerator;
  scheduleBriefingTimeout?(expire: () => void): () => void;
  /** Validated live user/assistant speech transcripts, never tool or history text. */
  onConversationActivity?(): void;
  emit(event: ConversationCallEvent): void;
  signal: AbortSignal;
}
interface Dependencies {
  delivery: SessionDelivery;
  resolveAgent(agentId: string): Promise<CallAgent>;
  createProvider(options: CallProviderOptions): CallProvider;
  scheduleEnd?(expired: () => Promise<void>): () => void;
}

/** A conversation call belongs to its originating physical socket, not the focused agent. */
export class ConversationCalls {
  private readonly active = new Map<object, { callId: string; release(): Promise<void> }>();

  constructor(private readonly dependencies: Dependencies) {}

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map((call) => call.release()));
  }

  async end(callId: string): Promise<void> {
    const source = this.dependencies.delivery.currentSource;
    const call = source && this.active.get(source);
    if (!call || call.callId !== callId) throw new Error("Call is not owned by this connection");
    await call.release();
  }

  async start(input: { callId: string; agentId: string; sdp: string }): Promise<string> {
    const source = this.dependencies.delivery.currentSource;
    if (!source) throw new Error("Call requires an authenticated connection");
    if (this.active.has(source)) throw new Error("A call is already active on this connection");
    let provider: CallProvider | null = null;
    let cancelDeadline = () => {};
    const owner = this.dependencies.delivery.operation(
      (message) =>
        message.type === "conversation.call.event" && message.payload.callId === input.callId,
      async () => {
        this.active.delete(source);
        cancelDeadline();
        if (provider) await provider.stop();
      },
    );
    this.active.set(source, { callId: input.callId, release: owner.release });
    const schedule =
      this.dependencies.scheduleEnd ??
      ((expired: () => Promise<void>) => {
        const timer = setTimeout(
          () => {
            void expired();
          },
          10 * 60 * 1000,
        );
        timer.unref();
        return () => clearTimeout(timer);
      });
    let ready = false;
    let deadlineGeneration = 0;
    const resetIdleDeadline = () => {
      cancelDeadline();
      if (!ready || owner.signal.aborted) return;
      const generation = ++deadlineGeneration;
      cancelDeadline = schedule(async () => {
        if (owner.signal.aborted || generation !== deadlineGeneration) return;
        owner.emit({
          type: "conversation.call.event",
          payload: {
            callId: input.callId,
            event: {
              kind: "error",
              message:
                "Call ended after ten minutes without conversation. Pi keeps working; you can call again.",
            },
          },
        });
        await owner.release();
      });
    };
    try {
      const agent = await this.dependencies.resolveAgent(input.agentId);
      owner.signal.throwIfAborted();
      const resolveAgent = this.dependencies.resolveAgent;
      const boundAgent: CallAgent = {
        title: agent.title,
        cwd: agent.cwd,
        subscribe: agent.subscribe?.bind(agent),
        async request(instruction, signal) {
          signal.throwIfAborted();
          const current = await resolveAgent(input.agentId);
          signal.throwIfAborted();
          return current.request(instruction, signal);
        },
        async history(options, signal) {
          signal.throwIfAborted();
          const current = await resolveAgent(input.agentId);
          signal.throwIfAborted();
          return current.history(options, signal);
        },
        async status(signal) {
          signal.throwIfAborted();
          const current = await resolveAgent(input.agentId);
          signal.throwIfAborted();
          return current.status(signal);
        },
      };
      provider = this.dependencies.createProvider({
        agent: boundAgent,
        signal: owner.signal,
        onConversationActivity: resetIdleDeadline,
        emit: (event) => {
          owner.emit({ type: "conversation.call.event", payload: { callId: input.callId, event } });
          if (event.kind === "error") void owner.release();
        },
      });
      const answer = await provider.start(input.sdp);
      owner.signal.throwIfAborted();
      ready = true;
      resetIdleDeadline();
      return answer;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
}
