package io.levelg.phone

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class PhoneLevelGFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (showNativeIncomingCall(remoteMessage.data)) {
      super.onMessageReceived(remoteMessage)
      return
    }

    super.onMessageReceived(remoteMessage)
  }

  private fun showNativeIncomingCall(data: Map<String, String>): Boolean {
    if (data["type"] != "call:ring") return false
    if (data[AndroidCallNotifications.EXTRA_CALL_ID].isNullOrBlank()) return false
    if (data[AndroidCallNotifications.EXTRA_ROOM_ID].isNullOrBlank()) return false
    if (isExpired(data[AndroidCallNotifications.EXTRA_EXPIRES_AT])) return true

    AndroidCallNotifications.showIncomingCall(applicationContext, callExtras(data))
    return true
  }

  private fun callExtras(data: Map<String, String>): Map<String, String> {
    return listOf(
      AndroidCallNotifications.EXTRA_CALL_ID,
      AndroidCallNotifications.EXTRA_ROOM_ID,
      AndroidCallNotifications.EXTRA_SENDER_ID,
      AndroidCallNotifications.EXTRA_SENDER,
      AndroidCallNotifications.EXTRA_MODE,
      AndroidCallNotifications.EXTRA_EXPIRES_AT
    ).mapNotNull { key -> data[key]?.takeIf { it.isNotBlank() }?.let { key to it } }.toMap()
  }

  private fun isExpired(expiresAt: String?): Boolean {
    if (expiresAt.isNullOrBlank()) return false
    val expiration = parseRFC3339(expiresAt.trim()) ?: return false
    return expiration.before(Date())
  }

  private fun parseRFC3339(value: String): Date? {
    val normalized = value.replace(Regex("\\.(\\d{1,9})(Z|[+-]\\d{2}:\\d{2})$")) { match ->
      ".${match.groupValues[1].padEnd(3, '0').take(3)}${match.groupValues[2]}"
    }
    val formats = listOf(
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US).apply { timeZone = UTC },
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssX", Locale.US).apply { timeZone = UTC }
    )
    return formats.firstNotNullOfOrNull { format ->
      try {
        format.parse(normalized)
      } catch (_: Exception) {
        null
      }
    }
  }

  companion object {
    private val UTC: TimeZone = TimeZone.getTimeZone("UTC")
  }
}
