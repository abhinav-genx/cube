package expo.modules.cubenative

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.ImageView
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

private const val STORE = "AndroidKeyStore"
private const val SHARE_REQUEST = 0xC0BE
private const val ALG = KeyProperties.KEY_ALGORITHM_HMAC_SHA256

/**
 * Cube's hardware-bound PIN key (SRS: the PIN step must run on this phone).
 *
 * An HMAC-SHA256 key is generated inside Android Keystore (StrongBox when the phone has it,
 * otherwise the TEE) and can never be exported. Slot keys are HMAC(key, Argon2id(PIN)), so
 * every PIN guess has to go through this phone's secure hardware. Unlike the previous design,
 * no secret is ever handed to JavaScript, so hooking the app no longer yields anything that
 * allows guessing off the phone.
 *
 * With user authentication required, API 30+ authorises exactly one HMAC per biometric or
 * device-credential prompt (auth-per-use with a CryptoObject). Older versions fall back to a
 * 5-second window after the prompt.
 *
 * The module also previews, exports and imports vault files without their plaintext entering
 * JavaScript. Imports are cleaned by kind on the way in (importInto): photos by CubeStrip; PDF,
 * Office / OpenDocument / EPUB, RTF and SVG by CubeDocClean; videos and audio by CubeMediaClean.
 */
class CubeNativeModule : Module() {
  // A Mac the user has just authorised with a prompt (per-use keys). Used for one HMAC, then gone.
  private var authorized: Mac? = null

  // Exports prepared on the JS thread (key copied out of JavaScript) and run in the background.
  private val exports = HashMap<Int, PreparedExport>()
  private val nextExport = AtomicInteger(1)
  // Photo imports prepared on the JS thread (file key copied out of JavaScript), run in the background.
  private val imports = HashMap<Int, ByteArray>()
  // The share sheet started by runShare, resolved when the user comes back from it.
  private var sharePromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("CubeNative")

    Function("hardwareKeysAvailable") { true }

    Function("hasKey") { alias: String -> keyStore().containsAlias(alias) }

    Function("deleteKey") { alias: String ->
      authorized = null
      keyStore().deleteEntry(alias)
    }

    Function("createKey") { alias: String, requireAuth: Boolean, requireHardware: Boolean ->
      createKey(alias, requireAuth, requireHardware)
    }

    AsyncFunction("authenticate") { alias: String, title: String, promise: Promise ->
      authenticate(alias, title, promise)
    }.runOnQueue(Queues.MAIN)

    // Writes HMAC(key, data) into `out` (32 bytes). Typed arrays in and out, so no key material
    // passes through a JavaScript string.
    Function("mac") { alias: String, data: Uint8Array, out: Uint8Array ->
      val input = ByteArray(data.byteLength)
      data.read(input, 0, input.size)
      val m = authorized ?: Mac.getInstance(ALG).apply { init(key(alias)) }
      authorized = null
      val result = try {
        m.doFinal(input)
      } catch (e: Exception) {
        throw CodedException("E_KEY_USE", "The hardware key refused the operation: ${e.message}", e)
      } finally {
        input.fill(0)
      }
      out.write(result, 0, result.size)
      result.fill(0)
    }

    // iOS only (see ios/CubeNativeModule.swift). Android backups are handled in the manifest.
    Function("excludeFromBackup") { _: String -> }

    // ---- native preview and export: decrypted bytes never enter JavaScript ----------------
    // Every supported version: CubeCrypto falls back to pure Kotlin where Android 7-8 lack the cipher.
    Function("nativePreviewAvailable") { true }

    // Decrypts a vault blob (format 1: vault key; 2: chunked, per-file key) and decodes it as an
    // image, entirely in native memory. Returns a handle for CubeImageView; plaintext bytes are
    // zeroed as soon as the bitmap exists.
    Function("openImage") { uri: String, key: Uint8Array, format: Int ->
      val plain = decrypt(uri, key, format)
      try {
        val opts = BitmapFactory.Options().apply { inMutable = true }   // so close can wipe it
        val bmp = BitmapFactory.decodeByteArray(plain.bytes, 0, plain.length, opts)
          ?: throw CodedException("E_IMAGE", "Not an image this phone can show", null)
        ViewRegistry.put(bmp)
      } finally {
        plain.bytes.fill(0)
      }
    }

