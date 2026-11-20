package expo.modules.cubenative

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * Removes author and organisation details from documents while they stream in (runImport). Plain
 * JVM only, so the unit tests run it against vectors from JavaScript (tests/native). A port of
 * lib/docmeta.ts, the same as ios/CubeDocClean.swift.
 *
 * - PDF: PdfCleaner, a port of the machine in lib/docmeta.ts (byte for byte the same output):
 *   document-information strings and XMP packets are blanked in place. pdfStreamPatches finds the
 *   Flate-compressed object and XMP streams (PNG predictors and indirect /Length included) and
 *   embedded JPEG photos worth changing and returns same-length patches for them.
 * - Zip documents (Office, OpenDocument, EPUB): the zip (zip64 included) is read in place, central
 *   directory first, and every document zip is written out again in one pass, one entry in memory
 *   at a time: XML parts are emptied by cleanXml with lib/docmeta.ts's rules (xmlRules), photos go
 *   through CubeStrip, every other entry is copied byte for byte, still compressed. Anything unusual
 *   (encryption, not a document, too large for a plain zip) leaves the file as it was picked.
 * - RTF: RtfCleaner drops the \info fields, revision and comment authors as the file streams through.
 * - SVG: cleanXml with SVG_RULES (comments, <metadata>, editor attributes holding file paths).
 * Videos and audio are cleaned by CubeMediaClean, with the same Patch and RandomSource types.
 */
object CubeDocClean {
  // ---- PDF -----------------------------------------------------------------------------------

