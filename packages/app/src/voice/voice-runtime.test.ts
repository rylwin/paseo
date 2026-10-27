import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import type { AudioEngine } from "@/audio";
import { createVoiceRuntime, type VoiceSessionAdapter } from "@/voice/voice-runtime";
import { REALTIME_VOICE_VAD_CONFIG } from "@/voice/realtime-voice-config";

const CUE_MIME_TYPE = "audio/pcm;rate=16000;bits=16";
const THINKING_TONE_MIN_SILENCE_MS = 1500;
const SEGMENT_MIME_TYPE = "audio/pcm;rate=24000;bits=16";

function createAudioEngineMock(): AudioEngine {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    startCapture: vi.fn().mockResolvedValue(undefined),
    stopCapture: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockReturnValue(true),
    isMuted: vi.fn().mockReturnValue(false),
    play: vi.fn().mockResolvedValue(0.1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  };
}

function createSessionAdapter(serverId = "server-1"): VoiceSessionAdapter {
  return {
    serverId,
    setVoiceMode: vi.fn().mockResolvedValue(undefined),
    sendVoiceAudioChunk: vi.fn().mockResolvedValue(undefined),
    audioPlayed: vi.fn().mockResolvedValue(undefined),
    abortRequest: vi.fn().mockResolvedValue(undefined),
    setAssistantAudioPlaying: vi.fn(),
  };
}

function createAudioPayload(args: {
  id: string;
  groupId: string;
  chunkIndex: number;
  isLastChunk: boolean;
  isVoiceMode?: boolean;
}) {
  return {
    id: args.id,
    groupId: args.groupId,
    chunkIndex: args.chunkIndex,
    isLastChunk: args.isLastChunk,
    isVoiceMode: args.isVoiceMode ?? true,
    format: "pcm",
    audio: Buffer.from(`chunk-${args.chunkIndex}`).toString("base64"),
  } as const;
}

function createServerInfo(): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "1.0.0",
    capabilities: {
      voice: {
        dictation: { enabled: true, reason: "" },
        voice: { enabled: true, reason: "" },
      },
    },
  };
}

function createRuntime(options?: {
  engine?: AudioEngine;
  getServerInfo?: (serverId: string) => DaemonServerInfo | null;
}) {
  const engine = options?.engine ?? createAudioEngineMock();
  const runtime = createVoiceRuntime({
    engine,
    getServerInfo: options?.getServerInfo ?? (() => createServerInfo()),
    activateKeepAwake: vi.fn().mockResolvedValue(undefined),
    deactivateKeepAwake: vi.fn().mockResolvedValue(undefined),
  });

  return { runtime, engine };
}

