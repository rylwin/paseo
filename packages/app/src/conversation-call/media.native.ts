import {
  AppRegistry,
  AppState,
  DeviceEventEmitter,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { MediaStream, MediaStreamTrack, RTCPeerConnection } from "react-native-webrtc";
import InCallManager from "react-native-incall-manager";
import { nativeMicrophoneOwner } from "@/audio/microphone-owner";
import { NativeCallMedia } from "./native-media";
import { NativeCallAudio } from "./native-audio";
import type { CallIdentity, CallMedia, MediaEvents } from "./controller";
import { BackgroundCallSession } from "./background";

interface StreamInfo {
  streamId: string;
  streamReactTag: string;
  tracks: ConstructorParameters<typeof MediaStreamTrack>[0][];
}
interface NativeCallService {
  prepare(id: string): void;
  start(id: string, label: string, route: string): Promise<void>;
  stop(id: string): void;
  activeId(): string | null;
  endedReason(id: string): string | null;
  startAudio(id: string): void;
  acquire(id: string): Promise<StreamInfo>;
  ownPeer(id: string, peerId: number): void;
  addListener(
    name: "ended",
    listener: (event: { callId: string; reason: string }) => void,
  ): { remove(): void };
}
const native =
  Platform.OS === "android" ? requireOptionalNativeModule<NativeCallService>("PaseoCall") : null;
export const supportsCalls = Platform.OS === "android" && native !== null;

if (native) {
  const service = native;
  // No new connection or redial: this task only keeps the current runtime's timers eligible.
  AppRegistry.registerHeadlessTask(
    "PaseoCall",
    () =>
      ({ callId }: { callId: string }) =>
        new Promise<void>((resolve) => {
          const subscription = service.addListener("ended", (event) => {
            if (event.callId !== callId) return;
            subscription.remove();
            resolve();
          });
          if (service.activeId() !== callId) {
            subscription.remove();
            resolve();
          }
        }),
  );
}

export function createCallMedia(events: MediaEvents, identity: CallIdentity): CallMedia {
  if (!native) throw new Error("Rebuild Paseo with Android call support.");
  const service = native;
  const { callId, target } = identity;
  const background = new BackgroundCallSession(
    callId,
    {
      start: (id) => {
        service.prepare(id);
        return service.start(
          id,
          target.label,
          `paseo:///h/${encodeURIComponent(target.serverId)}/agent/${encodeURIComponent(target.agentId)}`,
        );
      },
      stop: (id) => service.stop(id),
      activeId: () => service.activeId(),
      endedReason: (id) => service.endedReason(id),
      subscribe(listener) {
        const subscription = service.addListener("ended", listener);
        return () => subscription.remove();
      },
      subscribeAppState(listener) {
        const subscription = AppState.addEventListener("change", listener);
        return () => subscription.remove();
      },
    },
    () => events.ended?.(),
    (message) => events.failed(message),
  );
  const audio = new NativeCallAudio(
    {
      start: () => service.startAudio(callId),
      stop: () => {}, // The native owner restores routing even if JS is suspended.
      setDefaultAudioRoute: (route) => InCallManager.setDefaultAudioRoute(route),
      stopProximitySensor: () => InCallManager.stopProximitySensor(),
      setKeepScreenOn: (enabled) => InCallManager.setKeepScreenOn(enabled),
    },
    (listener) => {
      const subscription = DeviceEventEmitter.addListener("onAudioDeviceChanged", listener);
      return () => subscription.remove();
    },
    (state) => events.audioOutput?.(state),
  );
  return new NativeCallMedia(
    {
      background,
      reserveMicrophone: () => nativeMicrophoneOwner.acquire(),
      schedule(callback, ms) {
        const timeout = setTimeout(callback, ms);
        return () => clearTimeout(timeout);
      },
      async requestPermission() {
        const granted =
          (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) ===
          PermissionsAndroid.RESULTS.GRANTED;
        if (!granted) return false;
        if (Number(Platform.Version) >= 31) {
          // Optional: denial leaves Android's wired/earpiece routing available.
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
        }
        if (
          Number(Platform.Version) >= 33 &&
          (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) !==
            PermissionsAndroid.RESULTS.GRANTED
        ) {
          throw new Error(
            "Enable Paseo call notifications in Android settings, then try again. The call has not started.",
          );
        }
        return true;
      },
      async acquire() {
        // Native acquisition registers ownership before returning any track to JavaScript.
        const stream = new MediaStream(await service.acquire(callId));
        return {
          tracks: stream.getAudioTracks(),
          release: () => stream.release(),
          openPeer() {
            const peer = new RTCPeerConnection();
            try {
              // Explicit app-maintained WebRTC extension; never reflect into its track registry.
              service.ownPeer(callId, peer.nativePeerConnectionId);
              peer.createDataChannel("realtime-events");
              stream.getTracks().forEach((track) => peer.addTrack(track, stream));
              // Native WebRTC renders received audio directly; no DOM audio element.
              return peer;
            } catch (error) {
              peer.close();
              throw error;
            }
          },
        };
      },
      startAudio: () => audio.start(),
      stopAudio: () => audio.stop(),
      setSpeaker: (enabled) => audio.setSpeaker(enabled),
    },
    events,
  );
}
