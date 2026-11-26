package app.p4gsavetool

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Open document contract that also asks for write access, so "Simpan" can overwrite the opened file. */
class OpenDocumentRW : ActivityResultContracts.OpenDocument() {
    override fun createIntent(context: Context, input: Array<String>): Intent =
        super.createIntent(context, input).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
}

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    private var currentUri: Uri? = null
    private var currentName: String = "save.bin"
    private var originalBytes: ByteArray? = null   // bytes as first read, used for the automatic backup
    private var backedUp = false
    private var pendingSaveAs: ByteArray? = null

    private val openLauncher = registerForActivityResult(OpenDocumentRW()) { uri ->
        if (uri != null) handleOpened(uri)
    }

    private val createLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri ->
        val data = pendingSaveAs
        pendingSaveAs = null
        if (uri != null && data != null) {
            try {
                writeBytes(uri, data)
                currentUri = uri
                currentName = displayName(uri) ?: currentName
                originalBytes = data
                backedUp = true // the new file is already a copy
                callJs("window.__onSaved(${JSONObject.quote(currentName)})")
            } catch (e: Exception) {
                reportError("Gagal menyimpan: ${e.message}")
            }
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
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
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

        @JavascriptInterface
        fun saveFile(base64: String) {
            val uri = currentUri
            if (uri == null) {
                saveFileAs(currentName, base64)
                return
            }
            try {
                val data = Base64.decode(base64, Base64.DEFAULT)
                backupOnce()
                writeBytes(uri, data)
                callJs("window.__onSaved(${JSONObject.quote(currentName)})")
            } catch (e: Exception) {
                reportError("Gagal menyimpan: ${e.message}")
            }
        }

        @JavascriptInterface
        fun saveFileAs(suggestedName: String, base64: String) {
            try {
                pendingSaveAs = Base64.decode(base64, Base64.DEFAULT)
            } catch (e: Exception) {
                reportError("Data tidak valid: ${e.message}")
                return
            }
            runOnUiThread { createLauncher.launch(suggestedName) }
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finish() }
        }
    }

    // ------------------------------------------------------------- file I/O
    private fun handleOpened(uri: Uri) {
        try {
            try {
                contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            } catch (ignored: Exception) {
                // provider does not support persistable grants; the grant lasts for this session
            }
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IllegalStateException("tidak bisa membaca file")
            currentUri = uri
            currentName = displayName(uri) ?: "save.bin"
            originalBytes = bytes
            backedUp = false
            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            callJs("window.__onFileOpened(${JSONObject.quote(currentName)}, \"$b64\")")
        } catch (e: Exception) {
            reportError("Gagal membuka file: ${e.message}")
        }
    }

    private fun writeBytes(uri: Uri, data: ByteArray) {
        val out = contentResolver.openOutputStream(uri, "wt")
            ?: throw IllegalStateException("tidak bisa menulis file")
        out.use { it.write(data); it.flush() }
    }

    /** Keeps a copy of the file exactly as it was first opened, once per opened file. */
    private fun backupOnce() {
        if (backedUp) return
        val bytes = originalBytes ?: return
        val dir = File(getExternalFilesDir(null) ?: filesDir, "backups").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        File(dir, "$currentName-$stamp.bak").writeBytes(bytes)
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
