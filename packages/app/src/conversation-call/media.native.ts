import { PermissionsAndroid, Platform } from "react-native";
import { mediaDevices, RTCPeerConnection } from "react-native-webrtc";
import InCallManager from "react-native-incall-manager";
import { nativeMicrophoneOwner } from "@/audio/microphone-owner";
import { NativeCallMedia } from "./native-media";
import type { CallMedia, MediaEvents } from "./controller";

export const supportsCalls = Platform.OS === "android";

export function createCallMedia(events: MediaEvents): CallMedia {
  return new NativeCallMedia(
    {
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
        return true;
      },
      async acquire() {
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        return {
          tracks: stream.getAudioTracks(),
          release: () => stream.release(),
          openPeer() {
            const peer = new RTCPeerConnection();
            try {
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
      startAudio() {
        InCallManager.start({ media: "audio", auto: true });
        // No proximity-driven screen-off or locked-phone call contract.
        InCallManager.stopProximitySensor();
        InCallManager.setKeepScreenOn(false);
      },
      stopAudio() {
        InCallManager.stop();
      },
    },
    events,
  );
}
