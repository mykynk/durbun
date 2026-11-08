package dev.durbun.flutter

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager

/**
 * Opens the in-app inspector when the phone is shaken. The accelerometer is read only while Dart asks for
 * it (an inspector is mounted, its panel is closed and the app is in the foreground), at the UI rate
 * (about 16 samples a second, enough for the 4-sample window below and lighter on the battery than the
 * game rate). Detection follows Square's Seismic: the phone counts as shaking when at least 3/4 of the
 * samples of the last 0.5 s exceed 13 m/s².
 */
internal class ShakeDetector(private val context: Context, private val onShake: () -> Unit) : SensorEventListener {
    private var manager: SensorManager? = null
    private val window = ShakeWindow()

    /** Starts listening; false when the device has no accelerometer. */
    fun start(): Boolean {
        if (manager != null) return true
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return false
        val sensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
        if (!sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI)) return false
        manager = sm
        return true
    }

    fun stop() {
        manager?.unregisterListener(this)
        manager = null
        window.clear()
    }

    override fun onSensorChanged(event: SensorEvent) {
        val v = event.values
        if (v.size < 3) return
        if (window.add(event.timestamp, v[0], v[1], v[2])) onShake()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}

/** The sample window behind [ShakeDetector] (plain JVM code, unit-testable). */
internal class ShakeWindow(
    private val thresholdMs2: Float = 13f,
    private val windowNs: Long = 500_000_000L,
    private val minSpanNs: Long = 250_000_000L,
    private val cooldownNs: Long = 1_500_000_000L,
) {
    private val times = ArrayDeque<Long>()
    private val hits = ArrayDeque<Boolean>()
    private var accelerating = 0
    private var lastShake = Long.MIN_VALUE

    /** Adds one sample (timestamp in ns); true when it completes a shake. */
    fun add(timestampNs: Long, x: Float, y: Float, z: Float): Boolean {
        val hit = x * x + y * y + z * z > thresholdMs2 * thresholdMs2
        times.addLast(timestampNs)
        hits.addLast(hit)
        if (hit) accelerating++
        while (times.isNotEmpty() && timestampNs - times.first() > windowNs) {
            times.removeFirst()
            if (hits.removeFirst()) accelerating--
        }
        val span = timestampNs - times.first()
        val shaking = times.size >= 4 && span >= minSpanNs && accelerating * 4 >= times.size * 3
        if (!shaking) return false
        if (lastShake != Long.MIN_VALUE && timestampNs - lastShake < cooldownNs) return false
        lastShake = timestampNs
        clear()
        return true
    }

    fun clear() {
        times.clear()
        hits.clear()
        accelerating = 0
    }
}
