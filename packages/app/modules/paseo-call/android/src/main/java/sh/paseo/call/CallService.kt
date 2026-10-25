package sh.paseo.call

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.net.Uri
import android.os.Build
import android.os.IBinder

class CallService : Service() {
  private var callId: String? = null
  private val notificationBlocks = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val manager = getSystemService(NotificationManager::class.java)
      if (!manager.areNotificationsEnabled() || manager.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) {
        CallRuntime.owner.activeId()?.let { CallRuntime.owner.end(it, "permission") }
      }
    }
  }
  private val recordings = object : AudioManager.AudioRecordingCallback() {
    override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
      if (configs.any { it.isClientSilenced }) {
        callId?.let { CallRuntime.owner.end(it, "interrupted") }
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    CallRuntime.service = this
    callId = CallRuntime.owner.activeId()
    val notifications = IntentFilter(NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED).apply {
      addAction(NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED)
    }
    if (Build.VERSION.SDK_INT >= 33) {
      registerReceiver(notificationBlocks, notifications, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(notificationBlocks, notifications)
    }
    getSystemService(AudioManager::class.java).registerAudioRecordingCallback(recordings, CallRuntime.main)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val requested = intent?.getStringExtra("callId")
    if (intent?.action == END) {
      // A stale PendingIntent cannot stop a later call, even in the same service instance.
      if (requested != null) CallRuntime.owner.end(requested, "ended")
      if (CallRuntime.owner.activeId() == null) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelfResult(startId)
      }
      return START_NOT_STICKY
    }
    val active = CallRuntime.owner.activeId()
    callId = active
    try {
      // Even a start canceled before delivery must satisfy startForegroundService's deadline.
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Voice calls", NotificationManager.IMPORTANCE_LOW))
      val token = active ?: requested.orEmpty()
      val end = Intent(this, CallService::class.java).setAction(END)
        .setData(Uri.parse("paseo-call-end:$token")).putExtra("callId", token)
      val open = packageManager.getLaunchIntentForPackage(packageName)!!
        .setAction(Intent.ACTION_VIEW).setData(Uri.parse(CallRuntime.route))
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      val notification = Notification.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.sym_action_call)
        .setContentTitle("Call with ${CallRuntime.label}")
        .setContentText("Voice call in progress")
        .setCategory(Notification.CATEGORY_CALL)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setOngoing(true).setOnlyAlertOnce(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        .addAction(Notification.Action.Builder(null, "End call", PendingIntent.getService(this, 0, end, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
        .build()
      startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      if (active == null) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelfResult(startId)
      } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        CallRuntime.owner.end(active, "permission")
      } else if (CallRuntime.readyId == active) {
        CallRuntime.ready?.invoke(true)
        CallRuntime.ready = null
        CallRuntime.readyId = null
      }
    } catch (error: Exception) {
      active?.let { CallRuntime.owner.end(it, "startup") }
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  fun ended() {
    if (CallRuntime.owner.activeId() != null) return
    callId = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Task removal applies to the app, including a replacement start still in the queue.
    CallRuntime.owner.activeId()?.let { CallRuntime.owner.end(it, "ended") }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    callId?.let { CallRuntime.owner.end(it, "destroyed") }
    callId = null
    unregisterReceiver(notificationBlocks)
    getSystemService(AudioManager::class.java).unregisterAudioRecordingCallback(recordings)
    stopForeground(STOP_FOREGROUND_REMOVE)
    if (CallRuntime.service === this) CallRuntime.service = null
    super.onDestroy()
  }

  companion object {
    const val CHANNEL = "paseo-voice-calls"
    const val NOTIFICATION = 8431
    const val END = "sh.paseo.call.END"
  }
}
