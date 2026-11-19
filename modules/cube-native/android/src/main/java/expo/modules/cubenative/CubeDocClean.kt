package expo.modules.cubenative

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.zip.CRC32
import java.util.zip.Inflater

/**
 * Removes author and organisation details from documents while they stream in (runImport). Plain
 * JVM only, so the unit tests run it against vectors from JavaScript (tests/native).
 *
 * - PDF: PdfCleaner, a port of the machine in lib/docmeta.ts (byte for byte the same output):
 *   document-information strings and XMP packets are blanked in place.
 * - Office: the zip is read in place (central directory first, then each entry's data where it is)
 *   and written out again with docProps/core.xml, app.xml and custom.xml values emptied, the same
 *   fields lib/docmeta.ts empties. Every other entry is copied byte for byte, still compressed.
 *   Anything unusual (zip64, encryption, not an Office file, nothing to change) leaves the file as
 *   it was picked. The same as ios/CubeDocClean.swift.
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

  /** Bytes to put at an offset, replacing as many: the file keeps its length. */
  class Patch(val at: Long, val bytes: ByteArray)
  const val STREAM_MAX = 16 * 1024 * 1024

  private val TYPE_RE = Regex("""/Type\s*/(ObjStm|Metadata)(?![A-Za-z0-9])""")
  private val FILTER_RE = Regex("""/Filter\s*(/FlateDecode|\[\s*/FlateDecode\s*])""")
  private val LENGTH_RE = Regex("""/Length\s+(\d+)(?!\s*\d*\s+R)(?![0-9])""")

  /**
   * The same streams and patches as lib/docmeta.ts pdfStreamPatches: Flate-compressed object streams
   * (/Type /ObjStm) and XMP streams (/Type /Metadata) whose contents PdfCleaner changes are
   * decompressed, cleaned, recompressed and written back at the same offset, padded with newlines,
   * with the /Length number rewritten (spaces after it). Anything unusual is left alone.
   */
  fun pdfStreamPatches(src: RandomSource): List<Patch> {
    val patches = ArrayList<Patch>()
    val step = 1 shl 20
    val kw = "stream".toByteArray()
    var start = 0L
    while (start < src.size) {
      val win = try { src.read(start, minOf(step.toLong() + kw.size, src.size - start).toInt()) } catch (e: Exception) { break }
      var i = 0
      while (i < minOf(step, win.size) && i + kw.size <= win.size) {
        if (win[i] == 0x73.toByte() && (1 until kw.size).all { win[i + it] == kw[it] }) {
          runCatching { streamPatch(src, start + i, patches) }
        }
        i++
      }
      start += step
    }
    return patches
  }

  private fun streamPatch(src: RandomSource, p: Long, patches: MutableList<Patch>) {
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
    if (!TYPE_RE.containsMatchIn(dict) || !FILTER_RE.containsMatchIn(dict) || dict.contains("/DecodeParms")) return
    val len = LENGTH_RE.find(dict) ?: return
    val digits = len.groups[1]!!
    val l = digits.value.toLongOrNull() ?: return
    if (l > STREAM_MAX || dataStart + l > src.size) return
    val data = src.read(dataStart, l.toInt())
    if (data.size < 2 || (data[0].toInt() and 0x0F) != 8 || (((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)) % 31 != 0) return
    val plain = unzlib(data) ?: return
    val c = PdfCleaner()
    val clean = c.push(plain) + c.finish()
    try {
      if (clean.contentEquals(plain)) return
      val z = zlib(clean)
      if (z.size > l) return
      val bytes = ByteArray(l.toInt()) { 0x0A.toByte() }
      System.arraycopy(z, 0, bytes, 0, z.size)
      patches.add(Patch(dataStart, bytes))
      val newDigits = z.size.toString().padEnd(digits.value.length, ' ').toByteArray(Charsets.ISO_8859_1)
      patches.add(Patch(p - back + open + digits.range.first, newDigits))
    } finally {
      plain.fill(0)
      clean.fill(0)
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
  fun zlib(plain: ByteArray): ByteArray {
    val def = java.util.zip.Deflater(9)
    try {
      def.setInput(plain)
      def.finish()
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (!def.finished()) out.write(buf, 0, def.deflate(buf))
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
    operator fun get(i: Int) = a[i].toInt() and 0xFF
    operator fun set(i: Int, v: Int) { a[i] = v.toByte() }
    fun removeLast() { size-- ; a[size] = 0 }
    fun clear() { a.fill(0, 0, size); size = 0 }
    fun wipe() { a.fill(0); size = 0 }
    fun take(): ByteArray = a.copyOf(size).also { clear() }
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

  // ---- Office --------------------------------------------------------------------------------

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
    val madeBy: Int, val needed: Int, var flags: Int, var method: Int, val time: Int, val date: Int,
    var crc: Long, var csize: Long, var usize: Long, val internalAttr: Int, val externalAttr: Long,
    val localOffset: Long, val name: ByteArray,
  )

  private val CORE_TAGS = listOf("dc:creator", "cp:lastModifiedBy", "dc:title", "dc:subject", "cp:keywords", "dc:description", "cp:category")
  private val APP_TAGS = listOf("Company", "Manager")
  private const val PROPS_MAX = 16 * 1024 * 1024

  /** The cleaned docProps part, or null if it does not change. */
  fun cleanProps(name: String, xml: String): String? {
    var out = xml
    fun empty(pattern: String) { out = Regex(pattern).replace(out, "$1$2") }
    when (name) {
      "docProps/core.xml" -> CORE_TAGS.forEach { empty("(<$it(?:\\s[^>]*)?>)[\\s\\S]*?(</$it>)") }
      "docProps/app.xml" -> APP_TAGS.forEach { empty("(<$it(?:\\s[^>]*)?>)[\\s\\S]*?(</$it>)") }
      "docProps/custom.xml" -> empty("(<vt:[A-Za-z0-9]+(?:\\s[^>]*)?>)[\\s\\S]*?(</vt:[A-Za-z0-9]+>)")
      else -> return null
    }
    return if (out == xml) null else out
  }

  /**
   * Writes the cleaned Office file through `emit` and returns true; or returns false, having emitted
   * nothing, when the file should be stored as it is.
   */
  fun cleanOffice(src: RandomSource, emit: (ByteArray) -> Unit): Boolean {
    val (entries, changed) = try {
      planOffice(src)
    } catch (e: Exception) {
      return false
    }
    if (changed.isEmpty()) return false

    var offset = 0L
    val central = ByteArrayOutputStream()
    for (e in entries.sortedBy { it.localOffset }) {
      val head = src.read(e.localOffset, 30)
      val dataStart = e.localOffset + 30 + u16(head, 26) + u16(head, 28)
      val replacement = changed[String(e.name, Charsets.UTF_8)]
      val oldSize = e.csize
      if (replacement != null) {
        e.method = 0
        e.flags = e.flags and 0x0006.inv()
        e.crc = CRC32().apply { update(replacement) }.value
        e.csize = replacement.size.toLong()
        e.usize = replacement.size.toLong()
      }
      e.flags = e.flags and 0x0008.inv()
      val local = ByteArrayOutputStream()
      put32(local, 0x04034B50); put16(local, e.needed); put16(local, e.flags); put16(local, e.method)
      put16(local, e.time); put16(local, e.date); put32(local, e.crc); put32(local, e.csize); put32(local, e.usize)
      put16(local, e.name.size); put16(local, 0)
      local.write(e.name)
      val localBytes = local.toByteArray()
      emit(localBytes)
      if (replacement != null) {
        emit(replacement)
      } else {
        var at = 0L
        while (at < oldSize) {
          val n = minOf(1L shl 20, oldSize - at).toInt()
          val part = src.read(dataStart + at, n)
          emit(part)
          part.fill(0)
          at += n
        }
      }
      put32(central, 0x02014B50); put16(central, e.madeBy); put16(central, e.needed); put16(central, e.flags)
      put16(central, e.method); put16(central, e.time); put16(central, e.date); put32(central, e.crc)
      put32(central, e.csize); put32(central, e.usize); put16(central, e.name.size)
      put16(central, 0); put16(central, 0); put16(central, 0); put16(central, e.internalAttr)
      put32(central, e.externalAttr); put32(central, offset)
      central.write(e.name)
      offset += localBytes.size + e.csize
      if (offset >= 0xFFFFFFFFL) throw Malformed()
    }
    val cd = central.toByteArray()
    val end = ByteArrayOutputStream()
    put32(end, 0x06054B50); put16(end, 0); put16(end, 0)
    put16(end, entries.size); put16(end, entries.size)
    put32(end, cd.size.toLong()); put32(end, offset); put16(end, 0)
    emit(cd)
    emit(end.toByteArray())
    return true
  }

  private fun planOffice(src: RandomSource): Pair<List<Entry>, Map<String, ByteArray>> {
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
    val count = u16(tail, eocd + 10)
    val cdSize = u32(tail, eocd + 12)
    val cdOffset = u32(tail, eocd + 16)
    if (u16(tail, eocd + 4) != 0 || u16(tail, eocd + 6) != 0 || u16(tail, eocd + 8) != count ||
      count == 0 || count == 0xFFFF || cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL ||
      cdOffset + cdSize > eocdPos) throw Malformed()
    if (eocdPos >= 20 && src.read(eocdPos - 20, 4).contentEquals(byteArrayOf(0x50, 0x4B, 0x06, 0x07))) throw Malformed()
    if (cdSize > Int.MAX_VALUE) throw Malformed()
    val cd = src.read(cdOffset, cdSize.toInt())
    val entries = ArrayList<Entry>()
    var p = 0
    repeat(count) {
      if (p + 46 > cd.size || u32(cd, p) != 0x02014B50L) throw Malformed()
      val nameLen = u16(cd, p + 28)
      val extraLen = u16(cd, p + 30)
      val commentLen = u16(cd, p + 32)
      if (p + 46 + nameLen > cd.size) throw Malformed()
      val e = Entry(
        u16(cd, p + 4), u16(cd, p + 6), u16(cd, p + 8), u16(cd, p + 10), u16(cd, p + 12), u16(cd, p + 14),
        u32(cd, p + 16), u32(cd, p + 20), u32(cd, p + 24), u16(cd, p + 36), u32(cd, p + 38), u32(cd, p + 42),
        cd.copyOfRange(p + 46, p + 46 + nameLen),
      )
      if (e.flags and 1 != 0 || e.csize == 0xFFFFFFFFL || e.usize == 0xFFFFFFFFL || e.localOffset == 0xFFFFFFFFL ||
        e.localOffset + 30 > cdOffset) throw Malformed()
      entries.add(e)
      p += 46 + nameLen + extraLen + commentLen
    }
    val names = entries.map { String(it.name, Charsets.UTF_8) }
    if ("[Content_Types].xml" !in names) throw Malformed()
    val changed = HashMap<String, ByteArray>()
    for ((k, e) in entries.withIndex()) {
      if (names[k] !in setOf("docProps/core.xml", "docProps/app.xml", "docProps/custom.xml")) continue
      if (e.usize > PROPS_MAX || e.csize > PROPS_MAX) throw Malformed()
      val head = src.read(e.localOffset, 30)
      if (u32(head, 0) != 0x04034B50L) throw Malformed()
      val dataStart = e.localOffset + 30 + u16(head, 26) + u16(head, 28)
      val data = src.read(dataStart, e.csize.toInt())
      val raw = when (e.method) {
        0 -> data
        8 -> inflate(data, e.usize.toInt())
        else -> throw Malformed()
      }
      if (CRC32().apply { update(raw) }.value != e.crc) throw Malformed()
      val xml = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(raw)).toString()   // throws on bad UTF-8
      cleanProps(names[k], xml)?.let { changed[names[k]] = it.toByteArray(Charsets.UTF_8) }
    }
    return entries to changed
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
      if (n != size || !inf.finished()) throw Malformed()
      return out.copyOf(size)
    } finally {
      inf.end()
    }
  }

  private fun u16(b: ByteArray, i: Int) = (b[i].toInt() and 0xFF) or ((b[i + 1].toInt() and 0xFF) shl 8)
  private fun u32(b: ByteArray, i: Int) = (u16(b, i).toLong()) or (u16(b, i + 2).toLong() shl 16)
  private fun put16(o: ByteArrayOutputStream, v: Int) { o.write(v and 0xFF); o.write((v ushr 8) and 0xFF) }
  private fun put32(o: ByteArrayOutputStream, v: Long) { for (k in 0 until 4) o.write(((v ushr (8 * k)) and 0xFF).toInt()) }
}
