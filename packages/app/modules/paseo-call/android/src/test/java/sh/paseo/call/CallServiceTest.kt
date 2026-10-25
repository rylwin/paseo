package sh.paseo.call

import android.Manifest
import android.app.Notification
import android.app.Service
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.os.Looper
import android.media.AudioManager
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.WritableMap
import com.zxcpoiu.incallmanager.InCallManagerModule
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

/** Framework lifecycle coverage, not a substitute for locked-screen hardware/socket QA. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 36], shadows = [ArgumentsShadow::class])
class CallServiceTest {
  @Before fun setup() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(app.packageName)
    shadowOf(app.packageManager).addResolveInfoForIntent(launcher, ResolveInfo().apply {
      activityInfo = ActivityInfo().apply {
        name = "sh.paseo.debug.MainActivity"
        packageName = app.packageName
        applicationInfo = app.applicationInfo
      }
    })
    CallRuntime.changed = null
    CallRuntime.ready = null
    CallRuntime.readyId = null
    CallRuntime.label = "Bound Pi"
    CallRuntime.route = "paseo:///h/bound-host/agent/bound-pi"
  }

  @After fun cleanup() {
    CallRuntime.owner.activeId()?.let { CallRuntime.owner.end(it, "ended") }
    shadowOf(Looper.getMainLooper()).idle()
    CallRuntime.service = null
  }

  @Test fun visibleCallGetsOngoingNotificationWithEndAndBoundConversation() {
    CallRuntime.owner.begin("one")
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    var ready = false
    CallRuntime.readyId = "one"
    CallRuntime.ready = { ready = it }
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(start("one"), 0, 1))
    val notification = shadowOf(service).lastForegroundNotification
    assertNotNull(notification)
    assertTrue(ready)
    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
    assertEquals("Call with Bound Pi", notification.extras.getString(Notification.EXTRA_TITLE))
    assertEquals("End call", notification.actions.single().title)
    assertEquals("one", shadowOf(notification.actions.single().actionIntent).savedIntent.getStringExtra("callId"))
    assertEquals(CallRuntime.route, shadowOf(notification.contentIntent).savedIntent.dataString)
    controller.destroy()
  }

  @Test fun audioFocusInterruptionEndsNativeOwnershipWithoutAnActiveJsInstance() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val audio = InCallManagerModule(BridgeReactContext(RuntimeEnvironment.getApplication()))
    audio.setCallInterruptionListener { CallRuntime.owner.end("one", "interrupted") }
    audio.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertEquals(1, releases)
    audio.setCallInterruptionListener(null)
  }

  @Test fun notificationEndReleasesRealOwnerWithoutAnyJavascriptListener() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    val end = shadowOf(service).lastForegroundNotification.actions.single().actionIntent
    end.send()
    shadowOf(Looper.getMainLooper()).idle()
    // Robolectric dispatches service PendingIntents as intents; deliver as the framework would.
    service.onStartCommand(shadowOf(end).savedIntent, 0, 2)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, releases)
    assertNull(CallRuntime.owner.activeId())
    assertTrue(shadowOf(service).isStoppedBySelf)
    controller.destroy()
    assertEquals(1, releases)
  }

  @Test fun staleNotificationDoesNotEndNewOwnedCall() {
    CallRuntime.owner.begin("two")
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("two"), 0, 1)
    service.onStartCommand(Intent().setAction(CallService.END).putExtra("callId", "one"), 0, 2)
    assertEquals("two", CallRuntime.owner.activeId())
    assertFalse(shadowOf(service).isStoppedBySelf)
    controller.destroy()
  }

  @Test fun onDestroyReleasesMicrophoneAndPeerAndDoesNotRedial() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    controller.get().onStartCommand(start("one"), 0, 1)
    controller.destroy()
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(2, releases)
    assertNull(CallRuntime.owner.activeId())
    assertNull(CallRuntime.service)
    val recreated = Robolectric.buildService(CallService::class.java).create()
    recreated.get().onStartCommand(null, 0, 2)
    assertNull(CallRuntime.owner.activeId())
    assertTrue(shadowOf(recreated.get()).isStoppedBySelf)
    recreated.destroy()
  }

  @Test fun taskRemovalEndsCaptureAndRemovesNotification() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    service.onTaskRemoved(null)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, releases)
    assertTrue(shadowOf(service).isStoppedBySelf)
    assertFalse(service.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == CallService.NOTIFICATION })
    controller.destroy()
  }

  @Test fun revokedMicrophonePermissionBeforeDeliveryEndsNativeOwnership() {
    shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.RECORD_AUDIO)
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertEquals(1, releases)
    assertTrue(shadowOf(service).isStoppedBySelf)
    controller.destroy()
  }

  @Test fun taskRemovalCancelsANewReservationBeforeItsStartCommandReusesTheService() {
    CallRuntime.owner.begin("old")
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("old"), 0, 1)
    CallRuntime.owner.end("old", "ended")
    CallRuntime.owner.begin("new")
    shadowOf(Looper.getMainLooper()).idle()
    service.onTaskRemoved(null)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertTrue(shadowOf(service).isStoppedBySelf)
    controller.destroy()
  }

  @Test fun blockingCallNotificationsEndsNativeCaptureAndReenablingDoesNotRedial() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    val app = RuntimeEnvironment.getApplication()
    val manager = app.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(false)
    app.sendBroadcast(Intent(NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED))
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertEquals(1, releases)
    assertTrue(shadowOf(service).isStoppedBySelf)
    shadowOf(manager).setNotificationsEnabled(true)
    app.sendBroadcast(Intent(NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED))
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    controller.destroy()
  }

  @Test fun blockingOnlyTheCallChannelAlsoEndsCaptureWithoutJavascript() {
    CallRuntime.owner.begin("one")
    var releases = 0
    CallRuntime.owner.own("one") { releases++ }
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    val app = RuntimeEnvironment.getApplication()
    val manager = app.getSystemService(NotificationManager::class.java)
    val channel = manager.getNotificationChannel(CallService.CHANNEL)
    channel.importance = NotificationManager.IMPORTANCE_NONE
    manager.createNotificationChannel(channel)
    assertTrue(manager.areNotificationsEnabled())
    assertEquals(NotificationManager.IMPORTANCE_NONE, manager.getNotificationChannel(CallService.CHANNEL).importance)
    app.sendBroadcast(Intent(NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED))
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertEquals(1, releases)
    assertTrue(shadowOf(service).isStoppedBySelf)
    controller.destroy()
  }

  @Test fun destructionBeforeStartDeliveryCancelsTheNativeReservation() {
    CallRuntime.owner.begin("one")
    val controller = Robolectric.buildService(CallService::class.java).create()
    controller.destroy()
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
  }

  @Test fun cancellationBeforeStartDeliveryLeavesNoOrphanService() {
    CallRuntime.owner.begin("one")
    CallRuntime.owner.end("one", "ended")
    val controller = Robolectric.buildService(CallService::class.java).create()
    val service = controller.get()
    service.onStartCommand(start("one"), 0, 1)
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(CallRuntime.owner.activeId())
    assertTrue(shadowOf(service).isStoppedBySelf)
    controller.destroy()
  }

  private fun start(id: String) = Intent().putExtra("callId", id)
}

// Only RN's JNI-backed event-map allocation is replaced. Native interruption and ownership
// code still run; no Catalyst/JavaScript instance or WebRTC hardware is present in JVM tests.
@Implements(value = Arguments::class, isInAndroidSdk = false)
class ArgumentsShadow {
  companion object {
    @JvmStatic
    @Implementation
    fun createMap(): WritableMap = JavaOnlyMap()
  }
}