  private val KEYS = setOf("Author", "Creator", "Producer", "Title", "Subject", "Keywords")
  private val TAGS = listOf(
    Triple("<x:xmpmeta".toByteArray(), "</x:xmpmeta>".toByteArray(), "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">".toByteArray()),
    Triple("<rdf:RDF".toByteArray(), "</rdf:RDF>".toByteArray(),
      "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">".toByteArray()),
  )
  const val XMP_MAX = 16 * 1024 * 1024

  class PdfCleaner {
    private enum class Mode { NORMAL, NAME, AFTER_KEY, HEX_OR_DICT, HEX, LITERAL, TAG, CAPTURE }

    private var mode = Mode.NORMAL
    private val name = StringBuilder()
    private var depth = 0
    private var escape = false
    private var hexN = 0
    private var held = Bytes()
    private var kind = 0
    private val out = Bytes()

    /** Feeds bytes in; returns the bytes that are final so far. */
    fun push(input: ByteArray, off: Int = 0, len: Int = input.size): ByteArray {
      out.reserve(len)
      for (i in off until off + len) step(input[i].toInt() and 0xFF)
      return out.take()
    }

    /** Ends the stream: anything still held passes through as it is. */
    fun finish(): ByteArray {
      out.addAll(held)
      held.wipe()
      mode = Mode.NORMAL
      return out.take()
    }

    private fun isWhite(c: Int) = c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 || c == 0x0C || c == 0x00
    private fun isAlnum(c: Int) = (c in 0x30..0x39) || (c in 0x41..0x5A) || (c in 0x61..0x7A)

    private fun step(c: Int) {
      when (mode) {
        Mode.NAME -> {
          if (isAlnum(c)) {
            if (name.length <= 8) name.append(c.toChar())
            out.add(c)
            return
          }
          mode = if (name.length <= 8 && name.toString() in KEYS) Mode.AFTER_KEY else Mode.NORMAL
          step(c)
        }
        Mode.AFTER_KEY -> when {
          isWhite(c) -> out.add(c)
          c == 0x28 -> { mode = Mode.LITERAL; depth = 1; escape = false; out.add(c) }
          c == 0x3C -> { mode = Mode.HEX_OR_DICT; out.add(c) }
          else -> { mode = Mode.NORMAL; step(c) }
        }
        Mode.HEX_OR_DICT -> {
          if (c == 0x3C) { mode = Mode.NORMAL; out.add(c); return }
          mode = Mode.HEX
          hexN = 0
          step(c)
        }
        Mode.HEX -> when {
          c == 0x3E -> { mode = Mode.NORMAL; out.add(c) }
          isWhite(c) -> out.add(c)
          else -> { out.add(if (hexN % 2 == 0) 0x32 else 0x30); hexN++ }
        }
        Mode.LITERAL -> when {
          escape -> { escape = false; out.add(0x20) }
          c == 0x5C -> { escape = true; out.add(0x20) }
          c == 0x28 -> { depth++; out.add(0x20) }
          c == 0x29 -> {
            depth--
            if (depth == 0) { mode = Mode.NORMAL; out.add(c) } else out.add(0x20)
          }
          else -> out.add(0x20)
        }
        Mode.TAG -> {
          held.add(c)
          var prefix = false
          for ((k, t) in TAGS.withIndex()) {
            val open = t.first
            if (held.size > open.size) continue
            if (!held.startsWithPrefixOf(open)) continue
            if (held.size == open.size) { mode = Mode.CAPTURE; kind = k; return }
            prefix = true
          }
          if (prefix) return
          held.removeLast()
          out.addAll(held)
          held.clear()
          mode = Mode.NORMAL
          step(c)
        }
        Mode.CAPTURE -> {
          held.add(c)
          val (open, close, head) = TAGS[kind]
          if (held.size >= open.size + close.size && held.endsWith(close)) {
            if (held.size >= head.size + close.size) {
              for (i in 0 until held.size - close.size) held[i] = if (i < head.size) head[i].toInt() and 0xFF else 0x20
            }
            out.addAll(held)
            held.wipe()
            mode = Mode.NORMAL
          } else if (held.size > XMP_MAX) {
            out.addAll(held)
            held.wipe()
            mode = Mode.NORMAL
          }
        }
        Mode.NORMAL -> when (c) {
          0x2F -> { mode = Mode.NAME; name.setLength(0); out.add(c) }
          0x3C -> { mode = Mode.TAG; held.clear(); held.add(c) }
          else -> out.add(c)
        }
      }
    }
  }

  // ---- PDF: compressed object and metadata streams ----------------------------------------------

  /**
   * Bytes to put at an offset, replacing as many: the file keeps its length. Only the first `length`
   * bytes of `bytes` are used (zero runs share one block, CubeMediaClean.ZERO); never write to them.
   */
  class Patch(val at: Long, val bytes: ByteArray, val length: Int = bytes.size)
  const val STREAM_MAX = 16 * 1024 * 1024

  // JavaScript's \s, for the Latin-1 strings these run on (Java's \s lacks the no-break space).
  private const val S = "[\\t\\n\\x0B\\f\\r \\xA0]"
  private val DCT_RE = Regex("/Filter$S*(/DCTDecode|\\[$S*/DCTDecode$S*])")
  private val TYPE_RE = Regex("/Type$S*/(ObjStm|Metadata)(?![A-Za-z0-9])")
  private val FILTER_RE = Regex("/Filter$S*(/FlateDecode|\\[$S*/FlateDecode$S*])")
  private val PARMS_RE = Regex("/DecodeParms$S*(?:\\[$S*)?<<([^<>]*)>>")
  private val PREDICTOR_RE = Regex("/Predictor$S+(\\d+)")
  private val COLORS_RE = Regex("/Colors$S+(\\d+)")
  private val BPC_RE = Regex("/BitsPerComponent$S+(\\d+)")
  private val COLUMNS_RE = Regex("/Columns$S+(\\d+)")
  private val LENGTH_RE = Regex("/Length$S+(\\d+)(?!$S*\\d*$S+R)(?![0-9])")
  private val LENGTH_REF_RE = Regex("/Length$S+(\\d+)$S+(\\d+)$S+R")
  private val ENDSTREAM_RE = Regex("^(\r\n|\r|\n)?endstream")
  private val OBJ_INT_RE = Regex("(?<![0-9])(\\d+)$S+(\\d+)$S+obj$S*(\\d+)$S*endobj")

  /** A stream whose /Length is "n g R", to look at again once that object is found. */
  private class Pending(val p: Long, val ref: String)
  /** A stream length and where its digits sit in the file. */
  private class Length(val value: Long, val at: Long, val digits: Int)

  /** JavaScript's Number(digits) for the sizes that matter; anything too long saturates. */
  private fun number(digits: String): Long = digits.toLongOrNull() ?: Long.MAX_VALUE
  private fun ref(a: String, b: String) = "${number(a)} ${number(b)}"

  /**
   * The same streams and patches as lib/docmeta.ts pdfStreamPatches: Flate-compressed object streams
   * (/Type /ObjStm) and XMP streams (/Type /Metadata) whose contents PdfCleaner changes are
   * decompressed (PNG predictors undone), cleaned, recompressed and written back at the same offset,
   * padded with newlines, with the /Length number rewritten (spaces after it), in the stream's
   * dictionary or in the object an indirect /Length points to. JPEG photos (/DCTDecode) lose their
   * Exif, XMP, IPTC and comment segments (zeroed). Anything unusual (a /Length that does not end at
   * "endstream", a bad checksum, other filters or decode parameters) is left alone.
   */
  fun pdfStreamPatches(src: RandomSource): List<Patch> {
    val patches = ArrayList<Patch>()
    val pending = ArrayList<Pending>()
    val step = 1 shl 20
    val kw = "stream".toByteArray()
    var start = 0L
    while (start < src.size) {
      val win = try { src.read(start, minOf(step.toLong() + kw.size, src.size - start).toInt()) } catch (e: Exception) { break }
      var i = 0
      while (i < minOf(step, win.size) && i + kw.size <= win.size) {
        if (win[i] == 0x73.toByte() && (1 until kw.size).all { win[i + it] == kw[it] }) {
          runCatching { streamPatch(src, start + i, patches, pending, null) }
        }
        i++
      }
      start += step
    }
    if (pending.isNotEmpty()) {
      val lengths = runCatching { indirectLengths(src, pending.map { it.ref }.toSet()) }.getOrNull() ?: emptyMap()
      for (x in pending) {
        val len = lengths[x.ref] ?: continue
        runCatching { streamPatch(src, x.p, patches, null, len) }
      }
    }
    return patches
  }

  /**
   * Finds "n g obj <integer> endobj" for each wanted "n g" (the last definition wins, as in an
   * updated PDF). Lengths kept inside object streams are not found: those streams stay as they are.
   */
  private fun indirectLengths(src: RandomSource, wanted: Set<String>): Map<String, Length> {
    val found = HashMap<String, Length>()
    val step = 1 shl 20
    var start = 0L
    while (start < src.size) {
      // from 32 bytes before the window, so a number cut by the window's start is read whole
      val from = maxOf(0L, start - 32)
      val t = String(src.read(from, (minOf(start + step + 256, src.size) - from).toInt()), Charsets.ISO_8859_1)
      for (m in OBJ_INT_RE.findAll(t)) {
        val r = ref(m.groupValues[1], m.groupValues[2])
        if (r !in wanted) continue
        val g = m.groups[3]!!
        found[r] = Length(number(g.value), from + g.range.first, g.value.length)
      }
      start += step
    }
    return found
  }

  /** Looks at the "stream" keyword at `p`; adds patches if it starts a stream worth cleaning. */
  private fun streamPatch(src: RandomSource, p: Long, patches: MutableList<Patch>, pending: MutableList<Pending>?, given: Length?) {
    if (p >= 3 && String(src.read(p - 3, 3), Charsets.ISO_8859_1) == "end") return
    val eol = src.read(p + 6, minOf(2L, src.size - p - 6).toInt())
    if (eol.isEmpty()) return
    val dataStart = when {
      eol.size == 2 && eol[0] == 0x0D.toByte() && eol[1] == 0x0A.toByte() -> p + 8
      eol[0] == 0x0A.toByte() -> p + 7
      else -> return
    }
    val back = minOf(4096L, p).toInt()
    val before = src.read(p - back, back)
    fun white(c: Byte) = c == 0x20.toByte() || c == 0x0A.toByte() || c == 0x0D.toByte() || c == 0x09.toByte() || c == 0x0C.toByte() || c == 0.toByte()
    var q = before.size - 1
    while (q >= 0 && white(before[q])) q--
    if (q < 1 || before[q] != 0x3E.toByte() || before[q - 1] != 0x3E.toByte()) return
    var depth = 0
    var open = -1
    var k = q
    while (k >= 1) {
      if (before[k] == 0x3E.toByte() && before[k - 1] == 0x3E.toByte()) { depth++; k-- }
      else if (before[k] == 0x3C.toByte() && before[k - 1] == 0x3C.toByte()) {
        depth--
        k--
        if (depth == 0) { open = k; break }
      }
      k--
    }
    if (open < 0) return
    val dict = String(before, open, q + 1 - open, Charsets.ISO_8859_1)
    if (DCT_RE.containsMatchIn(dict)) {
      if (pending != null) jpegPatches(src, dataStart, patches)
      return
    }
    if (!TYPE_RE.containsMatchIn(dict) || !FILTER_RE.containsMatchIn(dict)) return
    var columns = 0   // 0: no predictor
    if (dict.contains("/DecodeParms")) {
      val parms = PARMS_RE.find(dict)?.groupValues?.get(1) ?: return
      fun num(re: Regex, dflt: Long) = re.find(parms)?.let { number(it.groupValues[1]) } ?: dflt
      val predictor = num(PREDICTOR_RE, 1)
      var cols = 0L
      if (predictor in 10..15 && num(COLORS_RE, 1) == 1L && num(BPC_RE, 8) == 8L) cols = num(COLUMNS_RE, 1)
      else if (predictor != 1L) return
      if (predictor != 1L && (cols < 1 || cols > STREAM_MAX)) return
      columns = cols.toInt()
    }
    val len: Length
    if (given != null) len = given
    else {
      val direct = LENGTH_RE.find(dict)
      if (direct == null) {
        val r = LENGTH_REF_RE.find(dict)
        if (r != null && pending != null) pending.add(Pending(p, ref(r.groupValues[1], r.groupValues[2])))
        return
      }
      val digits = direct.groups[1]!!
      len = Length(number(digits.value), p - back + open + digits.range.first, digits.value.length)
    }
    val l = len.value
    if (l > STREAM_MAX || dataStart + l > src.size) return
    // the length must end where "endstream" starts (after an optional end of line): a wrong length is
    // never trusted with a patch
    val after = String(src.read(dataStart + l, minOf(11L, src.size - dataStart - l).toInt()), Charsets.ISO_8859_1)
    if (!ENDSTREAM_RE.containsMatchIn(after)) return
    val data = src.read(dataStart, l.toInt())
    if (data.size < 6 || (data[0].toInt() and 0x0F) != 8 || (((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)) % 31 != 0) return
    val stored = unzlib(data) ?: return
    // the checksum in the stream's last 4 bytes, as lib/docmeta.ts checks it (Inflater checks the
    // one where the zlib data ends, which differs when the length counts bytes after it)
    val want = ((data[data.size - 4].toLong() and 0xFF) shl 24) or ((data[data.size - 3].toLong() and 0xFF) shl 16) or
      ((data[data.size - 2].toLong() and 0xFF) shl 8) or (data[data.size - 1].toLong() and 0xFF)
    if (adler32(stored) != want) { stored.fill(0); return }
    val plain = if (columns > 0) unpredict(stored, columns) else stored
    if (plain == null) { stored.fill(0); return }
    val c = PdfCleaner()
    val clean = c.push(plain) + c.finish()
    val unchanged = clean.contentEquals(plain)
    stored.fill(0)
    plain.fill(0)
    if (unchanged) { clean.fill(0); return }
    val rows = if (columns > 0) predictNone(clean, columns) else clean
    val z = zlib(rows)
    clean.fill(0)
    rows.fill(0)
    if (z.size > l) { z.fill(0); return }   // cleaned but no smaller: cannot fit, left as it is
    val bytes = ByteArray(l.toInt()) { 0x0A.toByte() }
    System.arraycopy(z, 0, bytes, 0, z.size)
    z.fill(0)
    patches.add(Patch(dataStart, bytes))
    patches.add(Patch(len.at, z.size.toString().padEnd(len.digits, ' ').toByteArray(Charsets.ISO_8859_1)))
  }

  private fun adler32(b: ByteArray): Long {
    var s1 = 1L
    var s2 = 0L
    for (x in b) {
      s1 = (s1 + (x.toInt() and 0xFF)) % 65521
      s2 = (s2 + s1) % 65521
    }
    return (s2 shl 16) or s1
  }

  /** PNG predictor rows (one 8-bit colour, `columns` bytes a row) back to plain bytes; null if malformed. */
  fun unpredict(data: ByteArray, columns: Int): ByteArray? {
    val row = columns + 1
    if (data.size % row != 0) return null
    val rows = data.size / row
    val out = ByteArray(rows * columns)
    for (r in 0 until rows) {
      val f = data[r * row].toInt() and 0xFF
      for (x in 0 until columns) {
        val raw = data[r * row + 1 + x].toInt() and 0xFF
        val a = if (x > 0) out[r * columns + x - 1].toInt() and 0xFF else 0
        val b = if (r > 0) out[(r - 1) * columns + x].toInt() and 0xFF else 0
        val c = if (x > 0 && r > 0) out[(r - 1) * columns + x - 1].toInt() and 0xFF else 0
        val v = when (f) {
          0 -> raw
          1 -> raw + a
          2 -> raw + b
          3 -> raw + ((a + b) shr 1)
          4 -> {
            val pp = a + b - c
            val pa = Math.abs(pp - a)
            val pb = Math.abs(pp - b)
            val pc = Math.abs(pp - c)
            raw + (if (pa <= pb && pa <= pc) a else if (pb <= pc) b else c)
          }
          else -> { out.fill(0); return null }
        }
        out[r * columns + x] = v.toByte()
      }
    }
    return out
  }

  /** Plain bytes as PNG predictor rows, each with filter type 0 (none). */
  fun predictNone(plain: ByteArray, columns: Int): ByteArray {
    val rows = plain.size / columns
    val out = ByteArray(rows * (columns + 1))
    for (r in 0 until rows) System.arraycopy(plain, r * columns, out, r * (columns + 1) + 1, columns)
    return out
  }

  /** JPEG segments zeroed inside PDFs: APP1 (Exif, XMP), APP3–APP13 (IPTC…), APP15, comments. */
  private fun blankSegment(m: Int) = m == 0xE1 || (m in 0xE3..0xED) || m == 0xEF || m == 0xFE

  /** Zeroes the identifying segments of the JPEG at `at` (up to its image data), in place. */
  private fun jpegPatches(src: RandomSource, at: Long, patches: MutableList<Patch>) {
    if (at + 2 > src.size) return
    val soi = src.read(at, 2)
    if (soi[0] != 0xFF.toByte() || soi[1] != 0xD8.toByte()) return
    var p = at + 2
    while (p + 4 <= src.size) {
      val m = src.read(p, 4)
      if (m[0] != 0xFF.toByte()) return
      val marker = m[1].toInt() and 0xFF
      if (marker == 0xFF) { p++; continue }   // fill byte
      if (marker == 0xDA || marker == 0xD9) return   // image data (or the end): metadata comes before
      if (marker in 0xD0..0xD7 || marker == 0x01) { p += 2; continue }
      val len = ((m[2].toInt() and 0xFF) shl 8) or (m[3].toInt() and 0xFF)
      if (len < 2 || p + 2 + len > src.size) return
      if (blankSegment(marker)) CubeMediaClean.zeroPatches(patches, p + 4, (len - 2).toLong())
      p += 2 + len
    }
  }

  /** zlib (RFC 1950) decompression, up to STREAM_MAX bytes; null if the data is not valid zlib. */
  fun unzlib(data: ByteArray): ByteArray? {
    val inf = Inflater()
    try {
      inf.setInput(data)
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (!inf.finished()) {
        val n = inf.inflate(buf)
        if (n == 0 && (inf.needsInput() || inf.needsDictionary())) return null
        out.write(buf, 0, n)
        if (out.size() > STREAM_MAX) return null
      }
      buf.fill(0)
      return out.toByteArray()
    } catch (e: java.util.zip.DataFormatException) {
      return null
    } finally {
      inf.end()
    }
  }

  /** zlib (RFC 1950) compression at the highest level. */
  fun zlib(plain: ByteArray): ByteArray = compress(plain, Deflater(9))

  /** Raw DEFLATE (as zip stores it) at the highest level. */
  fun deflateRaw(plain: ByteArray): ByteArray = compress(plain, Deflater(9, true))

  private fun compress(plain: ByteArray, def: Deflater): ByteArray {
    try {
      def.setInput(plain)
      def.finish()
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (!def.finished()) out.write(buf, 0, def.deflate(buf))
      buf.fill(0)
      return out.toByteArray()
    } finally {
      def.end()
    }
  }

  /** A growable byte list, wiped when emptied. */
  internal class Bytes {
    private var a = ByteArray(256)
    var size = 0
      private set

    fun reserve(n: Int) {
      if (size + n <= a.size) return
      val next = a.copyOf(maxOf(size + n, a.size * 2))
      a.fill(0)
      a = next
    }
    fun add(c: Int) { reserve(1); a[size++] = c.toByte() }
    fun addAll(b: Bytes) { reserve(b.size); System.arraycopy(b.a, 0, a, size, b.size); size += b.size }
    fun addRange(b: ByteArray, from: Int, to: Int) { reserve(to - from); System.arraycopy(b, from, a, size, to - from); size += to - from }
    operator fun get(i: Int) = a[i].toInt() and 0xFF
    operator fun set(i: Int, v: Int) { a[i] = v.toByte() }
    fun removeLast() { size-- ; a[size] = 0 }
    fun clear() { a.fill(0, 0, size); size = 0 }
    fun wipe() { a.fill(0); size = 0 }
    fun take(): ByteArray = a.copyOf(size).also { clear() }
    fun latin1(from: Int, to: Int) = String(a, from, to - from, Charsets.ISO_8859_1)
    fun startsWithPrefixOf(open: ByteArray): Boolean {
      for (i in 0 until size) if (a[i] != open[i]) return false
      return true
    }
    fun endsWith(tail: ByteArray): Boolean {
      val at = size - tail.size
      for (i in tail.indices) if (a[at + i] != tail[i]) return false
      return true
    }
  }

  // ---- XML: Office, OpenDocument, EPUB, SVG --------------------------------------------------

  /**
   * Which parts of an XML document to empty (lib/docmeta.ts XmlRules). Names match a qualified name
   * exactly when they have a prefix ("dc:creator"), every name with that prefix when they end in
   * ":*" ("vt:*"), and the local part of any name otherwise ("author"). elems keep their tags and
   * lose their contents; attrs ("element@attribute", "...^prefix") keep name and quotes and lose
   * their value; comments: drop XML comments.
   */
  class XmlRules(val elems: List<String>, val attrs: List<String>, val comments: Boolean = false)

  private fun nameMatch(pattern: String, qname: String): Boolean {
    if (pattern.endsWith(":*")) return qname.startsWith(pattern.dropLast(1))
    if (pattern.contains(':')) return qname == pattern
    val c = qname.indexOf(':')
    return (if (c < 0) qname else qname.substring(c + 1)) == pattern
  }

  private fun attrMatch(pattern: String, elem: String, attr: String, b: ByteArray, from: Int, to: Int): Boolean {
    var p = pattern
    var prefix: String? = null
    val caret = p.indexOf('^')
    if (caret >= 0) {
      prefix = p.substring(caret + 1)
      p = p.substring(0, caret)
    }
    val at = p.indexOf('@')
    if (at >= 0) {
      if (!nameMatch(p.substring(0, at), elem)) return false
      p = p.substring(at + 1)
    }
    if (!nameMatch(p, attr)) return false
    if (prefix == null) return true
    if (to - from < prefix.length) return false
    for (i in prefix.indices) if ((b[from + i].toInt() and 0xFF) != prefix[i].code) return false
    return true
  }

  private fun isXmlSpace(c: Byte) = c == 0x20.toByte() || c == 0x0A.toByte() || c == 0x0D.toByte() || c == 0x09.toByte()

  private fun startsAt(b: ByteArray, at: Int, s: String): Boolean {
    if (b.size < at + s.length) return false
    for (i in s.indices) if ((b[at + i].toInt() and 0xFF) != s[i].code) return false
    return true
  }

  private fun indexOf(b: ByteArray, c: Byte, from: Int): Int {
    for (i in maxOf(from, 0) until b.size) if (b[i] == c) return i
    return -1
  }

  private fun find(b: ByteArray, sig: String, from: Int): Int {
    var i = maxOf(from, 0)
    while (i + sig.length <= b.size) {
      if (startsAt(b, i, sig)) return i
      i++
    }
    return -1
  }

  /**
   * lib/docmeta.ts cleanXml, byte for byte: empties the elements and attributes `rules` names (and
   * drops comments if asked), leaving every other byte as it was. A small scanner, not a parser:
   * tags, quoted values, comments, CDATA, processing instructions and DOCTYPE are recognised;
   * anything unterminated is copied as it is.
   */
  fun cleanXml(b: ByteArray, rules: XmlRules): ByteArray {
    val n = b.size
    var spans = IntArray(64)   // output: from, to, from, to… over b
    var count = 0
    fun push(from: Int, to: Int) {
      if (count + 2 > spans.size) spans = spans.copyOf(spans.size * 2)
      spans[count++] = from
      spans[count++] = to
    }
    var skip = 0   // > 0 inside an element being emptied: its depth
    fun copy(from: Int, to: Int) { if (skip == 0 && to > from) push(from, to) }
    fun until(seq: String, from: Int): Int {
      val e = find(b, seq, from)
      return if (e < 0) n else e + seq.length
    }
    var i = 0
    while (i < n) {
      val lt = indexOf(b, 0x3C, i)
      if (lt < 0) {
        copy(i, n)
        break
      }
      copy(i, lt)
      if (startsAt(b, lt, "<!--")) {
        val end = until("-->", lt + 4)
        if (!rules.comments) copy(lt, end)
        i = end
      } else if (startsAt(b, lt, "<![CDATA[")) {
        val end = until("]]>", lt + 9)
        copy(lt, end)
        i = end
      } else if (startsAt(b, lt, "<?")) {
        val end = until("?>", lt + 2)
        copy(lt, end)
        i = end
      } else if (startsAt(b, lt, "<!")) {   // DOCTYPE, with an internal subset in [ ]
        var k = lt + 2
        var depth = 0
        while (k < n) {
          val c = b[k]
          if (c == 0x5B.toByte()) depth++
          else if (c == 0x5D.toByte()) depth--
          else if (c == 0x3E.toByte() && depth <= 0) break
          k++
        }
        val end = if (k < n) k + 1 else n
        copy(lt, end)
        i = end
      } else if (lt + 1 < n && b[lt + 1] == 0x2F.toByte()) {   // end tag
        val gt = indexOf(b, 0x3E, lt)
        val end = if (gt < 0) n else gt + 1
        if (skip > 0) {
          skip--
          if (skip == 0) push(lt, end)
        } else copy(lt, end)
        i = end
      } else {   // start tag
        var k = lt + 1
        while (k < n && !isXmlSpace(b[k]) && b[k] != 0x2F.toByte() && b[k] != 0x3E.toByte()) k++
        val qname = String(b, lt + 1, k - lt - 1, Charsets.ISO_8859_1)
        val drop = ArrayList<Int>()   // value spans to empty: start, end, start, end…
        var end = -1
        while (k < n) {
          val c = b[k]
          if (c == 0x3E.toByte()) {
            end = k + 1
            break
          }
          if (isXmlSpace(c) || c == 0x2F.toByte()) {
            k++
            continue
          }
          val ns = k
          while (k < n && !isXmlSpace(b[k]) && b[k] != 0x3D.toByte() && b[k] != 0x3E.toByte() && b[k] != 0x2F.toByte()) k++
          if (k == ns) k++   // a stray '=': step over it
          val aname = String(b, ns, k - ns, Charsets.ISO_8859_1)
          while (k < n && isXmlSpace(b[k])) k++
          if (k >= n || b[k] != 0x3D.toByte()) continue
          k++
          while (k < n && isXmlSpace(b[k])) k++
          if (k >= n) continue
          val q = b[k]
          if (q != 0x22.toByte() && q != 0x27.toByte()) continue
          val ve = indexOf(b, q, k + 1)
          if (ve < 0) {
            k = n
            break
          }
          val vs = k + 1
          if (skip == 0 && rules.attrs.any { attrMatch(it, qname, aname, b, vs, ve) }) { drop.add(vs); drop.add(ve) }
          k = ve + 1
        }
        if (end < 0) {   // unterminated: the rest as it is
          copy(lt, n)
          break
        }
        val selfClosing = b[end - 2] == 0x2F.toByte()
        if (skip > 0) {
          if (!selfClosing) skip++
        } else {
          var from = lt
          for (d in 0 until drop.size step 2) {
            push(from, drop[d])
            from = drop[d + 1]
          }
          push(from, end)
          if (!selfClosing && rules.elems.any { nameMatch(it, qname) }) skip = 1
        }
        i = end
      }
    }
    var total = 0
    for (s in 0 until count step 2) total += spans[s + 1] - spans[s]
    val out = ByteArray(total)
    var at = 0
    for (s in 0 until count step 2) {
      System.arraycopy(b, spans[s], out, at, spans[s + 1] - spans[s])
      at += spans[s + 1] - spans[s]
    }
    return out
  }

  /** OOXML attributes naming people: comment and tracked-change authors, co-authors, shared users. */
  private val OOXML_ATTRS = listOf(
    "w:author", "w:initials", "w15:author", "presenceInfo@providerId", "presenceInfo@userId",
    "person@displayName", "person@userId", "person@providerId", "cmAuthor@name", "cmAuthor@initials",
    "author@name", "author@initials", "author@userId", "author@providerId", "header@userName",
    "fileSharing@userName", "userInfo@name", "absPath@url",
  )
  private val CORE_TAGS = listOf("dc:creator", "cp:lastModifiedBy", "dc:title", "dc:subject", "cp:keywords", "dc:description", "cp:category")
  private val ODF_META = listOf(
    "dc:creator", "meta:initial-creator", "dc:title", "dc:subject", "dc:description", "meta:keyword",
    "meta:user-defined", "meta:printed-by", "meta:generator",
  )
  val SVG_RULES = XmlRules(
    listOf("metadata", "i:pgf"),
    listOf("sodipodi:docname", "sodipodi:docbase", "sodipodi:version", "inkscape:export-filename", "inkscape:version"),
    comments = true,
  )

  /** A zip document's family: Office Open XML, OpenDocument or EPUB. */
  enum class ZipFormat { OOXML, ODF, EPUB }

  /** Which family a zip belongs to, from its part names and its "mimetype" part; null: none. */
  fun zipFormat(names: Collection<String>, mimetype: ByteArray?): ZipFormat? {
    if ("[Content_Types].xml" in names) return ZipFormat.OOXML
    if (mimetype != null && startsAt(mimetype, 0, "application/vnd.oasis.opendocument.")) return ZipFormat.ODF
    if (mimetype != null && startsAt(mimetype, 0, "application/epub+zip")) return ZipFormat.EPUB
    return null
  }

  /** The rules for one part of a zip document, or null to copy it as it is. */
  fun xmlRules(format: ZipFormat, name: String): XmlRules? = when (format) {
    ZipFormat.OOXML -> when {
      name == "docProps/core.xml" -> XmlRules(CORE_TAGS, emptyList())
      name == "docProps/app.xml" -> XmlRules(listOf("Company", "Manager"), emptyList())
      name == "docProps/custom.xml" -> XmlRules(listOf("vt:*"), emptyList())
      name.endsWith(".rels") -> XmlRules(emptyList(), listOf("Relationship@Target^file:"))
      name.endsWith(".xml") && name != "[Content_Types].xml" -> XmlRules(listOf("author"), OOXML_ATTRS)
      else -> null
    }
    ZipFormat.ODF -> when (name) {
      "meta.xml" -> XmlRules(ODF_META, listOf("template@href", "template@title"))
      "content.xml", "styles.xml" -> XmlRules(listOf("dc:creator", "meta:creator-initials"), emptyList())
      else -> null
    }
    ZipFormat.EPUB -> if (name.endsWith(".opf")) XmlRules(listOf("dc:creator", "dc:contributor", "dc:publisher"), emptyList()) else null
  }

  /** Photos inside zip documents: cleaned like photos added on their own (CubeStrip). */
  private val ZIP_IMAGE = Regex("\\.(jpe?g|png|heic|heif|webp|tiff?|gif)\\z", RegexOption.IGNORE_CASE)
  /** Parts larger than this (uncompressed) are copied as they are. */
  const val PART_MAX = 32 * 1024 * 1024

  // ---- RTF -----------------------------------------------------------------------------------

  /** Groups dropped whole: \info fields naming people, revision and comment authors, the generator. */
  private val RTF_DROP = setOf(
    "author", "operator", "title", "subject", "keywords", "doccomm", "comment", "company", "manager",
    "category", "hlinkbase", "userprops", "revtbl", "atnauthor", "atnid", "generator",
  )

  /**
   * lib/docmeta.ts RtfCleaner, byte for byte, whatever the piece sizes: drops the groups in
   * RTF_DROP ({\author …}, {\*\company …}, …) as the file streams through; everything else passes
   * unchanged. Binary data (\binN) is passed over unread.
   */
  class RtfCleaner {
    private enum class Mode { NORMAL, GROUP, CTRL, SKIP, BIN }

    private var mode = Mode.NORMAL
    private val held = Bytes()
    private var depth = 0
    private var escape = false
    private var bin = 0L
    private val out = Bytes()

    /** Feeds bytes in; returns the bytes that are final so far. */
    fun push(input: ByteArray, off: Int = 0, len: Int = input.size): ByteArray {
      out.reserve(len)
      var i = off
      val end = off + len
      while (i < end) {
        if (mode == Mode.BIN) {   // binary data: passed over in one go
          val k = minOf(bin, (end - i).toLong()).toInt()
          out.addRange(input, i, i + k)
          bin -= k
          i += k
          if (bin == 0L) mode = Mode.NORMAL
          continue
        }
        step(input[i].toInt() and 0xFF)
        i++
      }
      return out.take()
    }

    /** Ends the stream: a group start or control word still held passes through as it is. */
    fun finish(): ByteArray {
      if (mode == Mode.GROUP || mode == Mode.CTRL) out.addAll(held)
      held.wipe()
      mode = Mode.NORMAL
      return out.take()
    }

    private fun isLetter(c: Int) = (c in 0x41..0x5A) || (c in 0x61..0x7A)
    private fun isDigit(c: Int) = c in 0x30..0x39

    private fun step(c: Int) {
      when (mode) {
        Mode.SKIP -> {
          if (escape) escape = false
          else if (c == 0x5C) escape = true
          else if (c == 0x7B) depth++
          else if (c == 0x7D && --depth == 0) mode = Mode.NORMAL
        }
        Mode.GROUP -> {   // after "{": a destination worth dropping?
          held.add(c)
          val n = held.size
          // held[0] = '{'; then '\' word, or '\' '*' '\' word
          val star = n >= 3 && held[2] == 0x2A
          val wordAt = if (star) 4 else 2
          if (n == 2) {
            if (c != 0x5C) release()
            return
          }
          if (n == 3) {
            if (c == 0x2A || isLetter(c)) return
            flush()   // an escaped symbol such as \{ or \'
            return
          }
          if (star && n == 4) {
            if (c != 0x5C) release()
            return
          }
          if (isLetter(c) && n - wordAt <= 32) return
          val name = if (n - 1 > wordAt) held.latin1(wordAt, n - 1) else ""
          if (name.isNotEmpty() && name in RTF_DROP) {
            held.clear()
            mode = Mode.SKIP
            depth = 1
            escape = false
            step(c)
            return
          }
          // kept: "{" (and "\*") out, the control word goes on as one outside a group start, so
          // {\binN is passed over like \binN
          for (x in 0 until wordAt - 1) out.add(held[x])
          val word = ByteArray(n - wordAt) { held[wordAt - 1 + it].toByte() }
          held.clear()
          held.addRange(word, 0, word.size)
          word.fill(0)
          mode = Mode.CTRL
          step(c)
        }
        Mode.CTRL -> {   // after "\" outside a group start: only \binN matters
          held.add(c)
          val n = held.size
          if (n == 2) {
            if (!isLetter(c)) flush()
            return
          }
          val prev = held[n - 2]
          val more = if (isLetter(c)) isLetter(prev)
            else if (isDigit(c)) isLetter(prev) || isDigit(prev) || prev == 0x2D
            else c == 0x2D && isLetter(prev)
          if (more && n <= 48) return
          val count = binCount(n - 1)
          if (count > 0) {
            for (x in 0 until n - 1) out.add(held[x])
            held.clear()
            bin = count
            mode = Mode.BIN
            out.add(c)
            // a space ends the control word; any other byte is already the first byte of the data
            if (c != 0x20 && --bin == 0L) mode = Mode.NORMAL
            return
          }
          release()
        }
        else -> when (c) {
          0x7B -> { mode = Mode.GROUP; held.clear(); held.add(c) }
          0x5C -> { mode = Mode.CTRL; held.clear(); held.add(c) }
          else -> out.add(c)
        }
      }
    }

    /** N if the first `n` held bytes are exactly "\binN" (N saturating), else 0. */
    private fun binCount(n: Int): Long {
      if (n < 5 || held[1] != 0x62 || held[2] != 0x69 || held[3] != 0x6E) return 0
      var v = 0L
      for (x in 4 until n) {
        val d = held[x]
        if (!isDigit(d)) return 0
        v = if (v > (Long.MAX_VALUE - 9) / 10) Long.MAX_VALUE else v * 10 + (d - 0x30)
      }
      return v
    }

    /** Emits all held bytes but the last, which is looked at again in normal mode. */
    private fun release() {
      val last = held[held.size - 1]
      held.removeLast()
      out.addAll(held)
      held.clear()
      mode = Mode.NORMAL
      step(last)
    }

    /** Emits every held byte (an escaped symbol is complete). */
    private fun flush() {
      out.addAll(held)
      held.clear()
      mode = Mode.NORMAL
    }
  }

  // ---- Zip documents -------------------------------------------------------------------------

  /** Somewhere bytes can be read at any offset: a picked file, or a file held in memory. */
  interface RandomSource {
    val size: Long
    fun read(at: Long, count: Int): ByteArray
  }

  class Malformed : Exception("not a zip Cube can rewrite")

  class ChannelSource(private val channel: FileChannel) : RandomSource {
    override val size: Long = channel.size()
    override fun read(at: Long, count: Int): ByteArray {
      if (at < 0 || count < 0 || at + count > size) throw Malformed()
      val buf = ByteBuffer.allocate(count)
      var pos = at
      while (buf.hasRemaining()) {
        val n = channel.read(buf, pos)
        if (n <= 0) throw Malformed()
        pos += n
      }
      return buf.array()
    }
  }

  class ArraySource(private val bytes: ByteArray) : RandomSource {
    override val size: Long = bytes.size.toLong()
    override fun read(at: Long, count: Int): ByteArray {
      if (at < 0 || count < 0 || at + count > size) throw Malformed()
      return bytes.copyOfRange(at.toInt(), at.toInt() + count)
    }
  }

  private class Entry(
    val madeBy: Int, val needed: Int, val flags: Int, val method: Int, val time: Int, val date: Int,
    val crc: Long, val csize: Long, val usize: Long, val internalAttr: Int, val externalAttr: Long,
    val localOffset: Long, val name: ByteArray, val index: Int,
  ) {
    val text = String(name, Charsets.UTF_8)
    var dataStart = 0L
  }

  private class Plan(val entries: List<Entry>, val format: ZipFormat)

  private const val MAX32 = 0xFFFFFFFFL

  /**
   * Writes the cleaned zip document (Office, OpenDocument or EPUB) through `emit` and returns true;
   * or returns false, having emitted nothing, when the file should be stored as it is (not a
   * document, encrypted, malformed, or too large for a plain zip). Every detected document is
   * rewritten, entry by entry in their order in the file, one entry in memory at a time: XML parts
   * with rules (xmlRules) and photos (CubeStrip) up to PART_MAX are cleaned and, when that changes
   * them, written deflated (XML, unless that is not smaller) or stored (photos); every other entry,
   * and any part that cannot be read (bad CRC, inflate error), is copied raw, still compressed. The
   * central directory keeps the input's order. The output is never zip64, and has no extra fields.
   */
  fun cleanOffice(src: RandomSource, emit: (ByteArray) -> Unit): Boolean {
    val plan = try {
      planOffice(src)
    } catch (e: Exception) {
      return false
    } ?: return false

    var offset = 0L
    val records = arrayOfNulls<ByteArray>(plan.entries.size)   // central directory, in the input's order
    for (e in plan.entries) {
      var replacement: ByteArray? = null
      var method = e.method
      var crc = e.crc
      var usize = e.usize
      val photo = ZIP_IMAGE.containsMatchIn(e.text)
      val rules = if (photo) null else xmlRules(plan.format, e.text)
      if ((photo || rules != null) && e.usize <= PART_MAX && e.csize <= PART_MAX + (1L shl 20) && (e.method == 0 || e.method == 8)) {
        try {
          val data = src.read(e.dataStart, e.csize.toInt())
          val raw = if (e.method == 0) data else try { inflate(data, e.usize.toInt()) } finally { data.fill(0) }
          try {
            if (raw.size.toLong() == e.usize && CRC32().apply { update(raw) }.value == e.crc) {
              val clean = if (photo) CubeStrip.strip(raw) else cleanXml(raw, rules!!)
              if (clean.contentEquals(raw)) clean.fill(0)
              else {
                crc = CRC32().apply { update(clean) }.value
                usize = clean.size.toLong()
                if (photo) {
                  replacement = clean
                  method = 0
                } else {
                  val z = deflateRaw(clean)
                  if (z.size < clean.size) {
                    replacement = z
                    method = 8
                    clean.fill(0)
                  } else {
                    replacement = clean
                    method = 0
                    z.fill(0)
                  }
                }
              }
            }
          } finally {
            raw.fill(0)
          }
        } catch (ex: Exception) {
          replacement?.fill(0)
          replacement = null
        }
        // never larger than planned (the 32-bit check in planOffice counts on it)
        if (replacement != null && replacement.size > maxOf(e.csize, e.usize)) {
          replacement.fill(0)
          replacement = null
        }
        if (replacement == null) {
          method = e.method
          crc = e.crc
          usize = e.usize
        }
      }
      val csize = replacement?.size?.toLong() ?: e.csize
      var flags = e.flags and 0x0008.inv()   // sizes are in the header: no data descriptor
      if (replacement != null) flags = flags and 0x0006.inv()
      val needed = if (e.needed == 45) 20 else e.needed   // 4.5 is zip64, which the output never is
      val local = ByteArrayOutputStream()
      put32(local, 0x04034B50); put16(local, needed); put16(local, flags); put16(local, method)
      put16(local, e.time); put16(local, e.date); put32(local, crc); put32(local, csize); put32(local, usize)
      put16(local, e.name.size); put16(local, 0)
      local.write(e.name)
      val localBytes = local.toByteArray()
      emit(localBytes)
      if (replacement != null) {
        emit(replacement)
        replacement.fill(0)
      } else {
        var at = 0L
        while (at < e.csize) {
          val n = minOf(1L shl 20, e.csize - at).toInt()
          val part = src.read(e.dataStart + at, n)
          emit(part)
          part.fill(0)
          at += n
        }
      }
      val central = ByteArrayOutputStream()
      put32(central, 0x02014B50); put16(central, e.madeBy); put16(central, needed); put16(central, flags)
      put16(central, method); put16(central, e.time); put16(central, e.date); put32(central, crc)
      put32(central, csize); put32(central, usize); put16(central, e.name.size)
      put16(central, 0); put16(central, 0); put16(central, 0); put16(central, e.internalAttr)
      put32(central, e.externalAttr); put32(central, offset)
      central.write(e.name)
      records[e.index] = central.toByteArray()
      offset += localBytes.size + csize
    }
    val cdOut = ByteArrayOutputStream()
    for (r in records) cdOut.write(r!!)
    val cd = cdOut.toByteArray()
    val end = ByteArrayOutputStream()
    put32(end, 0x06054B50); put16(end, 0); put16(end, 0)
    put16(end, plan.entries.size); put16(end, plan.entries.size)
    put32(end, cd.size.toLong()); put32(end, offset); put16(end, 0)
    emit(cd)
    emit(end.toByteArray())
    return true
  }

  /** Reads the central directory (zip64 too); null when this is not a document zip. Throws when malformed. */
  private fun planOffice(src: RandomSource): Plan? {
    val size = src.size
    if (size < 22) throw Malformed()
    val tailLen = minOf(size, 0xFFFFL + 22).toInt()
    val tail = src.read(size - tailLen, tailLen)
    var eocd = -1
    var i = tailLen - 22
    while (i >= 0) {
      if (tail[i] == 0x50.toByte() && tail[i + 1] == 0x4B.toByte() && tail[i + 2] == 0x05.toByte() && tail[i + 3] == 0x06.toByte()) {
        eocd = i
        break
      }
      i--
    }
    if (eocd < 0) throw Malformed()
    val eocdPos = size - tailLen + eocd
    var count = u16(tail, eocd + 10).toLong()
    var cdSize = u32(tail, eocd + 12)
    var cdOffset = u32(tail, eocd + 16)
    val cdLimit: Long   // where the central directory must end
    if (eocdPos >= 20 && u32(src.read(eocdPos - 20, 4), 0) == 0x07064B50L) {
      // zip64: the end-of-central-directory locator points at the zip64 record
      val loc = src.read(eocdPos - 20, 20)
      val recAt = u64(loc, 8)
      if (u32(loc, 4) != 0L || u32(loc, 16) > 1 || recAt < 0 || recAt + 56 > eocdPos - 20) throw Malformed()
      val rec = src.read(recAt, 56)
      if (u32(rec, 0) != 0x06064B50L || u32(rec, 16) != 0L || u32(rec, 20) != 0L || u64(rec, 24) != u64(rec, 32)) throw Malformed()
      count = u64(rec, 32)
      cdSize = u64(rec, 40)
      cdOffset = u64(rec, 48)
      cdLimit = recAt
    } else {
      if (u16(tail, eocd + 4) != 0 || u16(tail, eocd + 6) != 0 || u16(tail, eocd + 8).toLong() != count ||
        count == 0xFFFFL || cdSize == MAX32 || cdOffset == MAX32) throw Malformed()
      cdLimit = eocdPos
    }
    if (count <= 0 || count >= 0xFFFF || cdSize < 0 || cdOffset < 0 || cdOffset + cdSize > cdLimit || cdSize > Int.MAX_VALUE) throw Malformed()
    val cd = src.read(cdOffset, cdSize.toInt())
    val entries = ArrayList<Entry>()
    var p = 0
    repeat(count.toInt()) {
      if (p + 46 > cd.size || u32(cd, p) != 0x02014B50L) throw Malformed()
      val nameLen = u16(cd, p + 28)
      val extraLen = u16(cd, p + 30)
      val commentLen = u16(cd, p + 32)
      if (p + 46 + nameLen + extraLen > cd.size) throw Malformed()
      var csize = u32(cd, p + 20)
      var usize = u32(cd, p + 24)
      var localOffset = u32(cd, p + 42)
      if (usize == MAX32 || csize == MAX32 || localOffset == MAX32) {
        // the zip64 extra field: usize, csize, offset, each only when its 32-bit field is 0xFFFFFFFF
        var x = p + 46 + nameLen
        val xEnd = x + extraLen
        var found = false
        while (x + 4 <= xEnd) {
          val id = u16(cd, x)
          val len = u16(cd, x + 2)
          if (x + 4 + len > xEnd) break
          if (id == 1) {
            var q = x + 4
            val qEnd = q + len
            fun next(): Long {
              if (q + 8 > qEnd) throw Malformed()
              return u64(cd, q).also { q += 8 }
            }
            if (usize == MAX32) usize = next()
            if (csize == MAX32) csize = next()
            if (localOffset == MAX32) localOffset = next()
            found = true
            break
          }
          x += 4 + len
        }
        if (!found) throw Malformed()
      }
      val e = Entry(
        u16(cd, p + 4), u16(cd, p + 6), u16(cd, p + 8), u16(cd, p + 10), u16(cd, p + 12), u16(cd, p + 14),
        u32(cd, p + 16), csize, usize, u16(cd, p + 36), u32(cd, p + 38), localOffset,
        cd.copyOfRange(p + 46, p + 46 + nameLen), entries.size,
      )
      if (e.flags and 1 != 0) throw Malformed()   // encrypted
      if (csize < 0 || usize < 0 || localOffset < 0 || localOffset + 30 > cdOffset) throw Malformed()
      entries.add(e)
      p += 46 + nameLen + extraLen + commentLen
    }
    for (e in entries) {
      val head = src.read(e.localOffset, 30)
      if (u32(head, 0) != 0x04034B50L) throw Malformed()
      e.dataStart = e.localOffset + 30 + u16(head, 26) + u16(head, 28)
      if (e.dataStart + e.csize > cdOffset) throw Malformed()
    }
    val mime = entries.firstOrNull { it.text == "mimetype" }?.let { m ->
      runCatching {
        if (m.usize > PART_MAX || m.csize > PART_MAX) null
        else {
          val data = src.read(m.dataStart, m.csize.toInt())
          when (m.method) {
            0 -> data
            8 -> inflate(data, m.usize.toInt())
            else -> null
          }
        }
      }.getOrNull()
    }
    val format = zipFormat(entries.map { it.text }, mime) ?: return null
    // the output is a plain zip: everything must fit 32 bits (cleaned parts never grow past max(csize, usize))
    var total = 22L
    for (e in entries) total += 30 + e.name.size + maxOf(e.csize, e.usize) + 46 + e.name.size
    if (total >= MAX32) return null
    return Plan(entries.sortedBy { it.localOffset }, format)
  }

  /** Raw DEFLATE (as zip stores it) of exactly `size` bytes. */
  fun inflate(data: ByteArray, size: Int): ByteArray {
    if (size == 0) return ByteArray(0)
    val inf = Inflater(true)
    try {
      inf.setInput(data.copyOf(data.size + 1))   // nowrap needs one extra byte at the end
      val out = ByteArray(size + 1)
      var n = 0
      while (!inf.finished() && n < out.size) {
        val got = inf.inflate(out, n, out.size - n)
        if (got == 0 && (inf.needsInput() || inf.needsDictionary())) break
        n += got
      }
      if (n != size || !inf.finished()) {
        out.fill(0)
        throw Malformed()
      }
      return out.copyOf(size).also { out.fill(0) }
    } finally {
      inf.end()
    }
  }

  private fun u16(b: ByteArray, i: Int) = (b[i].toInt() and 0xFF) or ((b[i + 1].toInt() and 0xFF) shl 8)
  private fun u32(b: ByteArray, i: Int) = (u16(b, i).toLong()) or (u16(b, i + 2).toLong() shl 16)
  private fun u64(b: ByteArray, i: Int) = u32(b, i) or (u32(b, i + 4) shl 32)   // negative if the top bit is set
  private fun put16(o: ByteArrayOutputStream, v: Int) { o.write(v and 0xFF); o.write((v ushr 8) and 0xFF) }
  private fun put32(o: ByteArrayOutputStream, v: Long) { for (k in 0 until 4) o.write(((v ushr (8 * k)) and 0xFF).toInt()) }
}
