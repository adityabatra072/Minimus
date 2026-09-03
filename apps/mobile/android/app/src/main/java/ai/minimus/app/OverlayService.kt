package ai.minimus.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import kotlin.math.abs

/**
 * Floating agent bubble — a chat-head that stays above every app. Tapping it
 * brings the agent to the foreground. Runs as a foreground service so the
 * system keeps it alive; the notification doubles as the "agent is armed"
 * affordance.
 */
class OverlayService : Service() {

    private var windowManager: WindowManager? = null
    private var bubble: FrameLayout? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        addBubble()
    }

    override fun onDestroy() {
        bubble?.let { windowManager?.removeView(it) }
        bubble = null
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Agent overlay",
                    NotificationManager.IMPORTANCE_MIN,
                ),
            )
        }
        val tapIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Agent ready")
            .setContentText("Floating assistant is on")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(tapIntent)
            .setOngoing(true)
            .build()
    }

    private fun addBubble() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        windowManager = wm

        val density = resources.displayMetrics.density
        val size = (56 * density).toInt()
        val dot = (18 * density).toInt()

        // Anodize disc with the amber LED dot — matches the app brand.
        val disc = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#14171C"))
            setStroke((1.5f * density).toInt(), Color.parseColor("#262B33"))
        }
        val led = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#FFB454"))
            }
        }
        val container = FrameLayout(this).apply {
            background = disc
            elevation = 8f * density
            addView(
                led,
                FrameLayout.LayoutParams(dot, dot, Gravity.CENTER),
            )
        }

        val params = WindowManager.LayoutParams(
            size,
            size,
            if (Build.VERSION.SDK_INT >= 26) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - size - (8 * density).toInt()
            y = (resources.displayMetrics.heightPixels * 0.35f).toInt()
        }

        container.setOnTouchListener(object : View.OnTouchListener {
            private var downX = 0f
            private var downY = 0f
            private var startX = 0
            private var startY = 0
            private var dragging = false

            override fun onTouch(v: View, event: MotionEvent): Boolean {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = event.rawX
                        downY = event.rawY
                        startX = params.x
                        startY = params.y
                        dragging = false
                        return true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = event.rawX - downX
                        val dy = event.rawY - downY
                        if (abs(dx) > 12 || abs(dy) > 12) dragging = true
                        if (dragging) {
                            params.x = (startX + dx).toInt()
                            params.y = (startY + dy).toInt()
                            wm.updateViewLayout(container, params)
                        }
                        return true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (!dragging) {
                            v.performClick()
                            openAgent()
                        } else {
                            // Snap to the nearest horizontal edge.
                            val width = resources.displayMetrics.widthPixels
                            params.x = if (params.x + size / 2 < width / 2) {
                                (8 * density).toInt()
                            } else {
                                width - size - (8 * density).toInt()
                            }
                            wm.updateViewLayout(container, params)
                        }
                        return true
                    }
                }
                return false
            }
        })

        wm.addView(container, params)
        bubble = container
    }

    private fun openAgent() {
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
            ),
        )
    }

    companion object {
        private const val CHANNEL_ID = "minimus_overlay"
        private const val NOTIFICATION_ID = 7411
    }
}
