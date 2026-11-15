package expo.modules.cubenative

import java.io.InputStream
import java.io.OutputStream
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opens the blobs lib/vault.ts writes. Plain JVM code (no Android APIs), so it is unit-tested on
 * the JVM against vectors from the JavaScript implementation (tests/native/). Needs a runtime with
 * ChaCha20-Poly1305: Android 9+ or Java 11+.
 *
 * v1: nonce(24) || XChaCha20-Poly1305(key, padded plaintext) — files added before per-file keys.
 * v2: prefix(16) || chunk_0 … chunk_{n-1}; chunk_i = XChaCha20-Poly1305(fileKey,
 *     nonce = prefix || u64be(i, top bit set on the last chunk)) of 64 KiB, padded at the end.
 * Padding (both): 0x80 then zeros.
 *
 * XChaCha20-Poly1305-IETF is HChaCha20(key, nonce[0..16)) as the key for ChaCha20-Poly1305-IETF
 * with nonce 00000000 || nonce[16..24).
 */
object CubeCrypto {
  const val CHUNK = 64 * 1024
  private const val TAG = 16
  private const val PREFIX = 16
  const val CHUNK_CT = CHUNK + TAG

  class CorruptException(message: String, cause: Throwable? = null) : Exception(message, cause)

  /** Plaintext with its length; `bytes` may be longer (padding) and is zeroed by the caller. */
  class Plain(val bytes: ByteArray, val length: Int)

  fun open(format: Int, key: ByteArray, blob: ByteArray): Plain =
    if (format == 2) openV2(key, blob) else openV1(key, blob)

  fun openV1(key: ByteArray, blob: ByteArray): Plain {
    if (blob.size < 24 + TAG) throw CorruptException("corrupt")
    val sub = hchacha20(key, blob.copyOfRange(0, 16))
    val nonce = ByteArray(12).also { System.arraycopy(blob, 16, it, 4, 8) }
    val padded = try {
      aead(sub, nonce, blob, 24, blob.size - 24)
    } finally {
      sub.fill(0)
    }
    return Plain(padded, unpad(padded))
  }

  fun chunkCount(blobBytes: Long): Int {
    val body = blobBytes - PREFIX
    return if (body > 0 && body % CHUNK_CT == 0L) (body / CHUNK_CT).toInt() else 0
  }

  fun openV2(key: ByteArray, blob: ByteArray): Plain {
    val n = chunkCount(blob.size.toLong())
    if (n == 0) throw CorruptException("corrupt")
    val sub = hchacha20(key, blob.copyOfRange(0, PREFIX))
    val out = ByteArray(n * CHUNK)
    try {
      var length = 0
      for (i in 0 until n) {
        val plain = aead(sub, chunkNonce(i, i == n - 1), blob, PREFIX + i * CHUNK_CT, CHUNK_CT)
        val len = if (i == n - 1) unpad(plain) else plain.size
        System.arraycopy(plain, 0, out, length, len)
        length += len
        plain.fill(0)
      }
      return Plain(out, length)
    } catch (e: Exception) {
      out.fill(0)
      throw e
    } finally {
      sub.fill(0)
    }
  }

  /** Decrypts a v2 blob from `input` into `output` one chunk at a time (constant memory). */
  fun streamV2(key: ByteArray, input: InputStream, blobBytes: Long, output: OutputStream) {
    val n = chunkCount(blobBytes)
    if (n == 0) throw CorruptException("corrupt")
    val prefix = readExactly(input, PREFIX)
    val sub = hchacha20(key, prefix)
    val ct = ByteArray(CHUNK_CT)
    try {
      for (i in 0 until n) {
        readFully(input, ct)
        val plain = aead(sub, chunkNonce(i, i == n - 1), ct, 0, ct.size)
        try {
          output.write(plain, 0, if (i == n - 1) unpad(plain) else plain.size)
        } finally {
          plain.fill(0)
        }
      }
    } finally {
      sub.fill(0)
      ct.fill(0)
    }
  }

  private fun chunkNonce(index: Int, last: Boolean): ByteArray {
    val n = ByteArray(12)
    if (last) n[4] = 0x80.toByte()
    n[8] = (index ushr 24).toByte()
    n[9] = (index ushr 16).toByte()
    n[10] = (index ushr 8).toByte()
    n[11] = index.toByte()
    return n
  }

  private fun aead(sub: ByteArray, nonce12: ByteArray, data: ByteArray, off: Int, len: Int): ByteArray =
    try {
      Cipher.getInstance("ChaCha20-Poly1305").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(sub, "ChaCha20"), IvParameterSpec(nonce12))
        doFinal(data, off, len)
      }
    } catch (e: Exception) {
      throw CorruptException("Could not decrypt", e)
    }

  /** Length of the data before the 0x80-then-zeros padding; zeroes `padded` if it is malformed. */
  private fun unpad(padded: ByteArray): Int {
    var end = padded.size - 1
    while (end >= 0 && padded[end] == 0.toByte()) end--
    if (end < 0 || padded[end] != 0x80.toByte()) {
      padded.fill(0)
      throw CorruptException("corrupt")
    }
    return end
  }

  private fun readExactly(input: InputStream, n: Int): ByteArray = ByteArray(n).also { readFully(input, it) }

  private fun readFully(input: InputStream, buf: ByteArray) {
    var got = 0
    while (got < buf.size) {
      val r = input.read(buf, got, buf.size - got)
      if (r < 0) throw CorruptException("corrupt")
      got += r
    }
  }

  fun hchacha20(key: ByteArray, nonce16: ByteArray): ByteArray {
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
}
