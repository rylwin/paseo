export interface NativeAudioStatus {
  selectedAudioDevice: string;
  availableAudioDeviceList: string;
}
export interface CallAudioOutput {
  route: "speaker" | "earpiece" | "headset" | "unknown";
  canToggle: boolean;
  pending: boolean;
  error: string;
}
interface NativeAudioManager {
  start(setup: { media: "video"; auto: true }): void;
  stop(): void;
  stopProximitySensor(): void;
  setKeepScreenOn(enabled: boolean): void;
  setDefaultAudioRoute(route: "SPEAKER_PHONE" | "EARPIECE"): Promise<NativeAudioStatus>;
}

/** Changes the fallback, never a forced/user-selected route, so headsets retain priority. */
export class NativeCallAudio {
  private stopped = false;
  private removeListener = () => {};
  private state: CallAudioOutput = {
    route: "unknown",
    canToggle: false,
    pending: false,
    error: "",
  };
  constructor(
    private readonly manager: NativeAudioManager,
    private readonly subscribe: (listener: (status: NativeAudioStatus) => void) => () => void,
    private readonly changed: (state: CallAudioOutput) => void,
  ) {}
  private publish(patch: Partial<CallAudioOutput>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private report = (status: NativeAudioStatus) => {
    let available: unknown = [];
    try {
      available = JSON.parse(status.availableAudioDeviceList);
    } catch {
      /* Unknown route stays unavailable. */
    }
    const devices = Array.isArray(available) ? available : [];
    const selected = status.selectedAudioDevice;
    let route: CallAudioOutput["route"] = "unknown";
    if (selected === "SPEAKER_PHONE") route = "speaker";
    if (selected === "EARPIECE") route = "earpiece";
    if (selected === "BLUETOOTH" || selected === "WIRED_HEADSET") route = "headset";
    this.publish({
      route,
      canToggle:
        (route === "speaker" || route === "earpiece") &&
        devices.includes("SPEAKER_PHONE") &&
        devices.includes("EARPIECE") &&
        !devices.includes("BLUETOOTH") &&
        !devices.includes("WIRED_HEADSET"),
    });
  };
  start() {
    this.removeListener = this.subscribe(this.report);
    // The video preset means speaker fallback, not camera capture. Automatic routing
    // remains Bluetooth > wired > fallback in InCallManager 4.3.0.
    this.manager.start({ media: "video", auto: true });
    this.manager.stopProximitySensor();
    this.manager.setKeepScreenOn(false);
  }
  async setSpeaker(enabled: boolean) {
    if (this.stopped || !this.state.canToggle || this.state.pending) return;
    this.publish({ pending: true, error: "" });
    try {
      this.report(await this.manager.setDefaultAudioRoute(enabled ? "SPEAKER_PHONE" : "EARPIECE"));
      this.publish({ pending: false });
    } catch {
      this.publish({ pending: false, error: "Could not change audio output. Try again." });
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.removeListener();
    // Restores the original audio mode/speaker/mic setup and abandons call focus.
    this.manager.stop();
  }
}
