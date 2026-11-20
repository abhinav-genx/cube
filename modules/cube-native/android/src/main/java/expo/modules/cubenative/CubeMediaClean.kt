package expo.modules.cubenative

import expo.modules.cubenative.CubeDocClean.Patch
import expo.modules.cubenative.CubeDocClean.RandomSource

/**
 * Removes identifying details from videos and audio while they stream in (runImport): a port of
 * lib/mediameta.ts mediaPatches, giving the same patches (tests/native checks the bytes). Plain JVM
 * only, so the unit tests run it. The same as ios/CubeMediaClean.swift.
 *
 * Only box, frame and chunk headers are read, in place (never sample data); the result is a list of
 * same-length patches that runImport lays over the file as it streams, so every offset in the file
 * (MP4 sample tables point into it by absolute offset) stays valid.
 * - MP4, MOV, M4A, 3GP: user-data and metadata items other than the creation date (and slow-motion
 *   playback keys) become "free" boxes with their contents zeroed; so do XMP boxes.
 * - MP3: ID3v2 frames other than dates become padding; ID3v1, Enhanced ID3v1 and APEv2 are emptied.
 * - FLAC: Vorbis comments, pictures and application blocks become padding.
 * - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks.
 * Anything else, or anything malformed, gives no patches: the file is stored as picked.
 */
object CubeMediaClean {
  /** Zeros shared by every patch that blanks a region (patches never write to their bytes). */
  internal val ZERO = ByteArray(1 shl 20)

  /** Patches that zero `n` bytes at `at` (all sharing ZERO). */
  internal fun zeroPatches(patches: MutableList<Patch>, at: Long, n: Long) {
    var a = at
    var left = n
    while (left > 0) {
      val k = minOf(left, ZERO.size.toLong()).toInt()
      patches.add(Patch(a, ZERO, k))
      a += k
      left -= k
    }
  }

  private class PastEnd : Exception("past the end")

  /** Reads exactly `n` bytes at `at`, or throws (the file is shorter than its headers say). */
  private fun read(src: RandomSource, at: Long, n: Long): ByteArray {
    if (at < 0 || n < 0 || at + n > src.size || n > Int.MAX_VALUE) throw PastEnd()
    return src.read(at, n.toInt())
  }

  private fun ascii(s: String) = s.toByteArray(Charsets.ISO_8859_1)
  private fun str(b: ByteArray, at: Int, n: Int) = String(b, at, minOf(n, b.size - at), Charsets.ISO_8859_1)
  private fun u8(b: ByteArray, at: Int) = b[at].toInt() and 0xFF
  private fun u32(b: ByteArray, at: Int) = (u8(b, at).toLong() shl 24) or (u8(b, at + 1).toLong() shl 16) or (u8(b, at + 2).toLong() shl 8) or u8(b, at + 3).toLong()
  private fun u32le(b: ByteArray, at: Int) = u8(b, at).toLong() or (u8(b, at + 1).toLong() shl 8) or (u8(b, at + 2).toLong() shl 16) or (u8(b, at + 3).toLong() shl 24)
  private fun syncsafe(b: ByteArray, at: Int) = ((u8(b, at) and 0x7F) shl 21) or ((u8(b, at + 1) and 0x7F) shl 14) or ((u8(b, at + 2) and 0x7F) shl 7) or (u8(b, at + 3) and 0x7F)

  /** Same-length patches that remove identifying details from a video or audio file (see above). */
  fun patches(src: RandomSource): List<Patch> {
    val patches = ArrayList<Patch>()
    try {
      if (src.size < 12) return emptyList()
      val head = read(src, 0, 12)
      if (isMp4(head)) {
        mp4(src, 0, src.size, Where.TOP, patches)
        return patches
      }
      if (str(head, 0, 4) == "RIFF" || str(head, 0, 4) == "RF64") {
        if (str(head, 8, 4) == "WAVE") riff(src, patches)
        return patches
      }
      var at = 0L
      if (str(head, 0, 3) == "ID3" && u8(head, 3) in 2..4) at = id3v2(src, head, patches)
      if (at + 4 <= src.size && str(read(src, at, 4), 0, 4) == "fLaC") {
        flac(src, at + 4, patches)
        return patches
      }
      // tags at the end only for MPEG audio: an ID3v2 tag at the start, or a frame sync
      if (at > 0 || (u8(head, 0) == 0xFF && (u8(head, 1) and 0xE0) == 0xE0)) endTags(src, patches)
      return patches
    } catch (e: Exception) {
      return emptyList()   // malformed: store as picked
    }
  }

  // ---- MP4 / MOV ---------------------------------------------------------------------------------

