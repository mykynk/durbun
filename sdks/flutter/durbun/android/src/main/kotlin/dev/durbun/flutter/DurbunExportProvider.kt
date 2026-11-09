package dev.durbun.flutter

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Hands the in-app panel's session exports to the app the user shares them with (Gmail, Slack, Drive…), with
 * no androidx dependency (FileProvider would need one). Read-only, and only files directly in
 * `cacheDir/durbun-export`, by plain file name: `content://<applicationId>.durbun.files/<name>`. Not exported:
 * another app reads a file only through the one-time grant of the share intent
 * (`FLAG_GRANT_READ_URI_PERMISSION`). It does nothing when created.
 */
class DurbunExportProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String? = fileFor(uri)?.let { mimeOf(it.name) }

    /** Name and size, which share targets ask for before they read. */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? {
        val file = fileFor(uri) ?: return null
        val known = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val columns = projection?.filter { it in known }?.toTypedArray() ?: known
        val row = arrayOfNulls<Any>(columns.size)
        columns.forEachIndexed { i, column ->
            row[i] = if (column == OpenableColumns.DISPLAY_NAME) file.name else file.length()
        }
        return MatrixCursor(columns, 1).apply { addRow(row) }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (mode != "r") throw FileNotFoundException("Dürbün exports are read-only")
        val file = fileFor(uri) ?: throw FileNotFoundException("not a Dürbün export")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private fun fileFor(uri: Uri): File? =
        try {
            val ctx = context
            val segments = uri.pathSegments
            if (ctx == null || segments.size != 1) null else exportFile(ctx, segments[0])
        } catch (_: Throwable) {
            null
        }

    companion object {
        const val FOLDER = "durbun-export"

        /** A plain file name: no separators, no `..`, nothing hidden. */
        private val SAFE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")

        fun exportDir(context: Context): File = File(context.cacheDir, FOLDER)

        /** The export named [name], or null unless it is an existing file directly in the export folder. */
        fun exportFile(context: Context, name: String): File? {
            if (!SAFE_NAME.matches(name) || name.contains("..")) return null
            val dir = exportDir(context).canonicalFile
            val file = File(dir, name).canonicalFile
            return if (file.parentFile == dir && file.isFile) file else null
        }

        /** Declared in the plugin's manifest as `${applicationId}.durbun.files`. */
        fun authority(context: Context): String = "${context.packageName}.durbun.files"

        fun uriFor(context: Context, file: File): Uri =
            Uri.Builder().scheme("content").authority(authority(context)).appendPath(file.name).build()

        fun mimeOf(name: String): String =
            when (name.substringAfterLast('.', "").lowercase()) {
                "md" -> "text/markdown"
                "har", "json" -> "application/json"
                "txt" -> "text/plain"
                else -> "application/octet-stream"
            }
    }
}
