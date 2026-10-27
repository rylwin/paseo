package sh.paseo.call;

import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/** Queues microphone teardown through WebRTC's public, executor-backed operations. */
public final class CallMicrophoneRelease {
  private CallMicrophoneRelease() {}

  public static void release(String streamId, List<String> trackIds,
      BiConsumer<String, String> removeTrack, Consumer<String> releaseTrack,
      Consumer<String> releaseStream) {
    for (String trackId : trackIds) {
      // MediaStream.dispose() still visits attached tracks, so detach before disposing handles.
      removeTrack.accept(streamId, trackId);
      releaseTrack.accept(trackId);
    }
    releaseStream.accept(streamId);
  }
}