  private val TOP_TYPES = setOf("ftyp", "moov", "mdat", "free", "skip", "wide", "pnot")
  private val XMP_UUID = byteArrayOf(
    0xBE.toByte(), 0x7A, 0xCF.toByte(), 0xCB.toByte(), 0x97.toByte(), 0xA9.toByte(), 0x42, 0xE8.toByte(),
    0x9C.toByte(), 0x71, 0x99.toByte(), 0x94.toByte(), 0x91.toByte(), 0xE3.toByte(), 0xAF.toByte(), 0xAC.toByte(),
  )
  /** User-data boxes that stay: the creation date, chapters and track-selection or hint details. */
  private val KEEP_UDTA = setOf("©day", "chpl", "tsel", "hnti", "hinf")
  /** Metadata keys that stay: dates and what players need to play slow motion at the right speed. */
  private val KEEP_KEY = Regex("creationdate|capture\\.fps|full-frame-rate-playback-intent", RegexOption.IGNORE_CASE)

  private fun isMp4(head: ByteArray): Boolean {
    val size = u32(head, 0)
    return str(head, 4, 4) in TOP_TYPES && (size == 0L || size == 1L || size >= 8)
  }

  private class Box(val at: Long, val size: Long, val type: String, val head: Int)

  private fun boxes(src: RandomSource, from: Long, to: Long): List<Box> {
    val list = ArrayList<Box>()
    var at = from
    while (at + 8 <= to) {
      val h = read(src, at, minOf(16L, to - at))
      var size = u32(h, 0)
      val type = str(h, 4, 4)
      var head = 8
      if (size == 1L) {
        if (h.size < 16) break
        size = u32(h, 8) * 0x1_0000_0000L + u32(h, 12)   // negative (and so rejected) past 2^63
        head = 16
      } else if (size == 0L) size = to - at
      if (size < head || at + size > to) break
      list.add(Box(at, size, type, head))
      at += size
    }
    return list
  }

  private fun blank(b: Box, patches: MutableList<Patch>) {
    patches.add(Patch(b.at + 4, ascii("free")))
    zeroPatches(patches, b.at + b.head, b.size - b.head)
  }

  private fun isXmpUuid(src: RandomSource, b: Box): Boolean {
    if (b.type != "uuid" || b.size < b.head + 16) return false
    return read(src, b.at + b.head, 16).contentEquals(XMP_UUID)
  }

  private enum class Where { TOP, MOOV, TRAK, UDTA }

  private fun mp4(src: RandomSource, from: Long, to: Long, where: Where, patches: MutableList<Patch>) {
    for (b in boxes(src, from, to)) {
      val inner = b.at + b.head
      if (isXmpUuid(src, b)) blank(b, patches)
      else if (b.type == "meta") meta(src, b, patches)
      else if (where == Where.TOP) {
        if (b.type == "moov") mp4(src, inner, b.at + b.size, Where.MOOV, patches)
      } else if (where == Where.UDTA) {
        if (b.type !in KEEP_UDTA) blank(b, patches)
      } else if (b.type == "udta") mp4(src, inner, b.at + b.size, Where.UDTA, patches)
      else if (b.type == "trak" && where == Where.MOOV) mp4(src, inner, b.at + b.size, Where.TRAK, patches)
    }
  }

  /** A metadata box: QuickTime's (children right away) or ISO's (version and flags first). */
  private fun meta(src: RandomSource, b: Box, patches: MutableList<Patch>) {
    var inner = b.at + b.head
    val end = b.at + b.size
    if (inner + 8 > end) return
    if (str(read(src, inner, 8), 4, 4) != "hdlr") inner += 4
    val children = boxes(src, inner, end)
    var keys: List<String>? = null
    for (c in children) if (c.type == "keys") keys = readKeys(src, c)
    for (c in children) {
      if (c.type == "ilst") {
        for (item in boxes(src, c.at + c.head, c.at + c.size)) {
          val index = u32(read(src, item.at + 4, 4), 0)
          val k = keys
          val name = if (k != null && index >= 1 && index <= k.size) k[(index - 1).toInt()] else item.type
          if (name != "©day" && !KEEP_KEY.containsMatchIn(name)) blank(item, patches)
        }
      } else if (c.type == "xml " || c.type == "XMP_" || isXmpUuid(src, c)) blank(c, patches)
    }
  }

  /** QuickTime metadata key names, in order (item types in ilst are 1-based indexes into them). */
  private fun readKeys(src: RandomSource, b: Box): List<String>? {
    val n = b.size - b.head
    if (n < 8 || n > (1 shl 20)) return null
    val k = read(src, b.at + b.head, n)
    val count = u32(k, 4)
    val keys = ArrayList<String>()
    var p = 8
    var i = 0L
    while (i < count) {
      if (p + 8 > k.size) return null
      val size = u32(k, p)
      if (size < 8 || p + size > k.size) return null
      keys.add(str(k, p + 8, (size - 8).toInt()))
      p += size.toInt()
      i++
    }
    return keys
  }

  // ---- MP3: ID3v2, ID3v1, Enhanced ID3v1, APEv2 ----------------------------------------------------

  private val ID3_DATES = setOf("TDRC", "TYER", "TDAT", "TIME", "TDOR", "TORY", "TDRL", "TYE", "TDA", "TIM", "TOR")
  /** Tags larger than this are zeroed whole rather than read to keep their dates. */
  private const val ID3_MAX = 64 * 1024 * 1024

