package dev.durbun

/**
 * A control the desktop shows for this app (button, toggle or picker) that runs code inside the app —
 * for example "Log out", "Use staging API" or "Clear image cache". Register it with [Durbun.addAction].
 *
 * Handlers run on the app's main thread; the desktop gets an error toast when a handler throws.
 *
 * ```kotlin
 * Durbun.addAction(DurbunAction.button("app.logout", "Log out") { session.logout() })
 * Durbun.addAction(DurbunAction.toggle("app.staging", "Use staging API", initial = false) { useStaging = it })
 * ```
 */
class DurbunAction private constructor(
    /** Stable id, unique per app (for example `app.logout`). */
    val id: String,
    /** Label shown on the desktop. */
    val label: String,
    val kind: Kind,
    /** Group heading on the desktop. */
    val group: String,
    /** Choices of a [Kind.SELECT] action. */
    val options: List<Option>,
    initialValue: Any?,
    private val invoker: Invoker,
) {
    enum class Kind(
        /** Name used on the wire. */
        val wireName: String,
    ) {
        BUTTON("button"),
        TOGGLE("toggle"),
        SELECT("select"),
    }

    /** One choice of a [Kind.SELECT] action. */
    data class Option(val value: String, val label: String)

    /** Current value: a Boolean for toggles, the selected option value for selects, `null` for buttons. */
    @Volatile
    var value: Any? = initialValue
        internal set

    fun interface ClickHandler {
        fun onClick()
    }

    fun interface ToggleHandler {
        fun onToggle(enabled: Boolean)
    }

    fun interface SelectHandler {
        fun onSelect(value: String)
    }

    internal fun interface Invoker {
        /** Runs the handler for [params] and returns the command result data. */
        fun invoke(action: DurbunAction, params: Map<String, Any?>): Any?
    }

    /** Runs the handler (caller picks the thread). Throws when the handler throws or params are invalid. */
    internal fun invoke(params: Map<String, Any?>): Any? = invoker.invoke(this, params)

    override fun toString(): String = "DurbunAction(id=$id, kind=${kind.wireName}, value=$value)"

    companion object {
        /** Group used when none is given. */
        const val DEFAULT_GROUP: String = "app"

        /** A one-shot button. */
        @JvmStatic
        @JvmOverloads
        fun button(id: String, label: String, group: String = DEFAULT_GROUP, handler: ClickHandler): DurbunAction =
            DurbunAction(id, label, Kind.BUTTON, group, emptyList(), null) { _, _ ->
                handler.onClick()
                null
            }

        /** An on/off switch. The desktop sends the new state; without one the current state is flipped. */
        @JvmStatic
        @JvmOverloads
        fun toggle(
            id: String,
            label: String,
            initial: Boolean,
            group: String = DEFAULT_GROUP,
            handler: ToggleHandler,
        ): DurbunAction = DurbunAction(id, label, Kind.TOGGLE, group, emptyList(), initial) { action, params ->
            val next = booleanParam(params["value"])
                ?: booleanParam(params["enabled"])
                ?: !(action.value as? Boolean ?: false)
            handler.onToggle(next)
            action.value = next
            next
        }

        /** A picker with fixed [options]. */
        @JvmStatic
        @JvmOverloads
        fun select(
            id: String,
            label: String,
            options: List<Option>,
            initial: String,
            group: String = DEFAULT_GROUP,
            handler: SelectHandler,
        ): DurbunAction {
            val choices = options.toList()
            return DurbunAction(id, label, Kind.SELECT, group, choices, initial) { action, params ->
                val selected = params["value"]?.toString()
                    ?: throw IllegalArgumentException("Missing 'value' for select action '$id'")
                require(choices.isEmpty() || choices.any { it.value == selected }) {
                    "Unknown option '$selected' for select action '$id'"
                }
                handler.onSelect(selected)
                action.value = selected
                selected
            }
        }

        private fun booleanParam(raw: Any?): Boolean? = when (raw) {
            is Boolean -> raw
            is Number -> raw.toDouble() != 0.0
            is String -> when (raw.trim().lowercase()) {
                "true", "1", "on", "yes" -> true
                "false", "0", "off", "no" -> false
                else -> null
            }
            else -> null
        }
    }
}
