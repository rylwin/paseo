package sh.paseo.call

import android.os.Handler
import android.os.Looper

/** Shared by the Expo module and service, not persisted. End never depends on the JS bridge. */
object CallRuntime {
  val main = Handler(Looper.getMainLooper())
  var label = ""
  var route = ""
  var readyId: String? = null
  var ready: ((Boolean) -> Unit)? = null
  var changed: ((String, String) -> Unit)? = null
  var service: CallService? = null
  val owner = CallOwner { id, reason ->
    main.post {
      if (readyId == id) {
        ready?.invoke(false)
        ready = null
        readyId = null
      }
      service?.ended()
      changed?.invoke(id, reason)
    }
  }
}
