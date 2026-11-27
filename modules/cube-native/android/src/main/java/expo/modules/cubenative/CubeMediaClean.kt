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
 * - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks. AVI: the same,
 *   and the camera chunks in its header (stream data, Nikon's tags).
 * - AIFF, AIFC: name, author, copyright, annotation, comment and ID3 chunks become JUNK chunks.
 * - Ogg (Vorbis, Opus, Theora, Speex, FLAC): the comment header of every stream (chained files
 *   included) is emptied (no vendor, no comments; Ogg FLAC as for FLAC) and the page checksums updated.
 * - Matroska, WebM: tags become Void elements; the title, the muxing and writing apps, track names
 *   and chapter titles are emptied; image attachments (cover art) become Void elements.
 * - Location tracks that action cameras record beside the video (GoPro GPMF, Google CAMM, DJI and
 *   Sony metadata tracks, and DJI subtitle tracks that print the position) become "free" boxes and
 *   their samples are zeroed; so are the GPS records and serial number in an Insta360 trailer.
 * - Motion-JPEG video (MP4, MOV, Matroska, AVI): each frame loses its Exif, XMP and comment segments.
 * - Video tracks lose the encoder name in their sample descriptions.
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
  private fun u16(b: ByteArray, at: Int) = (u8(b, at) shl 8) or u8(b, at + 1)
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
        insta360(src, patches)
        return patches
      }
      if (str(head, 0, 4) == "RIFF" || str(head, 0, 4) == "RF64") {
        if (str(head, 8, 4) == "WAVE" || str(head, 8, 4) == "AVI ") riff(src, patches)
        return patches
      }
      if (str(head, 0, 4) == "FORM") {
        if (str(head, 8, 4) == "AIFF" || str(head, 8, 4) == "AIFC") aiff(src, patches)
        return patches
      }
      if (str(head, 0, 4) == "OggS") {
        ogg(src, patches)
        return patches
      }
      if (u32(head, 0) == 0x1A45DFA3L) {
        matroska(src, patches)
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
      else if (b.type == "trak" && where == Where.MOOV) {
        if (locationTrack(src, b, patches)) blank(b, patches)
        else {
          mjpegTrack(src, b, patches)
          compressorNames(src, b, patches)
          mp4(src, inner, b.at + b.size, Where.TRAK, patches)
        }
      }
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

  private fun flac(src: RandomSource, from: Long, patches: MutableList<Patch>, end: Long = src.size) {
    var p = from
    while (true) {
      if (p + 4 > end) return
      val h = read(src, p, 4)
      val last = u8(h, 0) and 0x80
      val type = u8(h, 0) and 0x7F
      val n = ((u8(h, 1) shl 16) or (u8(h, 2) shl 8) or u8(h, 3)).toLong()
      if (p + 4 + n > end) return
      if (type == 2 || type == 4 || type == 6) {   // application, Vorbis comment, picture → padding
        patches.add(Patch(p, byteArrayOf((last or 1).toByte())))
        zeroPatches(patches, p + 4, n)
      }
      p += 4 + n
      if (last != 0) return
    }
  }

  // ---- WAV ---------------------------------------------------------------------------------------

  /** Chunks that become JUNK: broadcast, iXML, XMP, ID3, cart and axml (WAV), stream data (AVI cameras). */
  private val RIFF_BLANK = setOf("bext", "iXML", "_PMX", "id3 ", "ID3 ", "cart", "axml", "strd")
  /** Lists that become JUNK: text tags, and Nikon's camera tags in an AVI header. */
  private val RIFF_BLANK_LIST = setOf("INFO", "ncdt")
  /** Lists looked inside: an AVI's header and its stream headers, and its frames ("rec " groups some). */
  private val RIFF_OPEN_LIST = setOf("hdrl", "strl", "movi", "rec ")

  private fun riff(src: RandomSource, patches: MutableList<Patch>) {
    val declared = u32le(read(src, 4, 4), 0)
    val end = if (declared == 0xFFFFFFFFL) src.size else minOf(src.size, 8 + declared)
    riffChunks(src, 12, end, 0, patches)
    // an AVI over 1 GB goes on in more RIFF chunks ("AVIX"), each with frames of its own
    var p = end + (end and 1)
    while (p + 12 <= src.size) {
      val h = read(src, p, 12)
      val n = u32le(h, 4)
      if (str(h, 0, 4) != "RIFF" || str(h, 8, 4) != "AVIX" || p + 8 + n > src.size) return
      riffChunks(src, p + 12, p + 8 + n, 0, patches)
      p += 8 + n + (n and 1)
    }
  }

  /** "00dc", "01db": a video frame's chunk ID (JavaScript's /^\d\d(dc|db)$/). */
  private fun isFrameId(id: String) = id.length == 4 && id[0] in '0'..'9' && id[1] in '0'..'9' &&
    (id.endsWith("dc") || id.endsWith("db"))

  private fun riffChunks(src: RandomSource, from: Long, end: Long, depth: Int, patches: MutableList<Patch>) {
    var p = from
    while (p + 8 <= end) {
      val h = read(src, p, if (12 <= end - p) 12 else 8)
      val id = str(h, 0, 4)
      val n = u32le(h, 4)
      if (n == 0xFFFFFFFFL || p + 8 + n > end) return
      val list = if (id == "LIST" && h.size >= 12) str(h, 8, 4) else ""
      if (id in RIFF_BLANK || list in RIFF_BLANK_LIST) {
        patches.add(Patch(p, ascii("JUNK")))
        zeroPatches(patches, p + 8, n)
      } else if (list in RIFF_OPEN_LIST && depth < 3) riffChunks(src, p + 12, p + 8 + n, depth + 1, patches)
      else if (depth > 0 && isFrameId(id) && n >= 4) {
        val soi = read(src, p + 8, 2)
        if (soi[0] == 0xFF.toByte() && soi[1] == 0xD8.toByte()) CubeDocClean.jpegPatches(src, p + 8, patches)   // a motion-JPEG frame
      }
      p += 8 + n + (n and 1)
    }
  }

  // ---- MP4 / MOV: location tracks ----------------------------------------------------------------

  /**
   * Sample formats of timed-metadata tracks that carry a location: GoPro GPMF, Google's camera motion
   * metadata, DJI's metadata and debug tracks, Sony's real-time metadata.
   */
  private val LOCATION_FORMATS = setOf("gpmd", "camm", "djmd", "dbgi", "rtmd")
  /** Sample tables larger than this are not read (the track is still turned into a free box). */
  private const val TABLE_MAX = 64 * 1024 * 1024

  private fun child(src: RandomSource, b: Box, type: String): Box? =
    boxes(src, b.at + b.head, b.at + b.size).firstOrNull { it.type == type }

  /** JavaScript's \s, for the Latin-1 strings these run on. */
  private const val S = "[\\t\\n\\x0B\\f\\r \\xA0]"
  /** Text tracks (subtitles) whose samples are looked at for a printed position, as DJI drones write. */
  private val TEXT_FORMATS = setOf("tx3g", "text", "wvtt")
  /** How DJI subtitles print the position: "GPS (8.6332, 47.4028, 21)" or "[latitude: 47.40] [longitude: 8.63]". */
  private val PRINTED_POSITION = Regex("GPS$S*\\($S*-?[0-9]|\\[$S*latitude$S*:|\\[$S*longitude$S*:", RegexOption.IGNORE_CASE)

  /** A track's sample table and the format of its first sample entry. */
  private class SampleTable(val stbl: Box, val format: String)

  private fun sampleTable(src: RandomSource, trak: Box): SampleTable? {
    val mdia = child(src, trak, "mdia")
    val minf = mdia?.let { child(src, it, "minf") }
    val stbl = minf?.let { child(src, it, "stbl") }
    val stsd = stbl?.let { child(src, it, "stsd") }
    if (stbl == null || stsd == null || stsd.size < stsd.head + 16) return null
    return SampleTable(stbl, str(read(src, stsd.at + stsd.head + 12, 4), 0, 4))
  }

  /**
   * True (with its samples zeroed) for a track whose samples are locations: see LOCATION_FORMATS, and
   * text tracks whose first samples print a position.
   */
  private fun locationTrack(src: RandomSource, trak: Box, patches: MutableList<Patch>): Boolean {
    val t = sampleTable(src, trak) ?: return false
    if (t.format !in LOCATION_FORMATS) {
      if (t.format !in TEXT_FORMATS) return false
      val first = samples(src, t.stbl, 8)
      if (first.none { PRINTED_POSITION.containsMatchIn(str(read(src, it[0], minOf(it[1], 512L)), 0, 512)) }) return false
    }
    for (r in sampleRanges(src, t.stbl)) zeroPatches(patches, r[0], r[1])
    return true
  }

  /**
   * A video track's sample entries name the encoder (the 32-byte compressor name: "Lavc61 mjpeg",
   * an editor's name); it becomes empty. Only in tracks whose handler is video.
   */
  private fun compressorNames(src: RandomSource, trak: Box, patches: MutableList<Patch>) {
    val mdia = child(src, trak, "mdia") ?: return
    val hdlr = child(src, mdia, "hdlr") ?: return
    if (hdlr.size < hdlr.head + 12 || str(read(src, hdlr.at + hdlr.head + 8, 4), 0, 4) != "vide") return
    val minf = child(src, mdia, "minf")
    val stbl = minf?.let { child(src, it, "stbl") }
    val stsd = stbl?.let { child(src, it, "stsd") }
    if (stsd == null || stsd.size < stsd.head + 8) return
    for (e in boxes(src, stsd.at + stsd.head + 8, stsd.at + stsd.size)) {
      if (e.head == 8 && e.size >= 86) zeroPatches(patches, e.at + 50, 32)
    }
  }

  /** Sample formats of motion-JPEG video: every frame is a JPEG that can carry Exif. */
  private val MJPEG_FORMATS = setOf("jpeg", "mjpa", "mjpb", "AVDJ", "dmb1")

  /** Zeroes the Exif, XMP and comment segments of every frame of a motion-JPEG track. */
  private fun mjpegTrack(src: RandomSource, trak: Box, patches: MutableList<Patch>) {
    val t = sampleTable(src, trak) ?: return
    if (t.format !in MJPEG_FORMATS) return
    for (s in samples(src, t.stbl)) if (s[1] >= 4) CubeDocClean.jpegPatches(src, s[0], patches)
  }

  private fun table(src: RandomSource, b: Box?): ByteArray? {
    if (b == null || b.size - b.head < 8 || b.size - b.head > TABLE_MAX) return null
    return read(src, b.at + b.head, b.size - b.head)
  }

  /** Where a track's samples are in the file, adjacent samples merged; empty if the tables are odd. */
  private fun sampleRanges(src: RandomSource, stbl: Box): List<LongArray> {
    val ranges = ArrayList<LongArray>()
    for (s in samples(src, stbl)) {
      val last = ranges.lastOrNull()
      if (last != null && last[0] + last[1] == s[0]) last[1] += s[1]
      else if (s[1] > 0) ranges.add(longArrayOf(s[0], s[1]))
    }
    return ranges
  }

  /** Where each of a track's samples is in the file (the first `max`); empty if the tables are odd. */
  private fun samples(src: RandomSource, stbl: Box, max: Long = Long.MAX_VALUE): List<LongArray> {
    val kids = boxes(src, stbl.at + stbl.head, stbl.at + stbl.size)
    fun find(t: String) = kids.firstOrNull { it.type == t }
    val stsz = table(src, find("stsz"))
    val stsc = table(src, find("stsc"))
    val co64 = find("stco") == null
    val stco = table(src, find("stco") ?: find("co64"))
    if (stsz == null || stsc == null || stco == null || stsz.size < 12) return emptyList()
    val uniform = u32(stsz, 4)
    val count = u32(stsz, 8)
    if (uniform == 0L && stsz.size < 12 + count * 4) return emptyList()
    val chunks = u32(stco, 4)
    if (stco.size < 8 + chunks * (if (co64) 8 else 4)) return emptyList()
    val entries = u32(stsc, 4)
    if (stsc.size < 8 + entries * 12) return emptyList()
    val list = ArrayList<LongArray>()
    var s = 0L
    var e = 0
    var c = 1L
    while (c <= chunks && s < count && s < max) {
      while (e + 1 < entries && u32(stsc, 8 + (e + 1) * 12) <= c) e++
      val perChunk = if (entries != 0L) u32(stsc, 8 + e * 12 + 4) else 0L
      val ci = (c - 1).toInt()
      var at: Long
      if (co64) {
        val hi = u32(stco, 8 + ci * 8)
        if (hi >= 0x8000_0000L) return list   // past any file
        at = hi * 0x1_0000_0000L + u32(stco, 12 + ci * 8)
      } else at = u32(stco, 8 + ci * 4)
      var k = 0L
      while (k < perChunk && s < count && s < max) {
        val n = if (uniform != 0L) uniform else u32(stsz, 12 + (s * 4).toInt())
        if (at + n > src.size) return list
        list.add(longArrayOf(at, n))
        at += n
        k++
        s++
      }
      c++
    }
    return list
  }

  // ---- Insta360 trailer --------------------------------------------------------------------------

  private const val INSTA360_MAGIC = "8db42d694ccc418790edff439fe026bf"

  /**
   * Insta360 cameras append a trailer after the video: records (each its data, then a record ID and
   * length) and 72 bytes ending in a magic number, with the trailer's length 38 bytes into the last
   * 78. The GPS record (0x700) is zeroed, and the serial number (tag 0x0a) in the camera record
   * (0x101); the motion, exposure and lens records that stitching needs stay. Record 0 is a table of
   * where the others are, used when present (as ExifTool reads it).
   */
  private fun insta360(src: RandomSource, patches: MutableList<Patch>) {
    if (src.size < 78) return
    val tail = read(src, src.size - 78, 78)
    if (str(tail, 46, 32) != INSTA360_MAGIC) return
    val length = u32le(tail, 38)
    if (length > src.size || length < 78) return
    val start = src.size - length
    val records = ArrayList<LongArray>()   // ID, where its data starts, its length
    var foot = src.size - 78   // where the last record's ID and length are
    for (k in 0 until 4096) {
      val f = read(src, foot, 6)
      val id = u8(f, 0) or (u8(f, 1) shl 8)
      val len = u32le(f, 2)
      if (foot - len < start) break
      records.add(longArrayOf(id.toLong(), foot - len, len))
      if (id == 0) {   // the table: ID, size, offset from the trailer's start, 10 bytes each
        val table = read(src, foot - len, minOf(len, 1L shl 16))
        records.clear()
        var p = 0
        while (p + 10 <= table.size) {
          val rid = u8(table, p) or (u8(table, p + 1) shl 8)
          val size = u32le(table, p + 2)
          val off = u32le(table, p + 6)
          if (rid != 0 && size != 0L && off + size < length) records.add(longArrayOf(rid.toLong(), start + off, size))
          p += 10
        }
        break
      }
      foot = foot - len - 6
      if (foot < start) break
    }
    for (r in records) {
      val id = r[0]
      val at = r[1]
      val len = r[2]
      if (id == 0x700L) zeroPatches(patches, at, len)
      else if (id == 0x101L) {
        val b = read(src, at, minOf(len, 4096L))
        var p = 0
        var i = 0
        while (i < 4 && p + 2 <= b.size) {
          val n = u8(b, p + 1)
          if (p + 2 + n > b.size) break
          if (u8(b, p) == 0x0A) zeroPatches(patches, at + p + 2, n.toLong())   // serial number
          p += 2 + n
          i++
        }
      }
    }
  }

  // ---- AIFF --------------------------------------------------------------------------------------

  private val AIFF_BLANK = setOf("NAME", "AUTH", "(c) ", "ANNO", "COMT", "ID3 ", "id3 ")

  private fun aiff(src: RandomSource, patches: MutableList<Patch>) {
    val end = minOf(src.size, 8 + u32(read(src, 4, 4), 0))
    var p = 12L
    while (p + 8 <= end) {
      val h = read(src, p, 8)
      val id = str(h, 0, 4)
      val n = u32(h, 4)
      if (p + 8 + n > end) return
      if (id in AIFF_BLANK) {
        patches.add(Patch(p, ascii("JUNK")))
        zeroPatches(patches, p + 8, n)
      }
      p += 8 + n + (n and 1)
    }
  }

  // ---- Ogg ---------------------------------------------------------------------------------------

  private val OGG_CRC = IntArray(256).also { t ->
    for (i in 0 until 256) {
      var r = i shl 24
      for (k in 0 until 8) r = if (r and 0x80000000.toInt() != 0) (r shl 1) xor 0x04C11DB7 else r shl 1
      t[i] = r
    }
  }

  private fun oggCrc(b: ByteArray): Int {
    var c = 0
    for (x in b) c = (c shl 8) xor OGG_CRC[((c ushr 24) xor (x.toInt() and 0xFF)) and 0xFF]
    return c
  }

  /** One piece of a packet: where it is in the file and the page it is on. */
  private class Segment(val at: Long, val n: Int, val page: Long)
  private class OggStream(var codec: String, var packet: Int, var segs: MutableList<Segment>, var done: Boolean, var headers: Long)

  /** The first `n` bytes of a packet (fewer if it is shorter). */
  private fun packetHead(src: RandomSource, segs: List<Segment>, n: Int): ByteArray {
    val out = ByteArray(n)
    var q = 0
    for (s in segs) {
      if (q >= n) break
      val k = minOf(s.n, n - q)
      System.arraycopy(read(src, s.at, k.toLong()), 0, out, q, k)
      q += k
    }
    return out.copyOf(q)
  }

  /**
   * The cleaned start of a header packet (the rest of the packet becomes zeros), or null to leave it.
   * Comment headers keep their magic and get an empty vendor and no comments: Vorbis (with its framing
   * bit), Opus (zeros after the comment list are padding by RFC 7845), Theora and Speex. Ogg FLAC's
   * metadata blocks are cleaned as in a FLAC file.
   */
  private fun oggPacket(s: OggStream, head: ByteArray, total: Long): ByteArray? {
    val magic = str(head, 0, 8)
    if (s.codec == "vorbis" && magic.startsWith("\u0003vorbis") && total >= 16) {
      val out = ByteArray(16)
      System.arraycopy(head, 0, out, 0, 7)
      out[15] = 1   // framing bit
      return out
    }
    if (s.codec == "opus" && magic == "OpusTags" && total >= 16) return head.copyOf(8)
    if (s.codec == "theora" && magic.startsWith("\u0081theora") && total >= 15) return head.copyOf(7)
    if (s.codec == "speex" && total >= 8) return ByteArray(0)
    if (s.codec == "flac" && head.size >= 4) {
      val type = u8(head, 0) and 0x7F
      if (type != 2 && type != 4 && type != 6) return null
      return byteArrayOf(((u8(head, 0) and 0x80) or 1).toByte(), head[1], head[2], head[3])
    }
    return null
  }

  private fun ogg(src: RandomSource, patches: MutableList<Patch>) {
    val streams = LinkedHashMap<Long, OggStream>()
    val own = ArrayList<Patch>()
    val touched = LinkedHashSet<Long>()   // in the order of first touch, as JavaScript's Set
    val pageLength = HashMap<Long, Long>()
    var p = 0L
    while (p + 27 <= src.size) {
      val h = read(src, p, 27)
      if (str(h, 0, 4) != "OggS" || h[4] != 0.toByte()) break
      val flags = u8(h, 5)
      val serial = u32le(h, 14)
      val lacing = read(src, p + 27, u8(h, 26).toLong())
      var at = p + 27 + lacing.size
      var len = 0L
      for (l in lacing) len += l.toInt() and 0xFF
      if (at + len > src.size) break
      pageLength[p] = at + len - p
      var s = streams[serial]
      if (flags and 2 != 0) {
        s = OggStream("", 0, ArrayList(), false, 0)
        streams[serial] = s
      }
      if (s != null && !s.done) {
        for (lb in lacing) {
          val l = lb.toInt() and 0xFF
          s.segs.add(Segment(at, l, p))
          at += l
          if (l == 255) continue
          packet(src, s, own, touched)
          s.segs = ArrayList()
          s.packet++
          if (s.done) break
        }
      }
      p += pageLength[p]!!
    }
    for (page in touched) {
      val n = pageLength[page]!!
      val b = read(src, page, n).copyOf()
      val mine = own.filter { it.at >= page && it.at < page + n }
      for (x in mine) System.arraycopy(x.bytes, 0, b, (x.at - page).toInt(), x.length)
      b.fill(0, 22, 26)
      val crc = oggCrc(b)
      b.fill(0)
      patches.addAll(mine)
      patches.add(Patch(page + 22, byteArrayOf(crc.toByte(), (crc ushr 8).toByte(), (crc ushr 16).toByte(), (crc ushr 24).toByte())))
    }
  }

  /** Handles one whole packet of a stream: identifies the codec, or cleans a header packet. */
  private fun packet(src: RandomSource, s: OggStream, own: MutableList<Patch>, touched: MutableSet<Long>) {
    val total = s.segs.sumOf { it.n.toLong() }
    val head = packetHead(src, s.segs, 16)
    if (s.packet == 0) {
      val magic = str(head, 0, 8)
      if (magic.startsWith("\u0001vorbis")) s.codec = "vorbis"
      else if (magic == "OpusHead") s.codec = "opus"
      else if (magic.startsWith("\u0080theora")) s.codec = "theora"
      else if (magic == "Speex   ") s.codec = "speex"
      else if (magic.startsWith("\u007fFLAC") && head.size >= 9) {
        s.codec = "flac"
        s.headers = u16(head, 7).toLong().takeIf { it != 0L } ?: Long.MAX_VALUE   // header packets after this one (0: not said)
      } else s.done = true
      return
    }
    if (s.codec == "flac") {
      val h0 = if (head.isEmpty()) 0 else u8(head, 0)
      if (head.isNotEmpty() && h0 == 0xFF) {   // an audio frame: no more metadata
        s.done = true
        return
      }
      if (h0 and 0x80 != 0) s.done = true
      else if (--s.headers <= 0) s.done = true
    } else s.done = true   // the comment header is the second packet
    val clean = oggPacket(s, head, total) ?: return
    var q = 0
    for (seg in s.segs) {
      val k = maxOf(0, minOf(seg.n, clean.size - q))
      if (k > 0) own.add(Patch(seg.at, clean.copyOfRange(q, q + k)))
      zeroPatches(own, seg.at + k, (seg.n - k).toLong())
      q += seg.n
      touched.add(seg.page)
    }
  }

  // ---- Matroska, WebM ----------------------------------------------------------------------------

  private object EBML {
    const val Header = 0x1A45DFA3L
    const val DocType = 0x4282L
    const val Segment = 0x18538067L
    const val SeekHead = 0x114D9B74L
    const val Seek = 0x4DBBL
    const val SeekID = 0x53ABL
    const val SeekPosition = 0x53ACL
    const val Info = 0x1549A966L
    const val Title = 0x7BA9L
    const val MuxingApp = 0x4D80L
    const val WritingApp = 0x5741L
    const val Tags = 0x1254C367L
    const val Attachments = 0x1941A469L
    const val AttachedFile = 0x61A7L
    const val FileMimeType = 0x4660L
    const val Crc32 = 0xBFL
    const val Tracks = 0x1654AE6BL
    const val TrackEntry = 0xAEL
    const val CodecID = 0x86L
    const val CodecPrivate = 0x63A2L
    const val Name = 0x536EL
    const val TrackNumber = 0xD7L
    const val Chapters = 0x1043A770L
    const val EditionEntry = 0x45B9L
    const val ChapterAtom = 0xB6L
    const val ChapterDisplay = 0x80L
    const val ChapString = 0x85L
    const val Cluster = 0x1F43B675L
    const val SimpleBlock = 0xA3L
    const val BlockGroup = 0xA0L
    const val Block = 0xA1L
  }
  /** Elements that can appear inside a cluster, to find where a cluster of unknown size ends. */
  private val CLUSTER_CHILDREN = setOf(0xE7L, 0xA7L, 0xABL, 0x5854L, 0xA3L, 0xA0L, 0xAFL, 0xECL, 0xBFL)

  /** An element: where it starts, its ID, where its data starts and ends (end -1: unknown size). */
  private class El(val at: Long, val id: Long, val data: Long, val end: Long)

  private fun element(src: RandomSource, at: Long, limit: Long): El? {
    val h = read(src, at, minOf(12L, limit - at))
    if (h.size < 2) return null
    val idLen = Integer.numberOfLeadingZeros(u8(h, 0)) - 23   // 1 to 4: the first set bit gives the width
    if (idLen < 1 || idLen > 4 || h.size < idLen + 1) return null
    var id = 0L
    for (i in 0 until idLen) id = id * 256 + u8(h, i)
    val sizeLen = Integer.numberOfLeadingZeros(u8(h, idLen)) - 23
    if (sizeLen < 1 || sizeLen > 8 || h.size < idLen + sizeLen) return null
    var size = (u8(h, idLen) and (0xFF shr sizeLen)).toLong()
    var unknown = size == (0xFF shr sizeLen).toLong()
    for (i in 1 until sizeLen) {
      size = size * 256 + u8(h, idLen + i)
      if (u8(h, idLen + i) != 0xFF) unknown = false
    }
    val data = at + idLen + sizeLen
    if (unknown) return El(at, id, data, -1)
    if (data + size > limit) return null
    return El(at, id, data, data + size)
  }

  private fun children(src: RandomSource, from: Long, to: Long): List<El> {
    val list = ArrayList<El>()
    var p = from
    while (p < to) {
      val e = element(src, p, to)
      if (e == null || e.end < 0) break
      list.add(e)
      p = e.end
    }
    return list
  }

  /** Turns an element into a Void element of the same length, its contents zeroed. */
  private fun voidElement(e: El, patches: MutableList<Patch>) {
    val t = e.end - e.at
    if (t < 2) return
    val head: ByteArray
    if (t - 2 <= 126) head = byteArrayOf(0xEC.toByte(), (0x80 or (t - 2).toInt()).toByte())
    else {
      head = ByteArray(9)
      head[0] = 0xEC.toByte()
      head[1] = 0x01   // an 8-byte size
      var v = t - 9
      for (i in 8 downTo 2) {
        head[i] = (v and 0xFF).toByte()
        v = v ushr 8
      }
    }
    patches.add(Patch(e.at, head))
    zeroPatches(patches, e.at + head.size, t - head.size)
  }

  private fun uint(src: RandomSource, e: El): Long {
    val b = read(src, e.data, minOf(8L, e.end - e.data))
    var v = 0L
    for (x in b) v = v * 256 + (x.toInt() and 0xFF)
    return v
  }

  /** The element's data as a string, at most `max` bytes, trailing NULs dropped. */
  private fun text(src: RandomSource, e: El, max: Long): String {
    val n = minOf(max, e.end - e.data)
    return str(read(src, e.data, n), 0, n.toInt()).trimEnd('\u0000')
  }

  /** Empties every chapter title (ChapString) under Chapters, nested chapters included. */
  private fun chapterTitles(src: RandomSource, e: El, depth: Int, patches: MutableList<Patch>) {
    if (depth > 16) return
    for (k in children(src, e.data, e.end)) {
      if (k.id == EBML.ChapString) zeroPatches(patches, k.data, k.end - k.data)
      else if (k.id == EBML.EditionEntry || k.id == EBML.ChapterAtom || k.id == EBML.ChapterDisplay) chapterTitles(src, k, depth + 1, patches)
    }
  }

  /**
   * Walks every cluster (those of unknown size too: one ends where an element that cannot be in a
   * cluster starts) and cleans the frames of motion-JPEG tracks. Laced blocks (several frames in one)
   * are not used for video and are left alone.
   */
  private fun mjpegClusters(src: RandomSource, from: Long, to: Long, tracks: Set<Long>, patches: MutableList<Patch>) {
    fun frame(b: El) {
      val h = read(src, b.data, minOf(12L, b.end - b.data))
      val w = if (h.isNotEmpty()) Integer.numberOfLeadingZeros(u8(h, 0)) - 23 else 0   // the track number's width
      if (w < 1 || w > 8 || h.size < w + 3) return
      var track = (u8(h, 0) and (0xFF shr w)).toLong()
      for (i in 1 until w) track = track * 256 + u8(h, i)
      if (track !in tracks || (u8(h, w + 2) and 0x06) != 0) return   // another track, or laced
      if (b.data + w + 3 + 4 <= b.end) CubeDocClean.jpegPatches(src, b.data + w + 3, patches)
    }
    var p = from
    while (p < to) {
      val e = element(src, p, to) ?: return
      if (e.id != EBML.Cluster) {
        if (e.end < 0) return
        p = e.end
        continue
      }
      val end = if (e.end < 0) to else e.end
      var q = e.data
      while (q < end) {
        val k = element(src, q, end)
        if (k == null || k.end < 0 || (e.end < 0 && k.id !in CLUSTER_CHILDREN)) break
        if (k.id == EBML.SimpleBlock) frame(k)
        else if (k.id == EBML.BlockGroup) for (b in children(src, k.data, k.end)) if (b.id == EBML.Block) frame(b)
        q = k.end
      }
      p = if (e.end < 0) q else e.end
      if (e.end < 0 && q >= end) return
    }
  }

  private fun matroska(src: RandomSource, patches: MutableList<Patch>) {
    val header = element(src, 0, src.size)
    if (header == null || header.id != EBML.Header || header.end < 0) return
    val docType = children(src, header.data, header.end).firstOrNull { it.id == EBML.DocType }
    val type = if (docType != null) text(src, docType, 16) else ""
    if (type != "matroska" && type != "webm") return
    val seg = element(src, header.end, src.size)
    if (seg == null || seg.id != EBML.Segment) return
    val segEnd = if (seg.end < 0) src.size else seg.end
    val seen = HashSet<Long>()
    val queue = ArrayDeque<Long>()
    val mjpeg = HashSet<Long>()   // track numbers of motion-JPEG video
    // the segment's children one after another, as far as their sizes are known (a live recording's
    // clusters may not say), then whatever the seek heads point to
    var p = seg.data
    while (p < segEnd) {
      val e = element(src, p, segEnd)
      if (e == null || e.end < 0) break
      queue.addLast(e.at)
      p = e.end
    }
    while (queue.isNotEmpty()) {
      val at = queue.removeFirst()
      if (!seen.add(at)) continue
      val e = element(src, at, segEnd)
      if (e == null || e.end < 0) continue
      when (e.id) {
        EBML.SeekHead -> for (seek in children(src, e.data, e.end)) {
          if (seek.id != EBML.Seek) continue
          val kids = children(src, seek.data, seek.end)
          val sid = kids.firstOrNull { it.id == EBML.SeekID }
          val pos = kids.firstOrNull { it.id == EBML.SeekPosition }
          if (sid == null || pos == null) continue
          val target = uint(src, sid)
          if (target == EBML.Info || target == EBML.Tags || target == EBML.Attachments || target == EBML.SeekHead || target == EBML.Tracks || target == EBML.Chapters) queue.addLast(seg.data + uint(src, pos))
        }
        EBML.Info -> for (k in children(src, e.data, e.end)) {
          if (k.id == EBML.Title || k.id == EBML.MuxingApp || k.id == EBML.WritingApp) zeroPatches(patches, k.data, k.end - k.data)   // an empty string
          else if (k.id == EBML.Crc32) voidElement(k, patches)
        }
        EBML.Tracks -> for (t in children(src, e.data, e.end)) {
          if (t.id != EBML.TrackEntry) continue
          codecPrivate(src, t, patches)
          val kids = children(src, t.data, t.end)
          for (k in kids) if (k.id == EBML.Name) zeroPatches(patches, k.data, k.end - k.data)   // an empty name
          val idEl = kids.firstOrNull { it.id == EBML.CodecID }
          val num = kids.firstOrNull { it.id == EBML.TrackNumber }
          if (idEl != null && num != null && text(src, idEl, 64) == "V_MJPEG") mjpeg.add(uint(src, num))
        }
        EBML.Chapters -> chapterTitles(src, e, 0, patches)
        EBML.Tags -> voidElement(e, patches)
        EBML.Attachments -> {
          val kids = children(src, e.data, e.end)
          val files = kids.filter { it.id == EBML.AttachedFile }
          val images = files.filter { f ->
            val mime = children(src, f.data, f.end).firstOrNull { it.id == EBML.FileMimeType }
            mime != null && str(read(src, mime.data, minOf(6L, mime.end - mime.data)), 0, 6) == "image/"
          }
          if (images.isNotEmpty() && images.size == files.size) voidElement(e, patches)
          else if (images.isNotEmpty()) {
            for (f in images) voidElement(f, patches)
            for (k in kids) if (k.id == EBML.Crc32) voidElement(k, patches)
          }
        }
      }
    }
    if (mjpeg.isNotEmpty()) mjpegClusters(src, seg.data, segEnd, mjpeg, patches)
  }

  /**
   * A track's codec setup, where Matroska keeps what Ogg and FLAC files keep in their headers: the
   * Vorbis or Theora comment header (the second of three Xiph-laced packets) is emptied, and FLAC's
   * metadata blocks are cleaned as in a FLAC file.
   */
  private fun codecPrivate(src: RandomSource, track: El, patches: MutableList<Patch>) {
    val kids = children(src, track.data, track.end)
    val idEl = kids.firstOrNull { it.id == EBML.CodecID }
    val cp = kids.firstOrNull { it.id == EBML.CodecPrivate }
    if (idEl == null || cp == null) return
    val codec = text(src, idEl, 32)
    val n = cp.end - cp.data
    if (codec == "A_FLAC") {
      if (n >= 4 && str(read(src, cp.data, 4), 0, 4) == "fLaC") flac(src, cp.data + 4, patches, cp.end)
      return
    }
    if (codec != "A_VORBIS" && codec != "V_THEORA") return
    val head = read(src, cp.data, minOf(n, 64L))
    if (head.isEmpty() || head[0] != 2.toByte()) return   // three packets
    val sizes = LongArray(2)
    var q = 1
    for (k in 0 until 2) {
      var size = 0L
      while (true) {
        if (q >= head.size) return
        size += u8(head, q)
        if (u8(head, q++) != 255) break
      }
      sizes[k] = size
    }
    val at = cp.data + q + sizes[0]
    if (at + sizes[1] > cp.end) return
    val s = OggStream(if (codec == "A_VORBIS") "vorbis" else "theora", 1, ArrayList(), true, 0)
    val clean = oggPacket(s, read(src, at, minOf(16L, sizes[1])), sizes[1]) ?: return
    patches.add(Patch(at, clean.copyOf()))
    zeroPatches(patches, at + clean.size, sizes[1] - clean.size)
  }
}
