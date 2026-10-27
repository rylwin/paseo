package sh.paseo.call

/** Process-local ownership only. Never restores or redials a call after process death. */
class CallOwner(private val ended: (String, String) -> Unit) {
  private var id: String? = null
  private var lastEnd: Pair<String, String>? = null
  private val resources = mutableListOf<() -> Unit>()

  @Synchronized fun begin(callId: String) {
    check(id == null) { "Another call is active" }
    id = callId
  }

  @Synchronized fun activeId(): String? = id

  @Synchronized fun endedReason(callId: String): String? =
    lastEnd?.takeIf { it.first == callId }?.second

  @Synchronized fun <T> during(callId: String, action: () -> T): T {
    check(id == callId) { "Call ended" }
    return action()
  }

  @Synchronized fun own(callId: String, release: () -> Unit): Boolean {
    if (id != callId) {
      release()
      return false
    }
    resources.add(release)
    return true
  }

  @Synchronized fun end(callId: String, reason: String) {
    if (id != callId) return
    id = null
    lastEnd = Pair(callId, reason)
    val releasing = resources.reversed().toList()
    resources.clear()
    try {
      releasing.forEach { release -> runCatching { release() } }
    } finally {
      ended(callId, reason)
    }
  }
}
