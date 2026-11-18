package expo.modules.cubenative

/**
 * Native port of lib/strip.ts: removes location and camera details from an image without touching
 * its pixels. Must produce exactly the same bytes as the JavaScript version (tests/native/ checks
 * both against the same inputs). Plain JVM code, unit-tested on the JVM.
 */
object CubeStrip {
  fun strip(input: ByteArray): ByteArray {
    val b = input.copyOf()
    if (b.size < 12) return b
    if (u8(b, 0) == 0xFF && u8(b, 1) == 0xD8) {
      stripJpeg(b)
      scanAll(b)
      return b
    }
    if (starts(b, 0, PNG_SIG)) return stripPng(b)
    if (starts(b, 0, ascii("RIFF")) && starts(b, 8, ascii("WEBP"))) {
      stripWebp(b)
      scanAll(b)
      return b
    }
    val isHeif = starts(b, 4, ascii("ftyp"))
    val isGif = starts(b, 0, ascii("GIF8"))
    val isTiff = isTiffHeader(b, 0)
    if (isHeif || isGif || isTiff) {
      if (isTiff) scrubTiff(b, 0, b.size)
      scanAll(b)
    }
    return b
  }

  // ---- containers ----------------------------------------------------------------------------

  private fun stripJpeg(b: ByteArray) {
    var i = 2
    while (i + 4 <= b.size) {
      if (u8(b, i) != 0xFF) return
      val m = u8(b, i + 1)
      if (m == 0xFF) { i += 1; continue }
      if (m == 0xD8 || m == 0x01 || (m in 0xD0..0xD7)) { i += 2; continue }
      if (m == 0xDA || m == 0xD9) return
      val len = (u8(b, i + 2) shl 8) or u8(b, i + 3)
      val data = i + 4
      val end = i + 2 + len
      if (len < 2 || end > b.size) return
      if (m == 0xE1 && starts(b, data, EXIF_ID)) {
        scrubTiff(b, data + EXIF_ID.size, end)
      } else if ((m == 0xE1 && (starts(b, data, XMP_ID) || starts(b, data, XMP_EXT_ID))) || m == 0xED) {
        b[i + 1] = 0xFE.toByte()
        b.fill(0, data, end)
      }
      i = end
    }
  }

  private fun stripPng(b: ByteArray): ByteArray {
    val out = java.io.ByteArrayOutputStream(b.size)
    out.write(b, 0, 8)
    var i = 8
    while (i + 12 <= b.size) {
      val len = u32be(b, i)
      if (len > Int.MAX_VALUE) break
      val end = i.toLong() + 12 + len
      if (end > b.size) break
      val e = end.toInt()
      val type = String(b, i + 4, 4, Charsets.ISO_8859_1)
      if (type == "eXIf") {
        val chunk = b.copyOfRange(i, e)
        val l = len.toInt()
        scrubTiff(chunk, 8, 8 + l)
        val c = crc32(chunk, 4, 8 + l)
        chunk[8 + l] = (c ushr 24).toByte(); chunk[9 + l] = (c ushr 16).toByte()
        chunk[10 + l] = (c ushr 8).toByte(); chunk[11 + l] = c.toByte()
        out.write(chunk)
      } else if (type != "tEXt" && type != "zTXt" && type != "iTXt" && type != "tIME") {
        out.write(b, i, e - i)
      }
      i = e
      if (type == "IEND") break
    }
    if (i < b.size) out.write(b, i, b.size - i)
    return out.toByteArray()
  }

  private fun stripWebp(b: ByteArray) {
    var i = 12
    while (i + 8 <= b.size) {
      val len = u8(b, i + 4) or (u8(b, i + 5) shl 8) or (u8(b, i + 6) shl 16) or (u8(b, i + 7) shl 24)
      val data = i + 8
      val end = data.toLong() + len
      if (len < 0 || end > b.size) return
      if (starts(b, i, ascii("EXIF"))) {
        scrubTiff(b, if (starts(b, data, EXIF_ID)) data + EXIF_ID.size else data, end.toInt())
      }
      i = end.toInt() + (len and 1)
    }
  }

