package dev.durbun

import okhttp3.Call
import okhttp3.EventListener

/** No-op listener factory for release builds: the app's own listener (if any) gets every callback untouched. */
class DurbunEventListenerFactory @JvmOverloads constructor(
    private val delegate: EventListener.Factory? = null,
) : EventListener.Factory {
    constructor(delegate: EventListener) : this(
        object : EventListener.Factory {
            override fun create(call: Call): EventListener = delegate
        },
    )

    override fun create(call: Call): EventListener = delegate?.create(call) ?: EventListener.NONE
}
