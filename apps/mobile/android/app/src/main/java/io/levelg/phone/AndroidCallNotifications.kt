package io.levelg.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build

object AndroidCallNotifications {
  const val CHANNEL_ID = "incoming-calls-v2"
  const val ACTION_ACCEPT = "io.levelg.phone.ACCEPT_CALL"
  const val ACTION_DECLINE = "io.levelg.phone.DECLINE_CALL"
  const val EXTRA_CALL_ID = "callId"
  const val EXTRA_ROOM_ID = "roomId"
  const val EXTRA_SENDER_ID = "senderId"
  const val EXTRA_SENDER = "sender"
  const val EXTRA_MODE = "mode"
  const val EXTRA_EXPIRES_AT = "expiresAt"

  fun showIncomingCall(context: Context, extras: Map<String, String>) {
    ensureChannel(context)

    val callId = extras[EXTRA_CALL_ID].orEmpty()
    val sender = extras[EXTRA_SENDER]?.ifBlank { "Phone LevelG" } ?: "Phone LevelG"
    val mode = extras[EXTRA_MODE]?.ifBlank { "voice" } ?: "voice"
    val notificationId = notificationId(callId)
    val fullScreenIntent = PendingIntent.getActivity(
      context,
      notificationId,
      IncomingCallActivity.intent(context, extras),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val acceptIntent = PendingIntent.getBroadcast(
      context,
      notificationId + 1,
      PhoneLevelGCallActionReceiver.intent(context, ACTION_ACCEPT, extras),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val declineIntent = PendingIntent.getBroadcast(
      context,
      notificationId + 2,
      PhoneLevelGCallActionReceiver.intent(context, ACTION_DECLINE, extras),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(if (mode == "video") "Incoming video call" else "Incoming voice call")
      .setContentText("$sender is calling")
      .setCategory(Notification.CATEGORY_CALL)
      .setPriority(Notification.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(fullScreenIntent)
      .setSound(ringtoneUri(context))
      .setVibrate(longArrayOf(0, 750, 350))
      .setFullScreenIntent(fullScreenIntent, true)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val caller = Person.Builder().setName(sender).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(caller, declineIntent, acceptIntent))
    } else {
      builder
        .addAction(Notification.Action.Builder(R.mipmap.ic_launcher, "Decline", declineIntent).build())
        .addAction(Notification.Action.Builder(R.mipmap.ic_launcher, "Answer", acceptIntent).build())
    }

    context.getSystemService(NotificationManager::class.java).notify(notificationId, builder.build())
  }

  fun openIncomingCallActivity(context: Context, extras: Map<String, String>) {
    try {
      context.startActivity(IncomingCallActivity.intent(context, extras))
    } catch (_: Exception) {
      // The posted full-screen notification remains the fallback when Android blocks a background launch.
    }
  }

  fun cancel(context: Context, callId: String) {
    context.getSystemService(NotificationManager::class.java).cancel(notificationId(callId))
  }

  fun notificationId(callId: String): Int {
    return callId.ifBlank { "phone-levelg-call" }.hashCode()
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val channel = NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Phone LevelG incoming call alerts"
      setSound(ringtoneUri(context), audioAttributes)
      vibrationPattern = longArrayOf(0, 750, 350)
      enableVibration(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun ringtoneUri(context: Context): Uri {
    return Uri.parse("android.resource://${context.packageName}/${R.raw.rockstar}")
  }
}