  private fun scanAll(b: ByteArray) {
    var i = 0
    while (i + 14 <= b.size) {
      if (u8(b, i) == 0x45 && starts(b, i, EXIF_ID) && isTiffHeader(b, i + 6)) scrubTiff(b, i + 6, b.size)
      i++
    }
    for (sig in listOf(TIFF_LE_8, TIFF_BE_8)) {
      var j = 0
      while (j + 8 <= b.size) {
        if (b[j] == sig[0] && starts(b, j, sig)) scrubTiff(b, j, b.size)
        j++
      }
    }
    blankXml(b, ascii("<x:xmpmeta"), ascii("</x:xmpmeta>"), ascii("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">"))
    blankXml(b, ascii("<rdf:RDF"), ascii("</rdf:RDF>"), ascii("<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"))
  }

  private fun blankXml(b: ByteArray, open: ByteArray, close: ByteArray, head: ByteArray) {
    var from = 0
    while (true) {
      val s = find(b, open, from)
      if (s < 0) return
      val c = find(b, close, s + open.size)
      if (c < 0) return
      val end = c + close.size
      if (end - s >= head.size + close.size) {
        System.arraycopy(head, 0, b, s, head.size)
        b.fill(0x20, s + head.size, c)
      }
      from = end
    }
  }

  // ---- TIFF / Exif ---------------------------------------------------------------------------

  private const val GPS_IFD = 0x8825
  private const val EXIF_IFD = 0x8769
  private val DROP_MAIN = setOf(
    0x010E, 0x010F, 0x0110, 0x0131, 0x013B, 0x013C, 0x02BC, 0x8298, 0x83BB, 0x8649,
    0x9C9B, 0x9C9C, 0x9C9D, 0x9C9E, 0x9C9F, GPS_IFD,
  )
  private val DROP_EXIF = setOf(0x927C, 0x9286, 0xA420, 0xA430, 0xA431, 0xA432, 0xA433, 0xA434, 0xA435, GPS_IFD)
  private val TYPE_SIZE = intArrayOf(0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4)
  private const val MAX_ENTRIES = 1000

  private class Entry(val at: Int, val tag: Int, val type: Int, val count: Long, val value: Long)

  private fun scrubTiff(b: ByteArray, base: Int, end: Int) {
    if (!isTiffHeader(b, base) || end - base < 8) return
    val le = u8(b, base) == 0x49
    val size = (end - base).toLong()
    fun u16(o: Long): Int {
      val p = base + o.toInt()
      return if (le) u8(b, p) or (u8(b, p + 1) shl 8) else (u8(b, p) shl 8) or u8(b, p + 1)
    }
    fun u32(o: Long): Long {
      val p = base + o.toInt()
      return if (le) {
        (u8(b, p).toLong() or (u8(b, p + 1).toLong() shl 8) or (u8(b, p + 2).toLong() shl 16) or (u8(b, p + 3).toLong() shl 24))
      } else {
        ((u8(b, p).toLong() shl 24) or (u8(b, p + 1).toLong() shl 16) or (u8(b, p + 2).toLong() shl 8) or u8(b, p + 3).toLong())
      }
    }
    fun read(off: Long): List<Entry>? {
      if (off < 8 || off + 2 > size) return null
      val n = u16(off)
      if (n == 0 || n > MAX_ENTRIES || off + 2 + 12L * n + 4 > size) return null
      val out = ArrayList<Entry>(n)
      for (k in 0 until n) {
        val at = off + 2 + 12L * k
        val type = u16(at + 2)
        if (type < 1 || type > 13) return null
        out.add(Entry(at.toInt(), u16(at), type, u32(at + 4), u32(at + 8)))
      }
      return out
    }
    fun zeroValue(e: Entry) {
      val len = e.count * TYPE_SIZE[e.type]
      if (len > 4 && e.value >= 8 && e.value + len <= size) {
        b.fill(0, base + e.value.toInt(), base + (e.value + len).toInt())
      }
    }
    val seen = HashSet<Long>()
    fun wipe(off: Long) {
      val entries = read(off) ?: return
      if (!seen.add(off)) return
      for (e in entries) zeroValue(e)
      b.fill(0, base + off.toInt(), base + off.toInt() + 2 + 12 * entries.size + 4)
    }
    fun scrub(off: Long, drop: Set<Int>, main: Boolean) {
      val entries = read(off) ?: return
      if (!seen.add(off)) return
      val kept = ArrayList<Entry>()
      for (e in entries) {
        if (e.tag == GPS_IFD) wipe(e.value)
        if (main && e.tag == EXIF_IFD) scrub(e.value, DROP_EXIF, false)
        if (e.tag in drop) zeroValue(e) else kept.add(e)
      }
      val n = entries.size
      val o = off.toInt()
      val nextAt = o + 2 + 12 * n
      val next = u32(nextAt.toLong())
      if (kept.size < n) {
        val saved = kept.map { b.copyOfRange(base + it.at, base + it.at + 12) }
        saved.forEachIndexed { k, raw -> System.arraycopy(raw, 0, b, base + o + 2 + 12 * k, 12) }
        val c = kept.size
        b[base + o + (if (le) 0 else 1)] = c.toByte()
        b[base + o + (if (le) 1 else 0)] = (c ushr 8).toByte()
        val newNext = o + 2 + 12 * kept.size
        val ptr = b.copyOfRange(base + nextAt, base + nextAt + 4)
        System.arraycopy(ptr, 0, b, base + newNext, 4)
        b.fill(0, base + newNext + 4, base + nextAt + 4)
      }
      if (main && next != 0L) scrub(next, DROP_MAIN, true)
    }
    scrub(u32(4), DROP_MAIN, true)
  }

  // ---- bytes ---------------------------------------------------------------------------------

  private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xFF
  private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)
  private val PNG_SIG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  private val EXIF_ID = byteArrayOf(0x45, 0x78, 0x69, 0x66, 0, 0)
  private val XMP_ID = ascii("http://ns.adobe.com/xap/1.0/\u0000")
  private val XMP_EXT_ID = ascii("http://ns.adobe.com/xmp/extension/\u0000")
  private val TIFF_LE_8 = byteArrayOf(0x49, 0x49, 0x2A, 0, 8, 0, 0, 0)
  private val TIFF_BE_8 = byteArrayOf(0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8)

  private fun isTiffHeader(b: ByteArray, i: Int) = i >= 0 && i + 8 <= b.size &&
    ((u8(b, i) == 0x49 && u8(b, i + 1) == 0x49 && u8(b, i + 2) == 0x2A && u8(b, i + 3) == 0) ||
      (u8(b, i) == 0x4D && u8(b, i + 1) == 0x4D && u8(b, i + 2) == 0 && u8(b, i + 3) == 0x2A))

  private fun starts(b: ByteArray, at: Int, sig: ByteArray): Boolean {
    if (at < 0 || at + sig.size > b.size) return false
    for (k in sig.indices) if (b[at + k] != sig[k]) return false
    return true
  }

  private fun find(b: ByteArray, sig: ByteArray, from: Int): Int {
    var i = maxOf(0, from)
    while (i + sig.size <= b.size) {
      if (b[i] == sig[0] && starts(b, i, sig)) return i
      i++
    }
    return -1
  }

  private fun u32be(b: ByteArray, i: Int): Long =
    (u8(b, i).toLong() shl 24) or (u8(b, i + 1).toLong() shl 16) or (u8(b, i + 2).toLong() shl 8) or u8(b, i + 3).toLong()

  private val CRC = IntArray(256) { n ->
    var c = n
    repeat(8) { c = if (c and 1 != 0) (0xEDB88320.toInt() xor (c ushr 1)) else (c ushr 1) }
    c
  }

  private fun crc32(b: ByteArray, from: Int, to: Int): Long {
    var c = -1
    for (i in from until to) c = CRC[(c xor b[i].toInt()) and 0xFF] xor (c ushr 8)
    return (c.inv()).toLong() and 0xFFFFFFFFL
  }
}