  /** Keeps only date frames (moved to the front), padding after them; returns where the tag ends. */
  private fun id3v2(src: RandomSource, head: ByteArray, patches: MutableList<Patch>): Long {
    val ver = u8(head, 3)
    val flags = u8(head, 5)
    val size = syncsafe(head, 6)
    val footer = if (ver == 4 && flags and 0x10 != 0) 10 else 0
    if (10L + size + footer > src.size) throw PastEnd()
    val plain = flags and 0x80 == 0 && flags and 0x40 == 0   // unsynchronised, extended header (v2.2: compressed)
    if (plain && size <= ID3_MAX) {
      val tag = read(src, 10, size.toLong())
      val body = ByteArray(size)
      var q = 0
      var p = 0
      while (p < size && tag[p] != 0.toByte()) {
        val hl = if (ver == 2) 6 else 10
        if (p + hl > size) break
        val id = str(tag, p, if (ver == 2) 3 else 4)
        val n: Long = when (ver) {
          2 -> ((u8(tag, p + 3) shl 16) or (u8(tag, p + 4) shl 8) or u8(tag, p + 5)).toLong()
          4 -> syncsafe(tag, p + 4).toLong()
          else -> u32(tag, p + 4)
        }
        if (p + hl + n > size) break
        if (id in ID3_DATES) {
          System.arraycopy(tag, p, body, q, hl + n.toInt())
          q += hl + n.toInt()
        }
        p += hl + n.toInt()
      }
      tag.fill(0)
      patches.add(Patch(10, body))
    } else zeroPatches(patches, 10, size.toLong())
    val clean = byteArrayOf((flags and 0xC0.inv()).toByte())
    patches.add(Patch(5, clean))
    if (footer != 0) patches.add(Patch(10L + size + 5, clean))
    return 10L + size + footer
  }

  private fun endTags(src: RandomSource, patches: MutableList<Patch>) {
    var end = src.size
    if (end >= 128 && str(read(src, end - 128, 3), 0, 3) == "TAG") {
      val at = end - 128
      zeroPatches(patches, at + 3, 90)    // title, artist, album; the year (4 bytes) stays
      zeroPatches(patches, at + 97, 30)   // comment (and track number)
      patches.add(Patch(at + 127, byteArrayOf(0xFF.toByte())))   // no genre
      end = at
      if (end >= 227 && str(read(src, end - 227, 4), 0, 4) == "TAG+") {
        zeroPatches(patches, end - 227 + 4, 223)
        end -= 227
      }
    }
    if (end >= 32) {
      val f = read(src, end - 32, 32)
      if (str(f, 0, 8) == "APETAGEX") {
        val size = u32le(f, 12)   // items and footer
        val hasHeader = u32le(f, 20) and 0x80000000L != 0L
        val items = end - size
        if (size >= 32 && items - (if (hasHeader) 32 else 0) >= 0) {
          zeroPatches(patches, items, size - 32)
          zeroPatches(patches, end - 32 + 16, 4)   // item count 0
          if (hasHeader) zeroPatches(patches, items - 32 + 16, 4)
        }
      }
    }
  }

  // ---- FLAC --------------------------------------------------------------------------------------

  private fun flac(src: RandomSource, from: Long, patches: MutableList<Patch>) {
    var p = from
    while (true) {
      val h = read(src, p, 4)
      val last = u8(h, 0) and 0x80
      val type = u8(h, 0) and 0x7F
      val n = ((u8(h, 1) shl 16) or (u8(h, 2) shl 8) or u8(h, 3)).toLong()
      if (p + 4 + n > src.size) return
      if (type == 2 || type == 4 || type == 6) {   // application, Vorbis comment, picture → padding
        patches.add(Patch(p, byteArrayOf((last or 1).toByte())))
        zeroPatches(patches, p + 4, n)
      }
      p += 4 + n
      if (last != 0) return
    }
  }

  // ---- WAV ---------------------------------------------------------------------------------------

  private val RIFF_BLANK = setOf("bext", "iXML", "_PMX", "id3 ", "ID3 ", "cart", "axml")

  private fun riff(src: RandomSource, patches: MutableList<Patch>) {
    val declared = u32le(read(src, 4, 4), 0)
    val end = if (declared == 0xFFFFFFFFL) src.size else minOf(src.size, 8 + declared)
    var p = 12L
    while (p + 8 <= end) {
      val h = read(src, p, if (12 <= end - p) 12 else 8)
      val id = str(h, 0, 4)
      val n = u32le(h, 4)
      if (n == 0xFFFFFFFFL || p + 8 + n > end) return
      if (id in RIFF_BLANK || (id == "LIST" && h.size >= 12 && str(h, 8, 4) == "INFO")) {
        patches.add(Patch(p, ascii("JUNK")))
        zeroPatches(patches, p + 8, n)
      }
      p += 8 + n + (n and 1)
    }
  }
}
