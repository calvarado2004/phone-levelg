package io.levelg.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri

class PhoneLevelGCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val extras = extrasMap(intent)
    val callId = extras[AndroidCallNotifications.EXTRA_CALL_ID].orEmpty()
    AndroidCallNotifications.cancel(context, callId)

    when (intent.action) {
      AndroidCallNotifications.ACTION_ACCEPT -> {
        context.startActivity(callActionIntent(context, "accept", callId, extras))
      }

      AndroidCallNotifications.ACTION_DECLINE -> {
        context.startActivity(callActionIntent(context, "decline", callId, extras))
      }
    }
  }

  private fun callActionIntent(context: Context, action: String, callId: String, extras: Map<String, String>): Intent {
    return Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      data = Uri.parse(
        "phonelevelg://call?action=$action" +
          "&callId=${Uri.encode(callId)}" +
          queryParam("roomId", extras[AndroidCallNotifications.EXTRA_ROOM_ID]) +
          queryParam("senderId", extras[AndroidCallNotifications.EXTRA_SENDER_ID]) +
          queryParam("sender", extras[AndroidCallNotifications.EXTRA_SENDER]) +
          queryParam("mode", extras[AndroidCallNotifications.EXTRA_MODE]) +
          queryParam("expiresAt", extras[AndroidCallNotifications.EXTRA_EXPIRES_AT])
      )
      extras.forEach { (key, value) -> putExtra(key, value) }
    }
  }

  private fun queryParam(name: String, value: String?): String {
    return if (value.isNullOrBlank()) "" else "&$name=${Uri.encode(value)}"
  }

  private fun extrasMap(intent: Intent): Map<String, String> {
    return listOf(
      AndroidCallNotifications.EXTRA_CALL_ID,
      AndroidCallNotifications.EXTRA_ROOM_ID,
      AndroidCallNotifications.EXTRA_SENDER_ID,
      AndroidCallNotifications.EXTRA_SENDER,
      AndroidCallNotifications.EXTRA_MODE,
      AndroidCallNotifications.EXTRA_EXPIRES_AT
    ).mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
  }

  companion object {
    fun intent(context: Context, action: String, extras: Map<String, String>): Intent {
      return Intent(context, PhoneLevelGCallActionReceiver::class.java).apply {
        this.action = action
        extras.forEach { (key, value) -> putExtra(key, value) }
      }
    }
  }
}
