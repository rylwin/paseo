package sh.paseo.call

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.WritableArray
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.oney.WebRTCModule.WebRTCModule
import com.zxcpoiu.incallmanager.InCallManagerModule
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoCallModule : Module() {
  private val readyTone = CallReadyTone(
    CallRuntime.owner,
    { release -> CallRuntime.main.postDelayed(release, 250) },
  ) {
    // Use the existing communication route and user call volume; never take audio focus.
    val tone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 25)
    object : LocalReadyTone {
      override fun play() { tone.startTone(ToneGenerator.TONE_PROP_BEEP, 90) }
      override fun release() { tone.release() }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoCall")
    Events("ended")

    OnCreate {
      CallRuntime.changed = { id, reason -> sendEvent("ended", mapOf("callId" to id, "reason" to reason)) }
    }
    // Reserve synchronously before the queued start so an immediate cancel cannot be lost.
    Function("prepare") { id: String -> CallRuntime.owner.begin(id) }
    AsyncFunction("start") { id: String, label: String, route: String, promise: Promise ->
      CallRuntime.main.post {
        try {
          val context = requireNotNull(appContext.reactContext)
          val activity = appContext.currentActivity as? LifecycleOwner
          check(activity?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true) {
            "Return to Paseo and start the call while the app is visible."
          }
          check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            "Allow microphone access in Android settings, then try again."
          }
          val notifications = context.getSystemService(NotificationManager::class.java)
          check(notifications.areNotificationsEnabled() && notifications.getNotificationChannel(CallService.CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE) {
            "Enable Paseo call notifications in Android settings, then try again. The call has not started."
          }
          CallRuntime.owner.during(id) {
            CallRuntime.label = label
            CallRuntime.route = route
            CallRuntime.readyId = id
            CallRuntime.ready = { success ->
              if (success) {
                // FGS priority alone does not keep RN timers running after onHostPause.
                // Keep the existing authenticated socket timers alive only for this call.
                val tasks = HeadlessJsTaskContext.getInstance(context as ReactApplicationContext)
                val data = Arguments.createMap().apply { putString("callId", id) }
                val task = tasks.startTask(HeadlessJsTaskConfig("PaseoCall", data, 0, true))
                CallRuntime.owner.own(id) { CallRuntime.main.post { tasks.finishTask(task) } }
                promise.resolve(null)
              } else {
                promise.reject("ERR_CALL_START", "Call could not start. Return to Paseo and try again.", null)
              }
            }
            try {
              context.startForegroundService(Intent(context, CallService::class.java).putExtra("callId", id))
            } catch (error: Exception) {
              CallRuntime.owner.end(id, "startup")
            }
            CallRuntime.main.postDelayed({
              if (CallRuntime.readyId == id) CallRuntime.owner.end(id, "startup")
            }, 10000)
          }
        } catch (error: Exception) {
          CallRuntime.owner.end(id, "startup")
          promise.reject("ERR_CALL_START", error.message, error)
        }
      }
    }

    Function("readyCue") { id: String ->
      CallRuntime.main.post { readyTone.play(id) }
    }
    Function("activeId") { CallRuntime.owner.activeId() }
    Function("endedReason") { id: String -> CallRuntime.owner.endedReason(id) }
    Function("stop") { id: String -> CallRuntime.owner.end(id, "ended") }
    Function("startAudio") { id: String ->
      CallRuntime.owner.during(id) {
        // InCallManager lacks @ReactModule; RN's bridgeless class lookup returns null.
        val audio = requireNotNull((appContext.reactContext as? ReactApplicationContext)?.getNativeModule("InCallManager") as? InCallManagerModule)
        CallRuntime.owner.own(id) {
          audio.setCallInterruptionListener(null)
          audio.stop()
        }
        audio.setCallInterruptionListener { CallRuntime.owner.end(id, "interrupted") }
        audio.start("video", true, "")
      }
    }
    AsyncFunction("acquire") { id: String, promise: Promise ->
      try {
        CallRuntime.owner.during(id) {
          val rtc = requireNotNull((appContext.reactContext as? ReactApplicationContext)?.getNativeModule(WebRTCModule::class.java))
          // WebRTC expects normalized audio constraints and already-granted RECORD_AUDIO.
          val constraints = Arguments.createMap().apply { putMap("audio", Arguments.createMap()) }
          rtc.getUserMedia(constraints, Callback { args ->
            val streamId = args[0] as String
            val tracks = args[1] as WritableArray
            val trackIds = (0 until tracks.size()).map { tracks.getMap(it)!!.getString("id")!! }
            val owned = CallRuntime.owner.own(id) {
              CallMicrophoneRelease.release(
                streamId,
                trackIds,
                { stream, track -> rtc.mediaStreamRemoveTrack(stream, -1, track) },
                { track -> rtc.mediaStreamTrackRelease(track) },
                { stream -> rtc.mediaStreamRelease(stream) },
              )
            }
            if (owned) promise.resolve(mapOf("streamId" to streamId, "streamReactTag" to streamId, "tracks" to tracks.toArrayList()))
            else promise.reject("ERR_CALL_ENDED", "Call ended", null)
          }, Callback { args ->
            promise.reject("ERR_CALL_MICROPHONE", "Microphone unavailable: ${args.lastOrNull()}. Check microphone access and try again.", null)
          })
        }
      } catch (error: Exception) {
        promise.reject("ERR_CALL_MICROPHONE", error.message, error)
      }
    }
    Function("ownPeer") { id: String, peerId: Int ->
      val rtc = requireNotNull((appContext.reactContext as? ReactApplicationContext)?.getNativeModule(WebRTCModule::class.java))
      check(CallRuntime.owner.own(id) { rtc.peerConnectionClose(peerId) }) { "Call ended" }
    }
    OnDestroy {
      CallRuntime.owner.activeId()?.let { CallRuntime.owner.end(it, "destroyed") }
      CallRuntime.changed = null
    }
  }
}
