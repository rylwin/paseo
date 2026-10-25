export function createMicrophoneOwner() {
  let owner: object | null = null;
  return {
    acquire() {
      if (owner)
        throw new Error(
          "Microphone is in use. End dictation, voice mode, or the call before trying again.",
        );
      const token = {};
      owner = token;
      return () => {
        if (owner === token) owner = null;
      };
    },
  };
}

export const nativeMicrophoneOwner = createMicrophoneOwner();