    // Decrypts a text file natively and keeps it for CubeImageView (up to maxBytes; longer files
    // are cut, with a note). Kotlin strings cannot be wiped either, but they stay out of the JS heap.
    Function("openText") { uri: String, key: Uint8Array, format: Int, maxBytes: Int ->
      val plain = decrypt(uri, key, format)
      try {
        val n = minOf(plain.length, maxBytes)
        var text = String(plain.bytes, 0, n, Charsets.UTF_8)
        if (n < plain.length) text += "\n\n…"
        ViewRegistry.put(text)
      } finally {
        plain.bytes.fill(0)
      }
    }

    // Android 11+: decrypts a PDF into a memory file (never storage) for CubeImageView; see PdfDoc.
    // Throws for older Android and for damaged or password-protected PDFs (no preview).
    Function("openPdf") { uri: String, key: Uint8Array, format: Int ->
      if (Build.VERSION.SDK_INT < 30) {
        throw CodedException("E_PDF", "PDF preview needs Android 11 or later", null)
      }
      val plain = decrypt(uri, key, format)
      try {
        val doc = try {
          PdfDoc.open(plain.bytes, plain.length)
        } catch (e: Exception) {
          throw CodedException("E_PDF", "This PDF cannot be shown: ${e.message}", e)
        }
        ViewRegistry.put(doc)
      } finally {
        plain.bytes.fill(0)
      }
    }

    Function("closeImage") { handle: Int -> ViewRegistry.remove(handle) }

    // Export in two steps: prepare (on the JS thread, where the key's typed array can be read)
    // copies the key; runExport decrypts into the destination file in the background, streaming
    // chunked files 64 KiB at a time.
    Function("prepareExport") { uri: String, key: Uint8Array, format: Int ->
      val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
      val id = nextExport.getAndIncrement()
      synchronized(exports) { exports[id] = PreparedExport(path(uri), k, format) }
      id
    }

    AsyncFunction("runExport") { id: Int, destUri: String ->
      val job = synchronized(exports) { exports.remove(id) }
        ?: throw CodedException("E_EXPORT", "No such export", null)
      try {
        val src = File(job.path)
        val dest = File(path(destUri))
        if (job.format == 2) {
          src.inputStream().buffered().use { input ->
            dest.outputStream().use { out -> CubeCrypto.streamV2(job.key, input, src.length(), out) }
          }
        } else {
          val plain = CubeCrypto.openV1(job.key, src.readBytes())
          try {
            dest.outputStream().use { it.write(plain.bytes, 0, plain.length) }
          } finally {
            plain.bytes.fill(0)
          }
        }
      } catch (e: CubeCrypto.CorruptException) {
        File(path(destUri)).delete()
        throw CodedException("E_CORRUPT", "Could not decrypt", e)
      } finally {
        job.key.fill(0)
      }
    }

    // Import in two steps, like export: prepare copies the new file's key; runImport reads the picked
    // file (file:// or content://), cleans it by kind (photos: CubeStrip; PDF, Office, OpenDocument,
    // EPUB, RTF and SVG: CubeDocClean; videos and audio: CubeMediaClean) and writes it encrypted to
    // destUri, streaming where it can. It never enters JavaScript.
    Function("prepareImport") { key: Uint8Array ->
      val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
      val id = nextExport.getAndIncrement()
      synchronized(imports) { imports[id] = k }
      id
    }

