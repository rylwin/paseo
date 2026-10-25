export function bindForegroundCall(input: {
  subscribe(listener: (state: string) => void): () => void;
  getPhase(): string;
  end(): void;
}): () => void {
  return input.subscribe((state) => {
    const phase = input.getPhase();
    if (state !== "active" && (phase === "connecting" || phase === "connected")) input.end();
  });
}
