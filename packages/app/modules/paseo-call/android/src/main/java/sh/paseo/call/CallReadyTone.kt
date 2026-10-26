package sh.paseo.call

import java.util.concurrent.atomic.AtomicBoolean

interface LocalReadyTone {
  fun play()
  fun release()
}

/** The existing native call owner can stop the local cue without a live JS runtime. */
class CallReadyTone(
  private val owner: CallOwner,
  private val scheduleRelease: (() -> Unit) -> Unit,
  private val create: () -> LocalReadyTone,
) {
  fun play(id: String) {
    if (owner.activeId() != id) return
    // A route/device that cannot play a cue must not interrupt an otherwise usable call.
    runCatching {
      owner.during(id) {
        val tone = create()
        val released = AtomicBoolean(false)
        val release: () -> Unit = {
          if (released.compareAndSet(false, true)) runCatching { tone.release() }
        }
        owner.own(id, release)
        try {
          tone.play()
          scheduleRelease(release)
        } catch (error: Exception) {
          release()
        }
      }
    }
  }
}
