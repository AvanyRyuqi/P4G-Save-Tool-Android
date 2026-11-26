package app.p4gsavetool

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
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

    // currently opened save: the .bin and (Switch only) its companion .binslot
    private var binUri: Uri? = null
    private var binName: String = "save.bin"
    private var binOriginal: ByteArray? = null
    private var slotUri: Uri? = null
    private var slotName: String = ""
    private var slotOriginal: ByteArray? = null
    private var backedUp = false

    // "Save as" state
    private var pendingBin: ByteArray? = null
    private var pendingSlotName: String = ""
    private var pendingSlot: ByteArray? = null

    private val openLauncher = registerForActivityResult(OpenDocumentsRW()) { uris ->
        if (uris.isNotEmpty()) handleOpened(uris)
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
            binName = displayName(uri) ?: binName
            binOriginal = data
            backedUp = true // the new file is already a copy
            if (pendingSlot != null) {
                createSlotLauncher.launch(pendingSlotName.ifEmpty { "data0001.binslot" })
            } else {
                callJs("window.__onSaved(${JSONObject.quote(binName)})")
            }
        } catch (e: Exception) {
            pendingSlot = null
            reportError("Gagal menyimpan: ${e.message}")
        }
    }

    private val createSlotLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri ->
        val data = pendingSlot
        pendingSlot = null
        if (uri == null || data == null) {
            reportError("File .binslot tidak disimpan. Save Switch butuh keduanya.")
            return@registerForActivityResult
        }
        try {
            writeBytes(uri, data)
            slotUri = uri
            slotName = displayName(uri) ?: slotName
            slotOriginal = data
            callJs("window.__onSaved(${JSONObject.quote(binName)})")
        } catch (e: Exception) {
            reportError("Gagal menyimpan .binslot: ${e.message}")
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

        /** Overwrite the opened .bin (and .binslot when slotBase64 is not empty). */
        @JavascriptInterface
        fun saveFile(binBase64: String, slotBase64: String) {
            val uri = binUri
            if (uri == null) {
                saveFileAs(binName, binBase64, slotName, slotBase64)
                return
            }
            val sUri = slotUri
            if (slotBase64.isNotEmpty() && sUri == null) {
                saveFileAs(binName, binBase64, slotName, slotBase64)
                return
            }
            try {
                val bin = Base64.decode(binBase64, Base64.DEFAULT)
                val slot = if (slotBase64.isNotEmpty()) Base64.decode(slotBase64, Base64.DEFAULT) else null
                backupOnce()
                writeBytes(uri, bin)
                if (slot != null && sUri != null) writeBytes(sUri, slot)
                callJs("window.__onSaved(${JSONObject.quote(binName)})")
            } catch (e: Exception) {
                reportError("Gagal menyimpan: ${e.message}")
            }
        }

        @JavascriptInterface
        fun saveFileAs(suggestedName: String, binBase64: String, slotSuggestedName: String, slotBase64: String) {
            try {
                pendingBin = Base64.decode(binBase64, Base64.DEFAULT)
                pendingSlot = if (slotBase64.isNotEmpty()) Base64.decode(slotBase64, Base64.DEFAULT) else null
                pendingSlotName = slotSuggestedName
            } catch (e: Exception) {
                reportError("Data tidak valid: ${e.message}")
                return
            }
            runOnUiThread { createBinLauncher.launch(suggestedName) }
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finish() }
        }
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
                    ?: throw IllegalStateException("tidak bisa membaca file")
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
            if (bin == null) throw IllegalStateException("pilih file save .bin")
            binUri = bin.first; binOriginal = bin.second
            slotUri = slot?.first; slotOriginal = slot?.second
            if (slot == null) slotName = ""
            backedUp = false
            callJs("window.__onFilesOpened($files)")
        } catch (e: Exception) {
            reportError("Gagal membuka file: ${e.message}")
        }
    }

    private fun writeBytes(uri: Uri, data: ByteArray) {
        val out = contentResolver.openOutputStream(uri, "wt")
            ?: throw IllegalStateException("tidak bisa menulis file")
        out.use { it.write(data); it.flush() }
    }

    /** Keeps copies of the files exactly as first opened, once per opened save. */
    private fun backupOnce() {
        if (backedUp) return
        val dir = File(getExternalFilesDir(null) ?: filesDir, "backups").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        binOriginal?.let { File(dir, "$binName-$stamp.bak").writeBytes(it) }
        slotOriginal?.let { File(dir, "$slotName-$stamp.bak").writeBytes(it) }
        backedUp = true
    }

    private fun displayName(uri: Uri): String? =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    private fun callJs(script: String) {
        runOnUiThread { web.evaluateJavascript(script, null) }
    }

    private fun reportError(message: String) {
        callJs("window.__onError(${JSONObject.quote(message)})")
    }
}
