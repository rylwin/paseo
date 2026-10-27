package org.webrtc;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import sh.paseo.call.CallMicrophoneRelease;
import static org.junit.Assert.*;

/** Real WebRTC Java lifetime checks; only the JNI handles and executor are isolated. */
public class CallMicrophoneReleaseTest {
  private final ArrayDeque<Runnable> executor = new ArrayDeque<>();
  private final Map<String, MediaStream> streams = new HashMap<>();
  private final Map<String, AudioTrack> tracks = new HashMap<>();
  private final List<Long> released = new ArrayList<>();

  @Before public void setUp() {
    JniCommonJni.setInstanceForTesting(new JniCommon.Natives() {
      public void addRef(long handle) {}
      public void releaseRef(long handle) { released.add(handle); }
      public ByteBuffer allocateByteBuffer(int size) { return ByteBuffer.allocateDirect(size); }
      public void freeByteBuffer(ByteBuffer buffer) {}
    });
    MediaStreamJni.setInstanceForTesting(new MediaStream.Natives() {
      public boolean addAudioTrackToNativeStream(long stream, long track) { return true; }
      public boolean addVideoTrackToNativeStream(long stream, long track) { return true; }
      public boolean removeAudioTrack(long stream, long track) { return true; }
      public boolean removeVideoTrack(long stream, long track) { return true; }
      public String getId(long stream) { return "stream"; }
    });
    MediaStream stream = new MediaStream(11L);
    AudioTrack track = new AudioTrack(21L);
    stream.audioTracks.add(track);
    streams.put("stream", stream);
    tracks.put("track", track);
  }

  @After public void tearDown() {
    JniCommonJni.setInstanceForTesting(null);
    MediaStreamJni.setInstanceForTesting(null);
  }

  private void removeTrack(String streamId, String trackId) {
    executor.add(() -> {
      MediaStream stream = streams.get(streamId);
      AudioTrack track = tracks.get(trackId);
      if (stream != null && track != null) stream.removeTrack(track);
    });
  }

  private void releaseTrack(String trackId) {
    executor.add(() -> {
      AudioTrack track = tracks.remove(trackId);
      if (track != null) track.dispose();
    });
  }

  private void releaseStream(String streamId) {
    executor.add(() -> {
      MediaStream stream = streams.remove(streamId);
      if (stream != null) stream.dispose();
    });
  }

  private void drainExecutor() {
    while (!executor.isEmpty()) executor.remove().run();
  }

  private void nativeEnd(List<String> trackIds) {
    CallMicrophoneRelease.release("stream", trackIds, this::removeTrack,
        this::releaseTrack, this::releaseStream);
  }

  @Test public void nativeEndDetachesTracksBeforeTheyAreDisposed() {
    nativeEnd(List.of("track"));
    drainExecutor();
    assertEquals(List.of(21L, 11L), released);
    assertTrue(streams.isEmpty());
    assertTrue(tracks.isEmpty());
  }

  @Test public void nativeEndDetachesEveryOwnedTrack() {
    AudioTrack second = new AudioTrack(22L);
    streams.get("stream").audioTracks.add(second);
    tracks.put("second", second);
    nativeEnd(List.of("track", "second"));
    drainExecutor();
    assertEquals(List.of(21L, 22L, 11L), released);
  }

  @Test public void nativeEndCanPrecedeJavaScriptReleaseWithoutDisposingHandlesTwice() {
    nativeEnd(List.of("track"));
    removeTrack("stream", "track");
    releaseTrack("track");
    releaseStream("stream");
    drainExecutor();
    assertEquals(List.of(21L, 11L), released);
  }

  @Test public void javaScriptDetachCanInterleaveWithNativeEnd() {
    removeTrack("stream", "track");
    nativeEnd(List.of("track"));
    releaseTrack("track");
    releaseStream("stream");
    drainExecutor();
    assertEquals(List.of(21L, 11L), released);
  }
}