    AsyncFunction("runImport") { id: Int, srcUri: String, destUri: String, kind: String? ->
      val key = synchronized(imports) { imports.remove(id) }
        ?: throw CodedException("E_IMPORT", "No such import", null)
      val dest = File(path(destUri))
      try {
        dest.outputStream().buffered(1 shl 20).use { out ->
          val writer = CubeCrypto.V2Writer(key, out)
          importInto(srcUri, kind ?: "image", writer)
          writer.finish()
          out.flush()
          mapOf("size" to writer.plainBytes.toDouble(), "blobBytes" to writer.blobBytes.toDouble())
        }
      } catch (e: Exception) {
        dest.delete()
        if (e is CodedException) throw e
        throw CodedException("E_IMPORT", "Could not add the file: ${e.message}", e)
      } finally {
        key.fill(0)
      }
    }

    // Export without a readable copy (CubeExportProvider): prepare registers the file with a copy of
    // its key and returns a token; runShare opens the share sheet for content://…/<token>/<name> and
    // resolves when the user comes back. endShares ends every share (call it when the vault locks).
    Function("prepareShare") { uri: String, key: Uint8Array, format: Int, name: String, mime: String, size: Double ->
      val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
      ShareRegistry.add(path(uri), k, format, name, mime, size.toLong())
    }

    AsyncFunction("runShare") { token: String, name: String, mime: String, promise: Promise ->
      val activity = appContext.currentActivity
      val ctx = appContext.reactContext
      if (activity == null || ctx == null) {
        promise.reject(CodedException("E_SHARE", "No activity to share from", null))
        return@AsyncFunction
      }
      val uri = Uri.Builder().scheme("content").authority(ctx.packageName + ".cubeexport")
        .appendPath(token).appendPath(name).build()
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newUri(ctx.contentResolver, name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      sharePromise?.resolve(null)
      sharePromise = promise
      activity.startActivityForResult(Intent.createChooser(send, name), SHARE_REQUEST)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == SHARE_REQUEST) {
        sharePromise?.resolve(null)
        sharePromise = null
      }
    }

    Function("endShares") { ShareRegistry.clear() }

    // The keyboard that will receive passphrase keystrokes: third-party keyboards see every key.
    // null when it cannot be determined.
    Function("keyboardInfo") {
      val ctx = appContext.reactContext ?: return@Function null
      val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        ?: return@Function null
      val imm = ctx.getSystemService(InputMethodManager::class.java) ?: return@Function null
      val info = imm.inputMethodList.firstOrNull { it.id == id } ?: return@Function null
      val flags = info.serviceInfo.applicationInfo.flags
      val system = flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
      mapOf("thirdParty" to !system, "name" to info.loadLabel(ctx.packageManager).toString())
    }

