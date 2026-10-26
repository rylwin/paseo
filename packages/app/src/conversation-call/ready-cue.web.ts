export interface ReadyCue {
  play(): void;
  stop(): void;
}

/** Created in the phone gesture, not after async microphone/provider negotiation. */
export function createReadyCue(): ReadyCue {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    void context.resume().catch(() => {});
  } catch {
    // Visual readiness remains available when local audio is blocked or unsupported.
  }
  return {
    play() {
      if (!context || context.state !== "running") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.11);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
    },
    stop() {
      if (context && context.state !== "closed") void context.close().catch(() => {});
      context = null;
    },
  };
}
