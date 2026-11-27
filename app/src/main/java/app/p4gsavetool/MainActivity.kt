package app.p4gsavetool

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Multi-select open contract that also asks for write access, so "Simpan" can overwrite the opened files. */
class OpenDocumentsRW : ActivityResultContracts.OpenMultipleDocuments() {
    override fun createIntent(context: Context, input: Array<String>): Intent =
        super.createIntent(context, input).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
}

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    // Currently opened save: the .bin and (Switch only) its companion .binslot.
    // Either opened through the system picker (Uri) or straight from the save folder (File).
    private var binUri: Uri? = null
    private var slotUri: Uri? = null
    private var binFile: File? = null
    private var slotFile: File? = null
    private var binName: String = "save.bin"
    private var slotName: String = ""
    private var binOriginal: ByteArray? = null
    private var slotOriginal: ByteArray? = null
    private var backedUp = false

    // "Save as" state
    private var pendingBin: ByteArray? = null
    private var pendingSlotName: String = ""
    private var pendingSlot: ByteArray? = null

    // Direct folder access
    private var lastScanPath: String = ""
    private var scanRoot: String? = null           // canonical path of the last scanned folder
    private var awaitingPermission = false
    private val saveNameRegex = Regex("(?i)data\\d+\\.bin")

    private val openLauncher = registerForActivityResult(OpenDocumentsRW()) { uris ->
        if (uris.isNotEmpty()) handleOpened(uris)
    }

    private val storagePermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        awaitingPermission = false
        if (granted) doScan(lastScanPath) else reportError("perm_denied")
    }

    private val createBinLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri ->
        val data = pendingBin
        pendingBin = null
        if (uri == null || data == null) {
            pendingSlot = null
            return@registerForActivityResult
        }
        try {
            writeBytes(uri, data)
            binUri = uri
            binFile = null
            binName = displayName(uri) ?: binName
            binOriginal = data
            backedUp = true // the new file is already a copy
            if (pendingSlot != null) {
                createSlotLauncher.launch(pendingSlotName.ifEmpty { "data0001.binslot" })
            } else {
                slotUri = null
                slotFile = null
                callJs("window.__onSaved(${JSONObject.quote(binName)})")
            }
        } catch (e: Exception) {
            pendingSlot = null
            reportError("save_fail", e.message)
        }
    }

    private val createSlotLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri ->
        val data = pendingSlot
        pendingSlot = null
        if (uri == null || data == null) {
            reportError("slot_not_saved")
            return@registerForActivityResult
        }
        try {
            writeBytes(uri, data)
            slotUri = uri
            slotFile = null
            slotName = displayName(uri) ?: slotName
            slotOriginal = data
            callJs("window.__onSaved(${JSONObject.quote(binName)})")
        } catch (e: Exception) {
            reportError("slot_save_fail", e.message)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.p4g_bg))
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false      // assets under file:///android_asset stay reachable
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return !request.url.toString().startsWith("file:///android_asset/")
            }
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.loadUrl("file:///android_asset/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__back ? window.__back() : 'exit')") { result ->
                    if (result == null || result.contains("exit")) finish()
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // Back from the "All files access" settings screen.
        if (awaitingPermission && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            awaitingPermission = false
            if (hasStorageAccess()) doScan(lastScanPath) else reportError("perm_denied")
        }
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("AndroidBridge")
        super.onDestroy()
    }

    // ---------------------------------------------------------------- bridge
    /** Called from JavaScript on a WebView background thread. */
    inner class Bridge {
        @JavascriptInterface
        fun openFile() {
            runOnUiThread { openLauncher.launch(arrayOf("*/*")) }
        }

        /** Lists the save slots (data0001.bin ...) found under [path]; the result arrives via window.__onScanResult. */
        @JavascriptInterface
        fun scanSaves(path: String) {
            lastScanPath = path
            if (!hasStorageAccess()) {
                callJs("window.__onScanResult({\"status\":\"permission\"})")
                return
            }
            doScan(path)
        }

        /** Opens the system screen where the user allows access to all files. The scan resumes automatically. */
        @JavascriptInterface
        fun requestStorageAccess() {
            runOnUiThread {
                awaitingPermission = true
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
                        )
                    } catch (e: Exception) {
                        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                } else {
                    storagePermLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
            }
        }

        /** Opens a slot found by [scanSaves]. [slotPath] may be empty (Vita saves have no .binslot). */
        @JavascriptInterface
        fun openPath(binPath: String, slotPath: String) {
            try {
                val root = scanRoot ?: throw IllegalStateException("no folder scanned")
                val bf = File(binPath).canonicalFile
                if (!bf.path.startsWith(root + File.separator) || !saveNameRegex.matches(bf.name)) {
                    throw SecurityException("not a save file inside the scanned folder")
                }
                var sf: File? = null
                if (slotPath.isNotEmpty()) {
                    val c = File(slotPath).canonicalFile
                    if (!c.path.startsWith(root + File.separator) || !c.name.endsWith(".binslot", ignoreCase = true)) {
                        throw SecurityException("not a .binslot inside the scanned folder")
                    }
                    sf = c
                }
                val binBytes = bf.readBytes()
                val slotBytes = sf?.readBytes()

                binFile = bf; binUri = null; binName = bf.name; binOriginal = binBytes
                slotFile = sf; slotUri = null; slotName = sf?.name ?: ""; slotOriginal = slotBytes
                backedUp = false

                val files = JSONArray()
                files.put(
                    JSONObject().put("name", bf.name).put("b64", Base64.encodeToString(binBytes, Base64.NO_WRAP))
                )
                if (sf != null && slotBytes != null) {
                    files.put(
                        JSONObject().put("name", sf.name).put("b64", Base64.encodeToString(slotBytes, Base64.NO_WRAP))
                    )
                }
                callJs("window.__onFilesOpened($files)")
            } catch (e: Exception) {
                reportError("open_fail", e.message)
            }
        }

        /** Overwrite the opened .bin (and .binslot when slotBase64 is not empty). */
        @JavascriptInterface
        fun saveFile(binBase64: String, slotBase64: String) {
            val bf = binFile
            val sf = slotFile
            val bu = binUri
            val su = slotUri
            val hasSlot = slotBase64.isNotEmpty()
            val canOverwrite = if (bf != null) (!hasSlot || sf != null) else (bu != null && (!hasSlot || su != null))
            if (!canOverwrite) {
                saveFileAs(binName, binBase64, slotName, slotBase64)
                return
            }
            try {
                val bin = Base64.decode(binBase64, Base64.DEFAULT)
                val slot = if (hasSlot) Base64.decode(slotBase64, Base64.DEFAULT) else null
                backupOnce()
                if (bf != null) {
                    bf.writeBytes(bin)
                    if (slot != null && sf != null) sf.writeBytes(slot)
                } else if (bu != null) {
                    writeBytes(bu, bin)
                    if (slot != null && su != null) writeBytes(su, slot)
                }
                // read everything back: a half-written or silently truncated file must never be reported as saved
                val back = if (bf != null) bf.readBytes() else contentResolver.openInputStream(bu!!)?.use { it.readBytes() }
                if (back == null || !back.contentEquals(bin)) {
                    reportError("verify_fail")
                    return
                }
                if (slot != null) {
                    val sback = if (sf != null) sf.readBytes() else contentResolver.openInputStream(su!!)?.use { it.readBytes() }
                    if (sback == null || !sback.contentEquals(slot)) {
                        reportError("verify_fail")
                        return
                    }
                }
                callJs("window.__onSaved(${JSONObject.quote(binName)})")
            } catch (e: Exception) {
                reportError("save_fail", e.message)
            }
        }

        @JavascriptInterface
        fun saveFileAs(suggestedName: String, binBase64: String, slotSuggestedName: String, slotBase64: String) {
            try {
                pendingBin = Base64.decode(binBase64, Base64.DEFAULT)
                pendingSlot = if (slotBase64.isNotEmpty()) Base64.decode(slotBase64, Base64.DEFAULT) else null
                pendingSlotName = slotSuggestedName
            } catch (e: Exception) {
                reportError("invalid_data", e.message)
                return
            }
            runOnUiThread { createBinLauncher.launch(suggestedName) }
        }

        /** JSON array of {name,size,modified} for every backup copy, newest first. */
        @JavascriptInterface
        fun listBackups(): String {
            val arr = JSONArray()
            try {
                backupDir().listFiles()
                    ?.filter { it.isFile && it.name.endsWith(".bak") }
                    ?.sortedByDescending { it.lastModified() }
                    ?.take(300)
                    ?.forEach { arr.put(JSONObject().put("name", it.name).put("size", it.length()).put("modified", it.lastModified())) }
            } catch (ignored: Exception) {
                // an unreadable backup folder just shows as empty
            }
            return arr.toString()
        }

        /** Base64 of one backup file, or "" when it does not exist / the name is not a plain file name. */
        @JavascriptInterface
        fun readBackup(name: String): String {
            if (name.contains('/') || name.contains('\\') || name.contains("..")) return ""
            return try {
                val f = File(backupDir(), name)
                if (f.isFile) Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) else ""
            } catch (ignored: Exception) {
                ""
            }
        }

        /** Deletes one backup file. Returns true when it is gone. */
        @JavascriptInterface
        fun deleteBackup(name: String): Boolean {
            if (name.contains('/') || name.contains('\\') || name.contains("..")) return false
            return try {
                val f = File(backupDir(), name)
                !f.exists() || f.delete()
            } catch (ignored: Exception) {
                false
            }
        }

        /** Locks / unlocks a backup (locked ones end in ".keep.bak" and are never pruned). Returns the new name, or "" on failure. */
        @JavascriptInterface
        fun toggleBackupLock(name: String): String {
            if (name.contains('/') || name.contains('\\') || name.contains("..") || !name.endsWith(".bak")) return ""
            return try {
                val f = File(backupDir(), name)
                val newName = if (name.endsWith(".keep.bak")) name.removeSuffix(".keep.bak") + ".bak" else name.removeSuffix(".bak") + ".keep.bak"
                if (f.isFile && f.renameTo(File(backupDir(), newName))) newName else ""
            } catch (ignored: Exception) {
                ""
            }
        }

        /** Android share sheet with plain text (used for Persona exports). */
        @JavascriptInterface
        fun shareText(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                startActivity(Intent.createChooser(send, null))
            }
        }

        /** Android share sheet for a file (base64 content); the copy lives in the app cache. */
        @JavascriptInterface
        fun shareFile(name: String, b64: String) {
            try {
                val dir = File(cacheDir, "share").apply { mkdirs() }
                val f = File(dir, File(name).name)
                f.writeBytes(Base64.decode(b64, Base64.DEFAULT))
                val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f)
                runOnUiThread {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "application/octet-stream"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(send, null))
                }
            } catch (e: Exception) {
                reportError("share_fail", e.message)
            }
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finish() }
        }
    }

    // ------------------------------------------------- direct save folder access
    private fun hasStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }

    /** Resolves [path]; tolerates different letter case below /storage/emulated/0 ("persona 4 golden" vs "Persona 4 Golden"). */
    private fun resolveDir(path: String): File? {
        val direct = File(path)
        if (direct.isDirectory) return direct
        val base = Environment.getExternalStorageDirectory().absolutePath
        if (!path.startsWith("$base/")) return null
        var cur = File(base)
        for (seg in path.substring(base.length + 1).split('/').filter { it.isNotEmpty() }) {
            cur = cur.listFiles()?.firstOrNull { it.isDirectory && it.name.equals(seg, ignoreCase = true) } ?: return null
        }
        return cur
    }

    private fun findSaves(dir: File, depth: Int, out: MutableList<File>) {
        if (depth > 6 || out.size >= 200) return
        val kids = dir.listFiles() ?: return
        for (f in kids.sortedBy { it.name.lowercase(Locale.ROOT) }) {
            if (f.isDirectory) findSaves(f, depth + 1, out)
            else if (saveNameRegex.matches(f.name)) out.add(f)
        }
    }

    private fun slotFor(bin: File): File? {
        val want = bin.name.dropLast(4) + ".binslot"
        return bin.parentFile?.listFiles()?.firstOrNull { it.isFile && it.name.equals(want, ignoreCase = true) }
    }

    /** First two text fields of a .binslot: "<name> Lv:N" and "<date>:<place>". */
    private fun slotInfo(slot: File?): String {
        if (slot == null) return ""
        try {
            val b = slot.readBytes()
            if (b.size < 64) return ""
            val parts = ArrayList<String>()
            var i = 44
            while (i < minOf(b.size, 300) && parts.size < 2) {
                if (b[i].toInt() == 0) { i++; continue }
                var j = i
                while (j < b.size && b[j].toInt() != 0) j++
                parts.add(String(b, i, j - i, Charsets.UTF_8))
                i = j
            }
            return parts.joinToString(" · ")
        } catch (e: Exception) {
            return ""
        }
    }

    private fun doScan(path: String) {
        Thread {
            try {
                val root = resolveDir(path)
                if (root == null) {
                    callJs("window.__onScanResult(${JSONObject().put("status", "not_found").put("path", path)})")
                    return@Thread
                }
                val canonical = root.canonicalPath
                scanRoot = canonical
                val found = ArrayList<File>()
                findSaves(root, 0, found)
                val slots = JSONArray()
                for (bin in found) {
                    val slot = slotFor(bin)
                    val rel = bin.parentFile?.canonicalPath?.removePrefix(canonical)?.trimStart('/') ?: ""
                    slots.put(
                        JSONObject()
                            .put("bin", bin.canonicalPath)
                            .put("slot", slot?.canonicalPath ?: "")
                            .put("name", bin.name)
                            .put("dir", rel)
                            .put("size", bin.length())
                            .put("modified", bin.lastModified())
                            .put("info", slotInfo(slot))
                    )
                }
                val result = JSONObject()
                    .put("status", if (found.isEmpty()) "empty" else "ok")
                    .put("path", path)
                    .put("root", canonical)
                    .put("slots", slots)
                callJs("window.__onScanResult($result)")
            } catch (e: Exception) {
                reportError("scan_fail", e.message)
            }
        }.start()
    }

    // ------------------------------------------------------------- file I/O
    private fun handleOpened(uris: List<Uri>) {
        try {
            var bin: Pair<Uri, ByteArray>? = null
            var slot: Pair<Uri, ByteArray>? = null
            val files = JSONArray()
            for (uri in uris) {
                try {
                    contentResolver.takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
                } catch (ignored: Exception) {
                    // provider does not support persistable grants; the grant lasts for this session
                }
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalStateException("cannot read file")
                val name = displayName(uri) ?: "save.bin"
                if (name.endsWith(".binslot", ignoreCase = true)) {
                    slot = Pair(uri, bytes); slotName = name
                } else if (bin == null) {
                    bin = Pair(uri, bytes); binName = name
                }
                files.put(
                    JSONObject()
                        .put("name", name)
                        .put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                )
            }
            if (bin == null) throw IllegalStateException("no .bin file selected")
            binUri = bin.first; binOriginal = bin.second; binFile = null
            slotUri = slot?.first; slotOriginal = slot?.second; slotFile = null
            if (slot == null) slotName = ""
            backedUp = false
            callJs("window.__onFilesOpened($files)")
        } catch (e: Exception) {
            reportError("open_fail", e.message)
        }
    }

    private fun writeBytes(uri: Uri, data: ByteArray) {
        val out = contentResolver.openOutputStream(uri, "wt")
            ?: throw IllegalStateException("cannot write file")
        out.use { it.write(data); it.flush() }
    }

    private fun backupDir(): File = File(getExternalFilesDir(null) ?: filesDir, "backups")

    /** Keeps copies of the files exactly as first opened, once per opened save. */
    private fun backupOnce() {
        if (backedUp) return
        val dir = backupDir().apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        binOriginal?.let { File(dir, "$binName-$stamp.bak").writeBytes(it) }
        slotOriginal?.let { File(dir, "$slotName-$stamp.bak").writeBytes(it) }
        backedUp = true
        // keep the newest 40 unlocked backups so storage cannot fill up
        dir.listFiles()
            ?.filter { it.isFile && it.name.endsWith(".bak") && !it.name.endsWith(".keep.bak") }
            ?.sortedByDescending { it.lastModified() }
            ?.drop(40)
            ?.forEach { it.delete() }
    }

    private fun displayName(uri: Uri): String? =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    private fun callJs(script: String) {
        runOnUiThread { web.evaluateJavascript(script, null) }
    }

    /** The page translates [code] (see i18n.js, keys err_*); [detail] is appended where the text has {detail}. */
    private fun reportError(code: String, detail: String? = null) {
        callJs("window.__onError(${JSONObject.quote(code)}, ${JSONObject.quote(detail ?: "")})")
    }
}
