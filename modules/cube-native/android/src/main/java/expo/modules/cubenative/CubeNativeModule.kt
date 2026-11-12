package expo.modules.cubenative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.view.ViewGroup
import android.widget.ImageView
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
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val STORE = "AndroidKeyStore"
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

    // ---- native image preview (A8): decrypted pixels never enter JavaScript ----------------
    Function("nativePreviewAvailable") { Build.VERSION.SDK_INT >= 28 }

    // Decrypts a vault blob (XChaCha20-Poly1305, Cube's padding) and decodes it as an image,
    // entirely in native memory. Returns a handle for CubeImageView; plaintext bytes are zeroed
    // as soon as the bitmap exists.
    Function("openImage") { uri: String, key: Uint8Array ->
      val k = ByteArray(key.byteLength).also { key.read(it, 0, it.size) }
      try {
        val plain = decryptBlob(k, File(Uri.parse(uri).path ?: uri).readBytes())
        try {
          val opts = BitmapFactory.Options().apply { inMutable = true }   // so close can wipe it
          val bmp = BitmapFactory.decodeByteArray(plain.bytes, 0, plain.length, opts)
            ?: throw CodedException("E_IMAGE", "Not an image this phone can show", null)
          ImageRegistry.put(bmp)
        } finally {
          plain.bytes.fill(0)
        }
      } finally {
        k.fill(0)
      }
    }

    Function("closeImage") { handle: Int -> ImageRegistry.remove(handle) }

    View(CubeImageView::class) {
      Prop("handle") { view: CubeImageView, handle: Int -> view.show(ImageRegistry.get(handle)) }
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
        promise.reject(CodedException("E_AUTH_CANCELLED", errString.toString(), null))
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

/** Decoded images by handle. Closing wipes the pixels before letting the bitmap go. */
internal object ImageRegistry {
  private val images = HashMap<Int, Bitmap>()
  private var next = 1

  @Synchronized fun put(b: Bitmap): Int = next++.also { images[it] = b }
  @Synchronized fun get(h: Int): Bitmap? = images[h]
  @Synchronized fun remove(h: Int) {
    images.remove(h)?.let { if (it.isMutable && !it.isRecycled) it.eraseColor(0) }
  }
}

class CubeImageView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val image = ImageView(context).apply {
    scaleType = ImageView.ScaleType.FIT_CENTER
    layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  init {
    addView(image)
  }

  fun show(b: Bitmap?) {
    image.setImageBitmap(b)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    image.setImageDrawable(null)
  }
}

/** Plaintext with its length; `bytes` may be longer (padding), and is zeroed by the caller. */
internal class Plain(val bytes: ByteArray, val length: Int)

/**
 * Opens a blob written by lib/vault.ts encryptBlob: nonce(24) || ciphertext || tag(16), with the
 * plaintext padded by 0x80 then zeros. libsodium's XChaCha20-Poly1305-IETF is HChaCha20 on the
 * first 16 nonce bytes, then ChaCha20-Poly1305-IETF with nonce 00000000 || the last 8 bytes.
 */
internal fun decryptBlob(key: ByteArray, blob: ByteArray): Plain {
  if (Build.VERSION.SDK_INT < 28) throw CodedException("E_UNSUPPORTED", "Needs Android 9", null)
  if (blob.size < 24 + 16) throw CodedException("E_CORRUPT", "corrupt", null)
  val sub = hchacha20(key, blob.copyOfRange(0, 16))
  val nonce = ByteArray(12).also { System.arraycopy(blob, 16, it, 4, 8) }
  val padded = try {
    Cipher.getInstance("ChaCha20-Poly1305").run {
      init(Cipher.DECRYPT_MODE, SecretKeySpec(sub, "ChaCha20"), IvParameterSpec(nonce))
      doFinal(blob, 24, blob.size - 24)
    }
  } catch (e: Exception) {
    throw CodedException("E_CORRUPT", "Could not decrypt", e)
  } finally {
    sub.fill(0)
  }
  var end = padded.size - 1
  while (end >= 0 && padded[end] == 0.toByte()) end--
  if (end < 0 || padded[end] != 0x80.toByte()) {
    padded.fill(0)
    throw CodedException("E_CORRUPT", "corrupt", null)
  }
  return Plain(padded, end)
}

private fun hchacha20(key: ByteArray, nonce16: ByteArray): ByteArray {
  fun le(b: ByteArray, i: Int) =
    (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) or
      ((b[i + 2].toInt() and 0xff) shl 16) or ((b[i + 3].toInt() and 0xff) shl 24)
  val x = IntArray(16)
  x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574
  for (i in 0 until 8) x[4 + i] = le(key, i * 4)
  for (i in 0 until 4) x[12 + i] = le(nonce16, i * 4)
  fun qr(a: Int, b: Int, c: Int, d: Int) {
    x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] xor x[a], 16)
    x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] xor x[c], 12)
    x[a] += x[b]; x[d] = Integer.rotateLeft(x[d] xor x[a], 8)
    x[c] += x[d]; x[b] = Integer.rotateLeft(x[b] xor x[c], 7)
  }
  repeat(10) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
  }
  val out = ByteArray(32)
  val words = intArrayOf(x[0], x[1], x[2], x[3], x[12], x[13], x[14], x[15])
  for (i in 0 until 8) for (j in 0 until 4) out[i * 4 + j] = (words[i] ushr (8 * j)).toByte()
  x.fill(0)
  return out
}