    View(CubeImageView::class) {
      Prop("handle") { view: CubeImageView, handle: Int -> view.show(ViewRegistry.get(handle)) }
      Prop("textColor") { view: CubeImageView, color: String? -> view.setTextColor(color) }
      Prop("fontSize") { view: CubeImageView, size: Double? -> view.setFontSize(size) }
    }
  }

  private fun path(uri: String) = Uri.parse(uri).path ?: uri

  /** Reads, cleans and encrypts one picked file by kind; see index.ts runImport. */
  private fun importInto(srcUri: String, kind: String, writer: CubeCrypto.V2Writer) {
    when (kind) {
      "image" -> {
        // Photos are cleaned whole (their metadata can sit anywhere); CubeStrip gives lib/strip.ts's bytes.
        val raw = openSource(srcUri).use { it.readBytes() }
        val clean = CubeStrip.strip(raw)
        raw.fill(0)
        try { writer.write(clean) } finally { clean.fill(0) }
      }
      "office" -> {
        // Office 97–2003 (OLE compound files): same-length patches found reading in place, laid over
        // the file as it streams. Office, OpenDocument and EPUB zips: rebuilt entry by entry, read in place.
        val cfb = withRandomSource(srcUri) { src ->
          if (CubeDocClean.isCfb(src.read(0, minOf(8L, src.size).toInt()), src.size)) CubeDocClean.cfbPatches(src) else null
        }
        if (cfb != null) {
          try {
            streamPatched(srcUri, cfb) { b, n -> writer.write(b, 0, n) }
          } finally {
            wipe(cfb)
          }
        } else {
          val cleaned = withRandomSource(srcUri) { src -> CubeDocClean.cleanOffice(src) { writer.write(it) } } ?: false
          if (!cleaned) stream(srcUri) { b, n -> writer.write(b, 0, n) }
        }
      }
      "pdf" -> {
        // Compressed object and XMP streams and JPEG photos first (same-length patches, found reading
        // in place), then everything through the streaming cleaner.
        val patches = withRandomSource(srcUri) { CubeDocClean.pdfStreamPatches(it) } ?: emptyList()
        val cleaner = CubeDocClean.PdfCleaner()
        try {
          streamPatched(srcUri, patches) { b, n ->
            val done = cleaner.push(b, 0, n)
            writer.write(done)
            done.fill(0)
          }
        } finally {
          wipe(patches)
        }
        val tail = cleaner.finish()
        writer.write(tail)
        tail.fill(0)
      }
      "media" -> {
        // Videos and audio: same-length patches over box, frame and chunk headers (found reading in place).
        val patches = withRandomSource(srcUri) { CubeMediaClean.patches(it) } ?: emptyList()
        try {
          streamPatched(srcUri, patches) { b, n -> writer.write(b, 0, n) }
        } finally {
          wipe(patches)
        }
      }
      "rtf" -> {
        val cleaner = CubeDocClean.RtfCleaner()
        stream(srcUri) { b, n ->
          val done = cleaner.push(b, 0, n)
          writer.write(done)
          done.fill(0)
        }
        val tail = cleaner.finish()
        writer.write(tail)
        tail.fill(0)
      }
      "svg" -> {
        // Any size, streaming: XmlCleaner gives the same bytes as cleaning the whole file at once.
        val cleaner = CubeDocClean.XmlCleaner(CubeDocClean.SVG_RULES)
        stream(srcUri) { b, n ->
          val done = cleaner.push(b, 0, n)
          writer.write(done)
          done.fill(0)
        }
        val tail = cleaner.finish()
        writer.write(tail)
        tail.fill(0)
      }
      else -> stream(srcUri) { b, n -> writer.write(b, 0, n) }
    }
  }

  /** Hands the source to `body` 1 MiB at a time with `patches` laid over it (same-length, by offset). */
  private fun streamPatched(uri: String, patches: List<CubeDocClean.Patch>, body: (ByteArray, Int) -> Unit) {
    var offset = 0L
    stream(uri) { b, n ->
      for (p in patches) {
        val from = maxOf(p.at, offset)
        val to = minOf(p.at + p.length, offset + n)
        if (from < to) System.arraycopy(p.bytes, (from - p.at).toInt(), b, (from - offset).toInt(), (to - from).toInt())
      }
      offset += n
      body(b, n)
    }
  }

  /** Zeroes the patches' plaintext (the shared block of zeros is left alone). */
  private fun wipe(patches: List<CubeDocClean.Patch>) {
    for (p in patches) if (p.bytes !== CubeMediaClean.ZERO) p.bytes.fill(0)
  }

  /** Hands the source to `body` 1 MiB at a time. */
  private fun stream(uri: String, body: (ByteArray, Int) -> Unit) {
    openSource(uri).use { streamFrom(it, body) }
  }

  /** Hands the rest of `input` to `body` 1 MiB at a time. */
  private fun streamFrom(input: java.io.InputStream, body: (ByteArray, Int) -> Unit) {
    val buf = ByteArray(1 shl 20)
    try {
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        if (n > 0) body(buf, n)
      }
    } finally {
      buf.fill(0)
    }
  }

  /**
   * Runs body with the file readable at any offset, in place. Returns null when the provider
   * cannot seek (a pipe); the caller then stores the file unchanged.
   */
  private fun <T> withRandomSource(uri: String, body: (CubeDocClean.RandomSource) -> T): T? {
    val pfd = if (uri.startsWith("content://")) {
      val resolver = appContext.reactContext?.contentResolver ?: return null
      unavailable { resolver.openFileDescriptor(Uri.parse(uri), "r") } ?: return null
    } else {
      android.os.ParcelFileDescriptor.open(File(path(uri)), android.os.ParcelFileDescriptor.MODE_READ_ONLY)
    }
    return pfd.use {
      java.io.FileInputStream(it.fileDescriptor).use { input ->
        val src = runCatching { CubeDocClean.ChannelSource(input.channel).also { s -> s.read(0, minOf(4L, s.size).toInt()) } }
          .getOrNull() ?: return null
        body(src)
      }
    }
  }

  private fun openSource(uri: String): java.io.InputStream =
    if (uri.startsWith("content://")) {
      val resolver = appContext.reactContext?.contentResolver
        ?: throw CodedException("E_IMPORT", "Could not open the picked file", null)
      unavailable { resolver.openInputStream(Uri.parse(uri)) }
        ?: throw CodedException("E_IMPORT", "Could not open the picked file", null)
    } else {
      File(path(uri)).inputStream()
    }

  /**
   * Opens a picked content:// file: a cloud file that cannot be read now (not downloaded and
   * offline, or access gone) rejects with E_UNAVAILABLE, which JavaScript explains to the user.
   */
  private fun <T> unavailable(open: () -> T): T =
    try {
      open()
    } catch (e: java.io.FileNotFoundException) {
      throw CodedException("E_UNAVAILABLE", "The picked file cannot be read right now: ${e.message}", e)
    } catch (e: SecurityException) {
      throw CodedException("E_UNAVAILABLE", "The picked file cannot be read right now: ${e.message}", e)
    }

  private fun decrypt(uri: String, key: Uint8Array, format: Int): CubeCrypto.Plain {
    val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
    try {
      return CubeCrypto.open(format, k, File(path(uri)).readBytes())
    } catch (e: CubeCrypto.CorruptException) {
      throw CodedException("E_CORRUPT", "Could not decrypt", e)
    } finally {
      k.fill(0)
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  private fun key(alias: String): SecretKey =
    keyStore().getKey(alias, null) as? SecretKey
      ?: throw CodedException("E_NO_KEY", "No hardware key", null)

  private fun keyInfo(k: SecretKey): KeyInfo =
    SecretKeyFactory.getInstance(k.algorithm, STORE).getKeySpec(k, KeyInfo::class.java) as KeyInfo

  private fun createKey(alias: String, requireAuth: Boolean, requireHardware: Boolean) {
    authorized = null
    keyStore().deleteEntry(alias)

    fun spec(strongBox: Boolean): KeyGenParameterSpec {
      val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      if (requireAuth) {
        b.setUserAuthenticationRequired(true)
        // Adding or removing a fingerprint must not destroy the vault.
        b.setInvalidatedByBiometricEnrollment(false)
        if (Build.VERSION.SDK_INT >= 30) {
          b.setUserAuthenticationParameters(
            0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
          )
        } else {
          @Suppress("DEPRECATION")
          b.setUserAuthenticationValidityDurationSeconds(5)
        }
      }
      if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
      return b.build()
    }

    val gen = KeyGenerator.getInstance(ALG, STORE)
    try {
      try {
        gen.init(spec(strongBox = true))
        gen.generateKey()
      } catch (e: StrongBoxUnavailableException) {
        gen.init(spec(strongBox = false))
        gen.generateKey()
      }
    } catch (e: IllegalStateException) {
      // Thrown when user authentication is required but no secure lock screen is set.
      throw CodedException("E_NO_LOCK_SCREEN", "Set a device lock screen first", e)
    } catch (e: java.security.InvalidAlgorithmParameterException) {
      throw CodedException("E_NO_LOCK_SCREEN", "Set a device lock screen first", e)
    }

    if (requireHardware && !insideSecureHardware(key(alias))) {
      keyStore().deleteEntry(alias)
      throw CodedException("E_NO_SECURE_HARDWARE", "This device cannot keep keys in secure hardware", null)
    }
  }

  private fun insideSecureHardware(k: SecretKey): Boolean {
    val info = keyInfo(k)
    return if (Build.VERSION.SDK_INT >= 31) {
      info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ||
        info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    } else {
      @Suppress("DEPRECATION")
      info.isInsideSecureHardware
    }
  }

  private fun authenticate(alias: String, title: String, promise: Promise) {
    authorized = null
    val k = try {
      key(alias)
    } catch (e: CodedException) {
      promise.reject(e)
      return
    }
    if (!keyInfo(k).isUserAuthenticationRequired) {
      promise.resolve(null)                       // testing builds: no prompt
      return
    }
    val activity = appContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject(CodedException("E_AUTH_NO_ACTIVITY", "No activity to show the prompt in", null))
      return
    }

    val perUse = Build.VERSION.SDK_INT >= 30
    val mac = if (perUse) Mac.getInstance(ALG).apply { init(k) } else null

    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        authorized = result.cryptoObject?.mac
        promise.resolve(null)
      }

      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        val code = when (errorCode) {
          BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
          BiometricPrompt.ERROR_CANCELED -> "E_AUTH_CANCELLED"
          BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "E_AUTH_LOCKOUT"
          BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "E_NO_LOCK_SCREEN"
          else -> "E_AUTH_FAILED"
        }
        promise.reject(CodedException(code, errString.toString(), null))
      }
    }

    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle(title)
      .setAllowedAuthenticators(
        if (perUse) Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL
        else Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL,
      )
      .build()
    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
    if (mac != null) prompt.authenticate(info, BiometricPrompt.CryptoObject(mac)) else prompt.authenticate(info)
  }
}

