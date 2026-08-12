package com.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.TimeZone

/**
 * Native phone-control tools for the agent. Every method resolves a promise
 * with a small result map or rejects with a message the MODEL will read —
 * error strings double as corrective feedback in the agent loop.
 */
class MinimusToolsModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MinimusTools"

    // ---------------------------------------------------------------- torch
    @ReactMethod
    fun setTorch(on: Boolean, promise: Promise) {
        try {
            val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val backCamera = cm.cameraIdList.firstOrNull { id ->
                val chars = cm.getCameraCharacteristics(id)
                chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true &&
                    chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            } ?: cm.cameraIdList.firstOrNull { id ->
                cm.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            if (backCamera == null) {
                promise.reject("no_flash", "This device has no flashlight.")
                return
            }
            cm.setTorchMode(backCamera, on)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("torch_failed", "Could not switch flashlight: ${e.message}")
        }
    }

    // ----------------------------------------------------------- brightness
    /** App-window brightness (0..1). System-wide needs WRITE_SETTINGS; window
     *  level is permissionless and visually identical while the app is up. */
    @ReactMethod
    fun setBrightness(level: Double, promise: Promise) {
        val activity = ctx.currentActivity
        if (activity == null) {
            promise.reject("no_activity", "App is not in the foreground.")
            return
        }
        activity.runOnUiThread {
            try {
                val lp: WindowManager.LayoutParams = activity.window.attributes
                lp.screenBrightness = level.coerceIn(0.01, 1.0).toFloat()
                activity.window.attributes = lp
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("brightness_failed", "Could not set brightness: ${e.message}")
            }
        }
    }

    // ---------------------------------------------------------- alarm/timer
    @ReactMethod
    fun setAlarm(hour: Int, minute: Int, label: String?, promise: Promise) {
        try {
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hour)
                putExtra(AlarmClock.EXTRA_MINUTES, minute)
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (!label.isNullOrBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("alarm_failed", "No clock app accepted the alarm: ${e.message}")
        }
    }

    @ReactMethod
    fun setTimer(seconds: Int, label: String?, promise: Promise) {
        try {
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (!label.isNullOrBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("timer_failed", "No clock app accepted the timer: ${e.message}")
        }
    }

    // ---------------------------------------------------------- notification
    @ReactMethod
    fun notify(title: String, body: String?, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                promise.reject(
                    "no_permission",
                    "Notification permission not granted — ask the user to enable notifications for this app.",
                )
                return
            }
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Agent", NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
            val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body ?: "")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
                .build()
            nm.notify(System.currentTimeMillis().toInt(), notification)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("notify_failed", "Could not show notification: ${e.message}")
        }
    }

    // ------------------------------------------------------------- calendar
    /** Silent insert when READ/WRITE_CALENDAR are granted; otherwise falls
     *  back to opening the calendar editor prefilled (compose-and-confirm). */
    @ReactMethod
    fun calendarInsert(
        title: String,
        startMillis: Double,
        durationMinutes: Int,
        notes: String?,
        promise: Promise,
    ) {
        val start = startMillis.toLong()
        val end = start + durationMinutes.coerceAtLeast(5) * 60_000L
        try {
            val granted = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.WRITE_CALENDAR) ==
                PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.READ_CALENDAR) ==
                PackageManager.PERMISSION_GRANTED
            if (granted) {
                val calId = primaryCalendarId()
                if (calId != null) {
                    val values = ContentValues().apply {
                        put(CalendarContract.Events.CALENDAR_ID, calId)
                        put(CalendarContract.Events.TITLE, title)
                        put(CalendarContract.Events.DTSTART, start)
                        put(CalendarContract.Events.DTEND, end)
                        put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
                        if (!notes.isNullOrBlank()) put(CalendarContract.Events.DESCRIPTION, notes)
                    }
                    val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
                    if (uri != null) {
                        promise.resolve(uri.lastPathSegment)
                        return
                    }
                }
            }
            // Fallback: prefilled editor.
            val intent = Intent(Intent.ACTION_INSERT).apply {
                data = CalendarContract.Events.CONTENT_URI
                putExtra(CalendarContract.Events.TITLE, title)
                putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
                if (!notes.isNullOrBlank()) putExtra(CalendarContract.Events.DESCRIPTION, notes)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            promise.resolve("editor_opened")
        } catch (e: Exception) {
            promise.reject("calendar_failed", "Could not create the event: ${e.message}")
        }
    }

    /** Events overlapping [startMillis, endMillis], for gap analysis in JS. */
    @ReactMethod
    fun calendarQuery(startMillis: Double, endMillis: Double, promise: Promise) {
        try {
            if (ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.READ_CALENDAR) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                promise.reject(
                    "no_permission",
                    "Calendar access not granted — ask the user to allow calendar access for this app.",
                )
                return
            }
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
                .appendPath(startMillis.toLong().toString())
                .appendPath(endMillis.toLong().toString())
                .build()
            val projection = arrayOf(
                CalendarContract.Instances.TITLE,
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
            )
            val events = Arguments.createArray()
            ctx.contentResolver.query(
                uri, projection, null, null, CalendarContract.Instances.BEGIN + " ASC",
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    val map = Arguments.createMap()
                    map.putString("title", cursor.getString(0) ?: "(untitled)")
                    map.putDouble("startMillis", cursor.getLong(1).toDouble())
                    map.putDouble("endMillis", cursor.getLong(2).toDouble())
                    events.pushMap(map)
                }
            }
            promise.resolve(events)
        } catch (e: Exception) {
            promise.reject("calendar_failed", "Could not read the calendar: ${e.message}")
        }
    }

    private fun primaryCalendarId(): Long? {
        val proj = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY)
        ctx.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI, proj,
            "${CalendarContract.Calendars.VISIBLE} = 1", null, null,
        )?.use { cursor ->
            var firstId: Long? = null
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                if (firstId == null) firstId = id
                if (cursor.getInt(1) == 1) return id
            }
            return firstId
        }
        return null
    }

    // -------------------------------------------------------------- overlay
    @ReactMethod
    fun hasOverlayPermission(promise: Promise) {
        promise.resolve(android.provider.Settings.canDrawOverlays(ctx))
    }

    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            val intent = Intent(
                android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:${ctx.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("overlay_settings_failed", e.message)
        }
    }

    @ReactMethod
    fun setOverlayEnabled(enabled: Boolean, promise: Promise) {
        try {
            val intent = Intent(ctx, OverlayService::class.java)
            if (enabled) {
                if (!android.provider.Settings.canDrawOverlays(ctx)) {
                    promise.reject(
                        "no_overlay_permission",
                        "Display-over-other-apps permission is not granted.",
                    )
                    return
                }
                if (Build.VERSION.SDK_INT >= 26) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } else {
                ctx.stopService(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("overlay_failed", e.message)
        }
    }

    companion object {
        private const val CHANNEL_ID = "minimus_agent"
    }
}
