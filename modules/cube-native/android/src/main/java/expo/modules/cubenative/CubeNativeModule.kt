package expo.modules.cubenative

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.ImageView
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

    // Photo import in two steps, like export: prepare copies the new file's key; runImport reads the
    // picked photo (file:// or content://), removes its location and camera details (CubeStrip, the
    // same bytes as lib/strip.ts) and writes it encrypted to destUri. It never enters JavaScript.
    Function("prepareImport") { key: Uint8Array ->
      val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
      val id = nextExport.getAndIncrement()
      synchronized(imports) { imports[id] = k }
      id
    }

    AsyncFunction("runImport") { id: Int, srcUri: String, destUri: String ->
      val key = synchronized(imports) { imports.remove(id) }
        ?: throw CodedException("E_IMPORT", "No such import", null)
      try {
        val raw = openSource(srcUri).use { it.readBytes() }
        val clean = CubeStrip.strip(raw)
        raw.fill(0)
        try {
          val blobBytes = File(path(destUri)).outputStream().buffered().use { out ->
            CubeCrypto.encryptV2(key, clean, clean.size, out)
          }
          mapOf("size" to clean.size, "blobBytes" to blobBytes.toInt())
        } finally {
          clean.fill(0)
        }
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

  private fun openSource(uri: String): java.io.InputStream =
    if (uri.startsWith("content://")) {
      appContext.reactContext?.contentResolver?.openInputStream(Uri.parse(uri))
        ?: throw CodedException("E_IMPORT", "Could not open the picked file", null)
    } else {
      File(path(uri)).inputStream()
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

/** Decoded images and decrypted texts by handle. Closing wipes a bitmap's pixels before letting it go. */
internal object ViewRegistry {
  private val items = HashMap<Int, Any>()
  private var next = 1

  @Synchronized fun put(item: Any): Int = next++.also { items[it] = item }
  @Synchronized fun get(h: Int): Any? = items[h]
  @Synchronized fun remove(h: Int) {
    val item = items.remove(h)
    if (item is Bitmap && item.isMutable && !item.isRecycled) item.eraseColor(0)
  }
}

/** Shows what a handle refers to: an image (fit to the view) or text (scrolling). */
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

  init {
    addView(image)
    addView(scroll)
  }

  fun show(item: Any?) {
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
      else -> {
        image.setImageDrawable(null)
        text.text = ""
      }
    }
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
  }
}