// ---- native preview helpers ---------------------------------------------------------------

internal class PreparedExport(val path: String, val key: ByteArray, val format: Int)

/**
 * Decoded images, decrypted texts and PDFs by handle. Closing wipes a bitmap's pixels before
 * letting it go, and closes a PDF (memory file zeroed, page bitmaps wiped).
 */
internal object ViewRegistry {
  private val items = HashMap<Int, Any>()
  private var next = 1

  @Synchronized fun put(item: Any): Int = next++.also { items[it] = item }
  @Synchronized fun get(h: Int): Any? = items[h]
  @Synchronized fun remove(h: Int) {
    val item = items.remove(h)
    if (item is Bitmap && item.isMutable && !item.isRecycled) item.eraseColor(0)
    if (item is PdfDoc) item.close()
  }
}

private const val MAX_CACHED_PAGES = 8   // page bitmaps kept beyond the ones on screen

/**
 * Shows what a handle refers to: an image (fit to the view), text (scrolling) or a PDF (pages
 * one under another at the view's width, rendered as they scroll into view).
 */
class CubeImageView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val image = ImageView(context).apply {
    scaleType = ImageView.ScaleType.FIT_CENTER
    layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  private val text = TextView(context).apply {
    setTextIsSelectable(false)
    val pad = (24 * resources.displayMetrics.density).toInt()
    setPadding(pad, pad, pad, pad)
  }
  private val scroll = ScrollView(context).apply {
    layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    addView(text)
    visibility = View.GONE
  }

