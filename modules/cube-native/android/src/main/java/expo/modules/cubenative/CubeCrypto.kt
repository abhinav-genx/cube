package expo.modules.cubenative

import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opens the blobs lib/vault.ts writes. Plain JVM code (no Android APIs), so it is unit-tested on
 * the JVM against vectors from the JavaScript implementation (tests/native/). Uses the platform's
 * ChaCha20-Poly1305 where it exists (Android 9+, Java 11+) and a pure-Kotlin implementation
 * otherwise (Android 7 and 8), so native preview and export work on every supported version.
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

  /** True when the platform has ChaCha20-Poly1305 (Android 9+). Tests can force the pure path. */
  @Volatile var usePlatform: Boolean = runCatching { Cipher.getInstance("ChaCha20-Poly1305") }.isSuccess

  private fun aead(sub: ByteArray, nonce12: ByteArray, data: ByteArray, off: Int, len: Int): ByteArray {
    if (!usePlatform) return Pure.open(sub, nonce12, data, off, len) ?: throw CorruptException("Could not decrypt")
    return try {
      Cipher.getInstance("ChaCha20-Poly1305").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(sub, "ChaCha20"), IvParameterSpec(nonce12))
        doFinal(data, off, len)
      }
    } catch (e: Exception) {
      throw CorruptException("Could not decrypt", e)
    }
  }

  private fun seal(sub: ByteArray, nonce12: ByteArray, plain: ByteArray, off: Int, len: Int): ByteArray {
    if (!usePlatform) return Pure.seal(sub, nonce12, plain, off, len)
    return Cipher.getInstance("ChaCha20-Poly1305").run {
      init(Cipher.ENCRYPT_MODE, SecretKeySpec(sub, "ChaCha20"), IvParameterSpec(nonce12))
      doFinal(plain, off, len)
    }
  }

  /**
   * Encrypts a stream as a v2 blob, piece by piece, in constant memory: the same format encryptV2
   * gives for the whole input. The last chunk is only known at finish(), so one chunk is held back.
   */
  class V2Writer(key: ByteArray, private val output: OutputStream) {
    private val sub: ByteArray
    private val buf = ByteArray(CHUNK)
    private var fill = 0
    private var index = 0
    var plainBytes = 0L
      private set
    var blobBytes = 0L
      private set

    init {
      require(key.size == 32)
      val prefix = ByteArray(PREFIX).also { SecureRandom().nextBytes(it) }
      sub = hchacha20(key, prefix)
      output.write(prefix)
      blobBytes = PREFIX.toLong()
    }

    fun write(bytes: ByteArray, off: Int = 0, len: Int = bytes.size) {
      var i = 0
      while (i < len) {
        if (fill == CHUNK) sealChunk(false)
        val take = minOf(CHUNK - fill, len - i)
        System.arraycopy(bytes, off + i, buf, fill, take)
        fill += take
        i += take
      }
      plainBytes += len
    }

    /** Seals the last chunk (0x80 padding); afterwards the key is wiped. */
    fun finish() {
      try {
        if (fill == CHUNK) sealChunk(false)
        buf.fill(0, fill, CHUNK)
        buf[fill] = 0x80.toByte()
        fill = CHUNK
        sealChunk(true)
      } finally {
        sub.fill(0)
        buf.fill(0)
      }
    }

    private fun sealChunk(last: Boolean) {
      val ct = CubeCrypto.seal(sub, chunkNonce(index, last), buf, 0, CHUNK)
      index++
      output.write(ct)
      blobBytes += ct.size
      buf.fill(0)
      fill = 0
    }
  }

  /**
   * Writes `plain` as a v2 blob (random prefix, 64 KiB chunks, 0x80 padding) to `output`; returns
   * the blob's size. The same format lib/vault.ts ChunkWriter produces.
   */
  fun encryptV2(key: ByteArray, plain: ByteArray, length: Int, output: OutputStream): Long {
    val prefix = ByteArray(PREFIX).also { SecureRandom().nextBytes(it) }
    val n = (length + 1 + CHUNK - 1) / CHUNK
    val sub = hchacha20(key, prefix)
    val chunk = ByteArray(CHUNK)
    try {
      output.write(prefix)
      for (i in 0 until n) {
        chunk.fill(0)
        val start = i * CHUNK
        val take = minOf(CHUNK, length - start).coerceAtLeast(0)
        if (take > 0) System.arraycopy(plain, start, chunk, 0, take)
        if (i == n - 1) chunk[take] = 0x80.toByte()
        val ct = seal(sub, chunkNonce(i, i == n - 1), chunk, 0, CHUNK)
        output.write(ct)
      }
    } finally {
      sub.fill(0)
      chunk.fill(0)
    }
    return PREFIX.toLong() + n.toLong() * CHUNK_CT
  }

  /** ChaCha20-Poly1305 (RFC 8439) in plain Kotlin, for Android versions without it. */
  internal object Pure {
    private fun le32(b: ByteArray, i: Int) =
      (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) or
        ((b[i + 2].toInt() and 0xff) shl 16) or ((b[i + 3].toInt() and 0xff) shl 24)

    private fun block(key: ByteArray, counter: Int, nonce: ByteArray, out: ByteArray) {
      val s = IntArray(16)
      s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574
      for (i in 0 until 8) s[4 + i] = le32(key, i * 4)
      s[12] = counter
      for (i in 0 until 3) s[13 + i] = le32(nonce, i * 4)
      val x = s.copyOf()
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
      for (i in 0 until 16) {
        val v = x[i] + s[i]
        out[i * 4] = v.toByte(); out[i * 4 + 1] = (v ushr 8).toByte()
        out[i * 4 + 2] = (v ushr 16).toByte(); out[i * 4 + 3] = (v ushr 24).toByte()
      }
      x.fill(0); s.fill(0)
    }

    private fun xor(key: ByteArray, nonce: ByteArray, input: ByteArray, off: Int, len: Int, out: ByteArray, outOff: Int) {
      val ks = ByteArray(64)
      var counter = 1
      var i = 0
      while (i < len) {
        block(key, counter++, nonce, ks)
        val n = minOf(64, len - i)
        for (j in 0 until n) out[outOff + i + j] = (input[off + i + j].toInt() xor ks[j].toInt()).toByte()
        i += n
      }
      ks.fill(0)
    }

    /** Poly1305 over the RFC 8439 AEAD input (no associated data): ct, pad, 0 (aad length), ct length. */
    private fun tag(otk: ByteArray, ct: ByteArray, off: Int, len: Int): ByteArray {
      val r0 = le32(otk, 0) and 0x3ffffff
      val r1 = (le32(otk, 3) ushr 2) and 0x3ffff03
      val r2 = (le32(otk, 6) ushr 4) and 0x3ffc0ff
      val r3 = (le32(otk, 9) ushr 6) and 0x3f03fff
      val r4 = (le32(otk, 12) ushr 8) and 0x00fffff
      val s1 = r1 * 5; val s2 = r2 * 5; val s3 = r3 * 5; val s4 = r4 * 5
      var h0 = 0; var h1 = 0; var h2 = 0; var h3 = 0; var h4 = 0
      val blk = ByteArray(17)
      fun absorb(b: ByteArray, bo: Int, bl: Int, full: Boolean) {
        blk.fill(0)
        System.arraycopy(b, bo, blk, 0, bl)
        blk[if (full) 16 else bl] = 1
        val t0 = le32(blk, 0).toLong() and 0xffffffffL
        val t1 = le32(blk, 4).toLong() and 0xffffffffL
        val t2 = le32(blk, 8).toLong() and 0xffffffffL
        val t3 = le32(blk, 12).toLong() and 0xffffffffL
        val hibit = (blk[16].toInt() and 0xff).toLong()
        h0 += (t0 and 0x3ffffff).toInt()
        h1 += (((t0 ushr 26) or (t1 shl 6)) and 0x3ffffff).toInt()
        h2 += (((t1 ushr 20) or (t2 shl 12)) and 0x3ffffff).toInt()
        h3 += (((t2 ushr 14) or (t3 shl 18)) and 0x3ffffff).toInt()
        h4 += ((t3 ushr 8) or (hibit shl 24)).toInt()
        val d0 = h0.toLong() * r0 + h1.toLong() * s4 + h2.toLong() * s3 + h3.toLong() * s2 + h4.toLong() * s1
        var d1 = h0.toLong() * r1 + h1.toLong() * r0 + h2.toLong() * s4 + h3.toLong() * s3 + h4.toLong() * s2
        var d2 = h0.toLong() * r2 + h1.toLong() * r1 + h2.toLong() * r0 + h3.toLong() * s4 + h4.toLong() * s3
        var d3 = h0.toLong() * r3 + h1.toLong() * r2 + h2.toLong() * r1 + h3.toLong() * r0 + h4.toLong() * s4
        var d4 = h0.toLong() * r4 + h1.toLong() * r3 + h2.toLong() * r2 + h3.toLong() * r1 + h4.toLong() * r0
        var c = d0 ushr 26; h0 = (d0 and 0x3ffffff).toInt()
        d1 += c; c = d1 ushr 26; h1 = (d1 and 0x3ffffff).toInt()
        d2 += c; c = d2 ushr 26; h2 = (d2 and 0x3ffffff).toInt()
        d3 += c; c = d3 ushr 26; h3 = (d3 and 0x3ffffff).toInt()
        d4 += c; c = d4 ushr 26; h4 = (d4 and 0x3ffffff).toInt()
        h0 += (c * 5).toInt(); c = (h0 ushr 26).toLong(); h0 = h0 and 0x3ffffff
        h1 += c.toInt()
      }
      var i = 0
      while (i + 16 <= len) { absorb(ct, off + i, 16, true); i += 16 }
      if (i < len) absorb(ByteArray(16).also { System.arraycopy(ct, off + i, it, 0, len - i) }, 0, 16, true)
      val lens = ByteArray(16)
      val l = len.toLong()
      for (k in 0 until 8) lens[8 + k] = (l ushr (8 * k)).toByte()
      absorb(lens, 0, 16, true)
      // final reduction mod 2^130 - 5, then add s
      var c = h1 ushr 26; h1 = h1 and 0x3ffffff
      h2 += c; c = h2 ushr 26; h2 = h2 and 0x3ffffff
      h3 += c; c = h3 ushr 26; h3 = h3 and 0x3ffffff
      h4 += c; c = h4 ushr 26; h4 = h4 and 0x3ffffff
      h0 += c * 5; c = h0 ushr 26; h0 = h0 and 0x3ffffff
      h1 += c
      var g0 = h0 + 5; c = g0 ushr 26; g0 = g0 and 0x3ffffff
      var g1 = h1 + c; c = g1 ushr 26; g1 = g1 and 0x3ffffff
      var g2 = h2 + c; c = g2 ushr 26; g2 = g2 and 0x3ffffff
      var g3 = h3 + c; c = g3 ushr 26; g3 = g3 and 0x3ffffff
      val g4 = h4 + c - (1 shl 26)
      val mask = (g4 ushr 31) - 1         // all ones if h >= p (use g), else zero
      val nm = mask.inv()
      h0 = (h0 and nm) or (g0 and mask); h1 = (h1 and nm) or (g1 and mask)
      h2 = (h2 and nm) or (g2 and mask); h3 = (h3 and nm) or (g3 and mask)
      h4 = (h4 and nm) or (g4 and mask)
      val f0 = ((h0 or (h1 shl 26)).toLong() and 0xffffffffL) + (le32(otk, 16).toLong() and 0xffffffffL)
      val f1 = (((h1 ushr 6) or (h2 shl 20)).toLong() and 0xffffffffL) + (le32(otk, 20).toLong() and 0xffffffffL) + (f0 ushr 32)
      val f2 = (((h2 ushr 12) or (h3 shl 14)).toLong() and 0xffffffffL) + (le32(otk, 24).toLong() and 0xffffffffL) + (f1 ushr 32)
      val f3 = (((h3 ushr 18) or (h4 shl 8)).toLong() and 0xffffffffL) + (le32(otk, 28).toLong() and 0xffffffffL) + (f2 ushr 32)
      val out = ByteArray(16)
      for ((w, v) in listOf(f0, f1, f2, f3).withIndex()) for (k in 0 until 4) out[w * 4 + k] = (v ushr (8 * k)).toByte()
      blk.fill(0)
      return out
    }

    private fun oneTimeKey(key: ByteArray, nonce: ByteArray): ByteArray {
      val b = ByteArray(64)
      block(key, 0, nonce, b)
      return b.copyOf(32).also { b.fill(0) }
    }

    /** Decrypts ct||tag; null if the tag does not match (compared in constant time). */
    fun open(key: ByteArray, nonce: ByteArray, data: ByteArray, off: Int, len: Int): ByteArray? {
      if (len < TAG) return null
      val ctLen = len - TAG
      val otk = oneTimeKey(key, nonce)
      val expect = tag(otk, data, off, ctLen)
      otk.fill(0)
      var diff = 0
      for (i in 0 until TAG) diff = diff or (expect[i].toInt() xor data[off + ctLen + i].toInt())
      if (diff != 0) return null
      return ByteArray(ctLen).also { xor(key, nonce, data, off, ctLen, it, 0) }
    }

    fun seal(key: ByteArray, nonce: ByteArray, plain: ByteArray, off: Int, len: Int): ByteArray {
      val out = ByteArray(len + TAG)
      xor(key, nonce, plain, off, len, out, 0)
      val otk = oneTimeKey(key, nonce)
      System.arraycopy(tag(otk, out, 0, len), 0, out, len, TAG)
      otk.fill(0)
      return out
    }
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