describe("voice runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts voice when adapter is ready", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");

    expect(engine.initialize).toHaveBeenCalled();
    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
    expect(engine.startCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      isVoiceMode: true,
      activeServerId: "server-1",
      activeAgentId: "agent-1",
    });
  });

  it("starts an empty draft's agent without a message and discards it after a silent stop", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    const events: string[] = [];

    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => {
        events.push("created");
        return "agent-1";
      },
      onCommit: () => events.push("committed"),
      discardAgent: async (agentId) => {
        events.push(`discarded:${agentId}`);
      },
    });

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      activeAgentId: "agent-1",
    });
    expect(runtime.isVoiceModeForAgent("server-1", "draft-1")).toBe(true);
    runtime.onTranscriptionResult("server-1", "   ");
    await runtime.stopVoice();
    expect(events).toEqual(["created", "discarded:agent-1"]);
  });

  it("keeps a draft on its first spoken input and hands it off only once", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    const events: string[] = [];
    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => events.push("committed"),
      discardAgent: async () => {
        events.push("discarded");
      },
    });

    runtime.onTranscriptionResult("other-server", "unrelated dictation");
    expect(events).toEqual([]);
    runtime.onTranscriptionResult("server-1", "hello");
    runtime.onTranscriptionResult("server-1", "another message");
    await runtime.stopVoice();
    expect(events).toEqual(["committed"]);
  });

  it("discards a temporary agent when microphone capture fails", async () => {
    const engine = createAudioEngineMock();
    engine.startCapture = async () => {
      throw new Error("Microphone denied");
    };
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(createSessionAdapter());
    const discarded: string[] = [];
    await expect(
      runtime.startVoice("server-1", "draft-1", {
        createAgent: async () => "agent-1",
        onCommit: () => {},
        discardAgent: async (agentId) => {
          discarded.push(agentId);
        },
      }),
    ).rejects.toThrow("Microphone denied");
    expect(discarded).toEqual(["agent-1"]);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("does not enable voice if cancelled while its draft agent is being created", async () => {
    const { runtime } = createRuntime();
    const adapter = createSessionAdapter();
    const enabledAgents: string[] = [];
    adapter.setVoiceMode = async (enabled, agentId) => {
      if (enabled) enabledAgents.push(agentId!);
    };
    runtime.registerSession(adapter);
    let finishCreate!: (agentId: string) => void;
    let creationStarted!: () => void;
    const creating = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const discarded: string[] = [];
    const start = runtime.startVoice("server-1", "draft-1", {
      createAgent: () => {
        creationStarted();
        return new Promise<string>((resolve) => {
          finishCreate = resolve;
        });
      },
      onCommit: () => {},
      discardAgent: async (agentId) => {
        discarded.push(agentId);
      },
    });
    await creating;
    await runtime.stopVoice();
    finishCreate("agent-1");
    await start;
    expect(enabledAgents).toEqual([]);
    expect(discarded).toEqual(["agent-1"]);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("discards a silent draft when switching voice to another chat", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    const discarded: string[] = [];
    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => {},
      discardAgent: async (agentId) => {
        discarded.push(agentId);
      },
    });
    await runtime.startVoice("server-1", "agent-2");
    expect(discarded).toEqual(["agent-1"]);
    expect(runtime.getSnapshot().activeAgentId).toBe("agent-2");
    await runtime.stopVoice();
    expect(discarded).toEqual(["agent-1"]);
  });

  it("keeps the draft if its agent starts work before the transcript is observed", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    const events: string[] = [];
    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => {
        events.push("committed");
      },
      discardAgent: async () => {
        events.push("discarded");
      },
    });
    runtime.onTurnEvent("server-1", "other-agent", "turn_started");
    expect(events).toEqual([]);
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    await runtime.stopVoice();
    expect(events).toEqual(["committed"]);
  });

  it("preserves a draft on connection loss because a submitted transcript may not have arrived", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    const events: string[] = [];
    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => {
        events.push("committed");
      },
      discardAgent: async () => {
        events.push("discarded");
      },
    });
    runtime.updateSessionConnection("server-1", false);
    await runtime.stopVoice();
    expect(events).toEqual(["committed"]);
  });

  it("ignores repeated start gestures while a draft is being prepared", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    let finishCreate!: (agentId: string) => void;
    let creationStarted!: () => void;
    const creating = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    let creates = 0;
    const draft = {
      createAgent: async () => {
        creates++;
        if (creates > 1) return "duplicate-agent";
        creationStarted();
        return new Promise<string>((resolve) => {
          finishCreate = resolve;
        });
      },
      onCommit: () => {},
      discardAgent: async () => {},
    };
    const start = runtime.startVoice("server-1", "draft-1", draft);
    await creating;
    await runtime.startVoice("server-1", "draft-1", draft);
    finishCreate("agent-1");
    await start;
    expect(creates).toBe(1);
    expect(runtime.getSnapshot().activeAgentId).toBe("agent-1");
    await runtime.stopVoice();
  });

  it("does not revive a draft start after its host session is removed", async () => {
    const { runtime } = createRuntime();
    const unregister = runtime.registerSession(createSessionAdapter());
    let finishCreate!: (agentId: string) => void;
    let creationStarted!: () => void;
    const creating = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const discarded: string[] = [];
    const start = runtime.startVoice("server-1", "draft-1", {
      createAgent: () => {
        creationStarted();
        return new Promise<string>((resolve) => {
          finishCreate = resolve;
        });
      },
      onCommit: () => {},
      discardAgent: async (agentId) => {
        discarded.push(agentId);
      },
    });
    await creating;
    const stopped = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe(() => {
        if (runtime.getSnapshot().phase === "disabled") {
          unsubscribe();
          resolve();
        }
      });
    });
    unregister();
    await stopped;
    finishCreate("agent-1");
    await start;
    expect(runtime.getSnapshot().phase).toBe("disabled");
    expect(discarded).toEqual(["agent-1"]);
  });

  it("retains a listening draft when its host is removed without a final transcript", async () => {
    const { runtime } = createRuntime();
    const unregister = runtime.registerSession(createSessionAdapter());
    const events: string[] = [];
    await runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => {
        events.push("committed");
      },
      discardAgent: async () => {
        events.push("discarded");
      },
    });
    const stopped = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe(() => {
        if (runtime.getSnapshot().phase === "disabled") {
          unsubscribe();
          resolve();
        }
      });
    });
    unregister();
    await stopped;
    expect(events).toEqual(["committed"]);
  });

  it("does not restart capture after cancellation during voice activation", async () => {
    const adapter = createSessionAdapter();
    let finishEnable!: () => void;
    let activationStarted!: () => void;
    const activating = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    adapter.setVoiceMode = async (enabled) => {
      if (!enabled) return;
      activationStarted();
      await new Promise<void>((resolve) => {
        finishEnable = resolve;
      });
    };
    let captures = 0;
    const engine = createAudioEngineMock();
    engine.startCapture = async () => {
      captures++;
    };
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);
    const start = runtime.startVoice("server-1", "draft-1", {
      createAgent: async () => "agent-1",
      onCommit: () => {},
      discardAgent: async () => {},
    });
    await activating;
    await runtime.stopVoice();
    finishEnable();
    await start;
    expect(captures).toBe(0);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("does not tear down a newer chat if a cancelled draft creation later fails", async () => {
    const { runtime } = createRuntime();
    runtime.registerSession(createSessionAdapter());
    let failCreate!: (error: Error) => void;
    let creationStarted!: () => void;
    const creating = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const start = runtime.startVoice("server-1", "draft-1", {
      createAgent: () => {
        creationStarted();
        return new Promise<string>((_resolve, reject) => {
          failCreate = reject;
        });
      },
      onCommit: () => {},
      discardAgent: async () => {},
    });
    await creating;
    await runtime.stopVoice();
    await runtime.startVoice("server-1", "agent-2");
    failCreate(new Error("Creation failed"));
    await expect(start).rejects.toThrow("Creation failed");
    expect(runtime.getSnapshot()).toMatchObject({ phase: "listening", activeAgentId: "agent-2" });
    await runtime.stopVoice();
  });

  it("streams continuous PCM chunks and waits after receiving a transcript", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCapturePcm(new Uint8Array(32000));
    expect(runtime.getSnapshot().phase).toBe("listening");

    expect(adapter.sendVoiceAudioChunk).toHaveBeenLastCalledWith(
      expect.any(String),
      "audio/pcm;rate=16000;bits=16",
    );

    runtime.onTranscriptionResult("server-1", "hello");
    expect(runtime.getSnapshot().phase).toBe("waiting");
  });

  it("moves from listening to playing on the first assistant audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine: _engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    expect(runtime.getSnapshot().phase).toBe("playing");
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(true);
  });

  it("starts playback on the first chunk before isLastChunk arrives", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().phase).toBe("playing");
      expect(adapter.audioPlayed).not.toHaveBeenCalled();
    });

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.play).toHaveBeenCalledTimes(1);
    resolvePlay(0.1);

    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });
  });

  it("acknowledges chunks only after they are consumed and finishes after the final chunk", async () => {
    const adapter = createSessionAdapter();
    const playResolvers: Array<(duration: number) => void> = [];
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          playResolvers.push(resolve);
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();
    playResolvers.length = 0;

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });
    expect(adapter.audioPlayed).not.toHaveBeenCalled();

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-1");
      expect(runtime.getSnapshot().phase).toBe("waiting");
    });
  });

  it("leaves playback phase unchanged after assistant playback while the turn is still active", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    expect(engine.play).toHaveBeenCalled();
  });

  it("starts the thinking tone once the wait for a reply outlasts an inter-segment gap", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS - 1);
    expect(engine.play).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(engine.play).toHaveBeenCalled();
  });

  it("does not restart the thinking tone from local detection jitter while waiting", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    expect(engine.play).toHaveBeenCalledTimes(1);
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(REALTIME_VOICE_VAD_CONFIG.volumeThreshold + 0.05);
    runtime.handleCaptureVolume(0);

    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.clearQueue).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.clearQueue).not.toHaveBeenCalled();
    expect(vi.mocked(engine.play).mock.calls[0][1]?.aborted).toBe(true);

    resolvePlay(0.1);
  });

  it("does not play the thinking tone in the gap between two segments of one reply", async () => {
    const adapter = createSessionAdapter();
    const engine = createAudioEngineMock();
    const played: string[] = [];
    vi.mocked(engine.play).mockImplementation(async (source: { type: string }) => {
      played.push(source.type);
      return 0.1;
    });
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "seg-1-chunk-0",
        groupId: "seg-1",
        chunkIndex: 0,
        isLastChunk: true,
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe("waiting");
    });

    await vi.advanceTimersByTimeAsync(400);

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "seg-2-chunk-0",
        groupId: "seg-2",
        chunkIndex: 0,
        isLastChunk: true,
      }),
    );
    await vi.waitFor(() => {
      expect(played).toContain(SEGMENT_MIME_TYPE);
    });

    const replyStart = played.indexOf(SEGMENT_MIME_TYPE);
    expect(replyStart).toBeGreaterThanOrEqual(0);
    expect(played.slice(replyStart).filter((type) => type === CUE_MIME_TYPE)).toEqual([]);
  });

  it("returns to listening after assistant playback once the turn is complete", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    await vi.advanceTimersByTimeAsync(THINKING_TONE_MIN_SILENCE_MS);
    runtime.onAssistantAudioStarted("server-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_completed");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("listening");
    expect(engine.play).toHaveBeenCalled();
  });

  it("keeps local volume alone non-authoritative for playback interruption", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(0.5);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("playing");
  });

  it("keeps the meter white state driven by server speech detection", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCaptureVolume(0.7);

    expect(runtime.getTelemetrySnapshot()).toMatchObject({
      volume: expect.any(Number),
      isSpeaking: false,
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);

    runtime.onServerSpeechStateChanged("server-1", false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
  });

  it("stops assistant playback immediately when server speech starts", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);
  });

  it("drops queued voice chunks that arrive after server speech interrupts playback", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(vi.mocked(adapter.audioPlayed).mock.calls.flat()).not.toContain("chunk-1");
  });

  it("authoritatively stops and suppresses later voice audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    await runtime.stopVoice();

    expect(adapter.setVoiceMode).toHaveBeenLastCalledWith(false);
    expect(engine.stopCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("disabled");
    expect(runtime.shouldPlayVoiceAudio("server-1")).toBe(false);
  });

  it("rolls daemon voice mode back when capture fails after enabling it", async () => {
    const adapter = createSessionAdapter();
    const engine = createAudioEngineMock();
    vi.mocked(engine.startCapture).mockRejectedValue(new Error("audio focus unavailable"));
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "audio focus unavailable",
    );

    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(1, true, "agent-1");
    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(2, false);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("returns an explicit not-ready error when the adapter is missing", async () => {
    const { runtime } = createRuntime();
    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "Voice runtime is not ready for host server-1",
    );
  });

  it("resyncs voice mode after connection recovers", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    vi.mocked(adapter.setVoiceMode).mockClear();

    runtime.updateSessionConnection("server-1", false);
    runtime.updateSessionConnection("server-1", true);
    await Promise.resolve();

    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
  });

  it("does not emit when the snapshot is unchanged", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);
    await runtime.startVoice("server-1", "agent-1");

    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    runtime.handleCaptureVolume(0);
    runtime.handleCaptureVolume(0);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
