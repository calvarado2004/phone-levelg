package io.levelg.phone

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class IncomingCallActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
      )
    }

    val sender = intent.getStringExtra(AndroidCallNotifications.EXTRA_SENDER)?.ifBlank { "Phone LevelG" } ?: "Phone LevelG"
    val mode = intent.getStringExtra(AndroidCallNotifications.EXTRA_MODE)?.ifBlank { "voice" } ?: "voice"
    setContentView(callLayout(sender, mode))
  }

  private fun callLayout(sender: String, mode: String): LinearLayout {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(40, 80, 40, 80)
      setBackgroundColor(Color.rgb(15, 23, 32))
    }
    val avatar = TextView(this).apply {
      text = initials(sender)
      textSize = 34f
      gravity = Gravity.CENTER
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(37, 99, 235))
    }
    root.addView(avatar, LinearLayout.LayoutParams(150, 150))
    root.addView(TextView(this).apply {
      text = sender
      textSize = 30f
      gravity = Gravity.CENTER
      setTextColor(Color.WHITE)
      setPadding(0, 28, 0, 8)
    })
    root.addView(TextView(this).apply {
      text = if (mode == "video") "Incoming video call" else "Incoming voice call"
      textSize = 18f
      gravity = Gravity.CENTER
      setTextColor(Color.rgb(203, 213, 225))
      setPadding(0, 0, 0, 64)
    })
    root.addView(LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      addView(Button(context).apply {
        text = "Decline"
        setOnClickListener {
          sendBroadcast(PhoneLevelGCallActionReceiver.intent(context, AndroidCallNotifications.ACTION_DECLINE, extrasMap()))
          finish()
        }
      }, LinearLayout.LayoutParams(260, 120).apply { marginEnd = 28 })
      addView(Button(context).apply {
        text = "Answer"
        setOnClickListener {
          sendBroadcast(PhoneLevelGCallActionReceiver.intent(context, AndroidCallNotifications.ACTION_ACCEPT, extrasMap()))
          finish()
        }
      }, LinearLayout.LayoutParams(260, 120))
    })
    return root
  }

  private fun extrasMap(): Map<String, String> {
    return listOf(
      AndroidCallNotifications.EXTRA_CALL_ID,
      AndroidCallNotifications.EXTRA_ROOM_ID,
      AndroidCallNotifications.EXTRA_SENDER_ID,
      AndroidCallNotifications.EXTRA_SENDER,
      AndroidCallNotifications.EXTRA_MODE,
      AndroidCallNotifications.EXTRA_EXPIRES_AT
    ).mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
  }

  private fun initials(name: String): String {
    return name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).map { it.first().uppercaseChar() }.joinToString("").ifBlank { "?" }
  }

  companion object {
    fun intent(context: Context, extras: Map<String, String>): Intent {
      return Intent(context, IncomingCallActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        extras.forEach { (key, value) -> putExtra(key, value) }
      }
    }
  }
}
