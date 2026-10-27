package sh.paseo.call

import org.junit.Assert.*
import org.junit.Test

class CallOwnerTest {
  @Test fun resumeCanDistinguishQuietHangupFromSystemFailureForTheMatchingToken() {
    val owner = CallOwner { _, _ -> }
    owner.begin("one")
    owner.end("one", "ended")
    assertEquals("ended", owner.endedReason("one"))
    assertNull(owner.endedReason("other"))
    owner.begin("two")
    owner.end("two", "destroyed")
    assertEquals("destroyed", owner.endedReason("two"))
    assertNull(owner.endedReason("one"))
  }

  @Test fun cancellationBeforeQueuedStartCannotResurrectServiceOrAudio() {
    val owner = CallOwner { _, _ -> }
    owner.begin("one")
    owner.end("one", "ended")
    assertThrows(IllegalStateException::class.java) { owner.during("one") { error("must not start") } }
    assertNull(owner.activeId())
  }

  @Test fun cancelDuringAcquisitionImmediatelyReleasesLateNativeTracks() {
    var releases = 0
    val owner = CallOwner { _, _ -> }
    owner.begin("one")
    owner.end("one", "ended")
    assertFalse(owner.own("one") { releases++ })
    assertEquals(1, releases)
  }

  @Test fun staleNotificationAndServiceDestructionCannotEndANewerCall() {
    val owner = CallOwner { _, _ -> }
    owner.begin("one")
    owner.end("one", "destroyed")
    owner.begin("two")
    owner.end("one", "ended")
    assertEquals("two", owner.activeId())
    assertThrows(IllegalStateException::class.java) { owner.begin("three") }
  }

  @Test fun destructionReleasesRemainingResourcesEvenWhenOneFails() {
    var released = false
    var ended = false
    val owner = CallOwner { _, _ -> ended = true }
    owner.begin("one")
    owner.own("one") { released = true }
    owner.own("one") { error("already disposed") }
    owner.end("one", "destroyed")
    assertTrue(released)
    assertTrue(ended)
    assertNull(owner.activeId())
  }

  @Test fun notificationEndReleasesNativeResourcesWithoutJavascript() {
    val ended = mutableListOf<String>()
    val released = mutableListOf<String>()
    val owner = CallOwner { id, reason -> ended.add("$id:$reason") }
    owner.begin("one")
    owner.own("one") { released.add("microphone") }
    owner.own("one") { released.add("peer") }
    owner.end("one", "ended")
    owner.end("one", "destroyed")
    assertNull(owner.activeId())
    assertEquals(listOf("peer", "microphone"), released)
    assertEquals(listOf("one:ended"), ended)
  }
}
