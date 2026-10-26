package sh.paseo.call

import org.junit.Assert.*
import org.junit.Test

class CallReadyToneTest {
  @Test fun canceledCallCannotPlayAndNotificationEndReleasesTheCueOnce() {
    val owner = CallOwner { _, _ -> }
    val actions = mutableListOf<String>()
    var finish: (() -> Unit)? = null
    val cue = CallReadyTone(owner, { finish = it }) {
      actions.add("create")
      object : LocalReadyTone {
        override fun play() { actions.add("play") }
        override fun release() { actions.add("release") }
      }
    }
    owner.begin("one")
    owner.end("one", "ended")
    cue.play("one")
    assertEquals(emptyList<String>(), actions)
    owner.begin("two")
    cue.play("two")
    assertEquals(listOf("create", "play"), actions)
    owner.end("two", "ended")
    finish?.invoke()
    assertEquals(listOf("create", "play", "release"), actions)
  }

  @Test fun delayedHardwareReleaseFailureDoesNotEndTheCall() {
    val owner = CallOwner { _, _ -> }
    var finish: (() -> Unit)? = null
    owner.begin("one")
    CallReadyTone(owner, { finish = it }) {
      object : LocalReadyTone {
        override fun play() {}
        override fun release() { error("device already gone") }
      }
    }.play("one")
    finish?.invoke()
    assertEquals("one", owner.activeId())
  }

  @Test fun unavailableCueDoesNotEndTheCall() {
    val owner = CallOwner { _, _ -> }
    owner.begin("one")
    CallReadyTone(owner, {}) { error("audio unavailable") }.play("one")
    assertEquals("one", owner.activeId())
  }
}