  // ---- PDF pages (main thread only) ----
  private var pdf: PdfDoc? = null
  private val pageCache = LinkedHashMap<Int, Bitmap>()   // rendered pages by index
  private val pending = HashSet<Int>()                    // pages being rendered
  private val pageViews = ArrayList<ImageView>()          // every page view the list made
  private var renderWidth = 0
  private var generation = 0                              // bumped when cached pages become stale

  private val pageAdapter = object : BaseAdapter() {
    override fun getCount() = pdf?.pageCount ?: 0
    override fun getItem(position: Int): Any = position
    override fun getItemId(position: Int) = position.toLong()
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = false        // nothing to tap or select
    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
      val v = convertView as? ImageView ?: ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_XY
        setBackgroundColor(Color.WHITE)
        isLongClickable = false
        pageViews.add(this)
      }
      val doc = pdf
      val (pw, ph) = doc?.sizes?.getOrNull(position) ?: (1 to 0)
      v.layoutParams = AbsListView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, (renderWidth.toLong() * ph / pw).toInt(),
      )
      v.tag = position
      val bmp = pageCache[position]
      v.setImageBitmap(bmp)
      if (bmp == null) requestPage(position)
      return v
    }
  }

  private val pages = ListView(context).apply {
    layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    setBackgroundColor(Color.TRANSPARENT)
    cacheColorHint = Color.TRANSPARENT
    selector = ColorDrawable(Color.TRANSPARENT)
    divider = ColorDrawable(Color.TRANSPARENT)
    dividerHeight = (8 * resources.displayMetrics.density).toInt()
    isLongClickable = false
    adapter = pageAdapter
    visibility = View.GONE
    addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
      val w = right - left
      if (w > 0 && w != renderWidth) post { resizePages(w) }
    }
  }

  init {
    addView(image)
    addView(scroll)
    addView(pages)
  }

  fun show(item: Any?) {
    if (item !is PdfDoc || item !== pdf) detachPdf()
    when (item) {
      is Bitmap -> {
        image.setImageBitmap(item)
        image.visibility = View.VISIBLE
        scroll.visibility = View.GONE
      }
      is String -> {
        text.text = item
        scroll.visibility = View.VISIBLE
        image.visibility = View.GONE
      }
      is PdfDoc -> {
        if (item !== pdf && !item.closed) {
          pdf = item
          item.addView(this)
          renderWidth = pages.width
          pageAdapter.notifyDataSetChanged()
          pages.setSelection(0)
        }
        pages.visibility = View.VISIBLE
        image.visibility = View.GONE
        scroll.visibility = View.GONE
      }
      else -> {
        image.setImageDrawable(null)
        text.text = ""
      }
    }
  }

  /** Called by the document (main thread) when it is closed: let go of every page. */
  internal fun pdfClosed(doc: PdfDoc) {
    if (pdf === doc) detachPdf()
  }

  private fun requestPage(index: Int) {
    val doc = pdf ?: return
    if (renderWidth <= 0 || !pending.add(index)) return
    val gen = generation
    doc.render(index, renderWidth) { bmp ->
      if (gen != generation || pdf !== doc) {
        doc.release(bmp)
        return@render
      }
      pending.remove(index)
      pageCache[index] = bmp
      for (v in pageViews) if (v.tag == index && v.parent != null) v.setImageBitmap(bmp)
      trimPages(doc)
    }
  }

  /** Wipes rendered pages well away from the screen once more than a few are kept. */
  private fun trimPages(doc: PdfDoc) {
    val first = pages.firstVisiblePosition - 2
    val last = pages.lastVisiblePosition + 2
    val it = pageCache.entries.iterator()
    while (pageCache.size > MAX_CACHED_PAGES && it.hasNext()) {
      val (index, bmp) = it.next()
      if (index in first..last) continue
      it.remove()
      forget(bmp)
      doc.release(bmp)
    }
  }

  /** Takes a bitmap out of every page view, so it can be wiped. */
  private fun forget(bmp: Bitmap) {
    for (v in pageViews) if ((v.drawable as? BitmapDrawable)?.bitmap === bmp) v.setImageDrawable(null)
  }

  private fun dropPages(doc: PdfDoc) {
    generation++
    pending.clear()
    for (v in pageViews) v.setImageDrawable(null)
    for (bmp in pageCache.values) doc.release(bmp)
    pageCache.clear()
  }

  private fun resizePages(width: Int) {
    if (width == renderWidth) return
    renderWidth = width
    val doc = pdf ?: return
    dropPages(doc)
    pageAdapter.notifyDataSetChanged()
  }

  private fun detachPdf() {
    val doc = pdf ?: return
    dropPages(doc)
    doc.removeView(this)
    pdf = null
    pageAdapter.notifyDataSetChanged()
    pages.visibility = View.GONE
  }

  fun setTextColor(color: String?) {
    color?.let { runCatching { text.setTextColor(Color.parseColor(it)) } }
  }

  fun setFontSize(size: Double?) {
    size?.let { text.setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    image.setImageDrawable(null)
    text.text = ""
    detachPdf()
  }
}
