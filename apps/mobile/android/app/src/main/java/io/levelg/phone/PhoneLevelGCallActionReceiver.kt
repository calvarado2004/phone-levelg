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
        val launchIntent = Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
          data = Uri.parse(
            "phonelevelg://call?action=accept" +
              "&callId=${Uri.encode(callId)}" +
              "&roomId=${Uri.encode(extras[AndroidCallNotifications.EXTRA_ROOM_ID].orEmpty())}"
          )
          extras.forEach { (key, value) -> putExtra(key, value) }
        }
        context.startActivity(launchIntent)
      }

      AndroidCallNotifications.ACTION_DECLINE -> return
    }
  }

  private fun extrasMap(intent: Intent): Map<String, String> {
    return listOf(
      AndroidCallNotifications.EXTRA_CALL_ID,
      AndroidCallNotifications.EXTRA_ROOM_ID,
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
