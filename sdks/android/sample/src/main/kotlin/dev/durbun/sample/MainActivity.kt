package dev.durbun.sample

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.durbun.Durbun
import dev.durbun.DurbunConnectionListener

/** One screen with every part of the SDK, built from plain platform views. */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var results: TextView
    private val lines = ArrayDeque<String>()
    private val statusListener = DurbunConnectionListener { runOnUiThread { showStatus() } }
    private val resultSink: (String) -> Unit = { line -> addResult(line) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(24))
        }

        status = text(14f).also { column.addView(it) }
        results = text(13f).apply {
            typeface = Typeface.MONOSPACE
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundColor(0x145B4BE0)
            text = "Results show up here and in the Dürbün Mac app."
        }
        column.addView(results, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })

        section(column, "Network (OkHttp + DurbunInterceptor)", "Each call is one row in the Network tab, with headers, body and timings.")
        buttons(column, "GET 200" to Demo::get200, "GET 404" to Demo::get404)
        buttons(column, "Slow (2 s)" to Demo::slow, "POST JSON" to Demo::postJson)
        buttons(column, "Failing" to Demo::failing, "HTTPS" to Demo::https)

        section(column, "Streams", "A WebSocket through DurbunWebSocketFactory and a Server-Sent Events response, with every message.")
        buttons(column, "WebSocket" to Demo::webSocket, "Event stream" to Demo::eventStream)

        section(column, "Logs and events", "Structured lines with tag, level and JSON data; an event row.")
        buttons(column, "Log every level" to Demo::logEveryLevel, "Send event" to Demo::event)

        section(column, "Web view", "A page whose fetch, XMLHttpRequest and console lines reach the Mac app through DurbunWebView.")
        buttons(column, "Open the web view" to { startActivity(Intent(this, WebViewActivity::class.java)) })

        section(column, "Crash", "An uncaught exception: the Mac app shows it with its stack trace, then the app closes.")
        buttons(column, "Crash the app" to ::confirmCrash)

        section(column, "Tools", "In the Mac app, Device → App tools lists this app's own tools: \"Run every request\", \"Verbose logging\" and \"Items per JSON response\".")

        setContentView(ScrollView(this).apply { addView(column) })
        Demo.onResult = resultSink
        showStatus()
    }

    override fun onStart() {
        super.onStart()
        Durbun.addConnectionListener(statusListener)
        showStatus()
    }

    override fun onStop() {
        Durbun.removeConnectionListener(statusListener)
        super.onStop()
    }

    override fun onDestroy() {
        if (Demo.onResult === resultSink) Demo.onResult = null
        super.onDestroy()
    }

    private fun showStatus() {
        status.text = if (Durbun.isStarted) {
            "Dürbün: ${Durbun.connectionStatus}"
        } else {
            "Dürbün is not running (release build with durbun-noop, or not debuggable)."
        }
    }

    private fun addResult(line: String) {
        lines.addFirst(line)
        while (lines.size > 6) lines.removeLast()
        results.text = lines.joinToString("\n")
    }

    private fun confirmCrash() {
        AlertDialog.Builder(this)
            .setTitle("Crash the app?")
            .setMessage("The app closes. Open it again to keep going; the crash is already in the Mac app.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Crash") { _, _ -> Demo.crash() }
            .show()
    }

    private fun section(parent: LinearLayout, title: String, detail: String) {
        parent.addView(
            text(17f).apply {
                text = title
                setTypeface(typeface, Typeface.BOLD)
            },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(20) },
        )
        parent.addView(text(13f).apply { text = detail; alpha = 0.7f })
    }

    private fun buttons(parent: LinearLayout, vararg items: Pair<String, () -> Unit>) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        items.forEachIndexed { index, (label, action) ->
            val button = Button(this).apply {
                text = label
                isAllCaps = false
                setOnClickListener { action() }
            }
            row.addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (index > 0) marginStart = dp(8)
            })
        }
        if (items.size == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f).apply { marginStart = dp(8) })
        parent.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
    }

    private fun text(sizeSp: Float) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        gravity = Gravity.START
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
