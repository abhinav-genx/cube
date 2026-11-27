package expo.modules.cubenative

import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Checks CubeCrypto against blobs written by lib/vault.ts, through both the platform cipher and the
 * pure-Kotlin one (Android 7-8), and the metadata cleaners against lib/strip.ts, lib/docmeta.ts and
 * lib/mediameta.ts: CubeStrip, PdfCleaner, RtfCleaner, XmlCleaner (in pieces), compound-file
 * patches and CubeMediaClean byte for byte;
 * zip documents and whole PDFs are written out for JavaScript to check. Generate the vectors, then run:
 *   node --import ./tests/register.mjs tests/native/make-vectors.mjs /tmp/vectors
 *   CUBE_VECTORS=/tmp/vectors ./gradlew :cube-native:testDebugUnitTest      (in android/)
 * Also writes Kotlin-encrypted blobs to $CUBE_VECTORS/out/ for tests/native/check-native-out.mjs.
 * Skipped when CUBE_VECTORS is not set.
 */
class CubeCryptoTest {
  private val platform = CubeCrypto.usePlatform

  @After fun restore() { CubeCrypto.usePlatform = platform }

  private fun vectors(): Pair<File, List<Triple<String, Int, Boolean>>> {
    val dir = System.getenv("CUBE_VECTORS")?.let(::File)
    assumeTrue("CUBE_VECTORS not set", dir != null && dir.isDirectory)
    val manifest = File(dir, "manifest.json").readText()
    val cases = Regex("\"name\":\\s*\"([^\"]+)\",\\s*\"format\":\\s*(\\d),\\s*\"ok\":\\s*(true|false)")
      .findAll(manifest).map { Triple(it.groupValues[1], it.groupValues[2].toInt(), it.groupValues[3] == "true") }.toList()
    check(cases.size >= 10) { "found only ${cases.size} vectors" }
    return dir!! to cases
  }

  private fun checkAll(label: String) {
    val (dir, cases) = vectors()
    for ((name, format, ok) in cases) {
      val key = File(dir, "$name.key").readBytes()
      val plain = File(dir, "$name.plain").readBytes()
      val blobFile = File(dir, "$name.blob")
      val whole = runCatching { CubeCrypto.open(format, key, blobFile.readBytes()) }
      if (ok) {
        val p = whole.getOrElse { fail("$label $name: whole decrypt threw $it"); return }
        assertArrayEquals("$label $name", plain, p.bytes.copyOf(p.length))
      } else if (whole.isSuccess) {
        fail("$label $name: should have been rejected")
      }
      if (format == 2) {
        val out = ByteArrayOutputStream()
        val streamed = runCatching { blobFile.inputStream().use { CubeCrypto.streamV2(key, it, blobFile.length(), out) } }
        if (ok) {
          streamed.getOrElse { fail("$label $name: streamed decrypt threw $it"); return }
          assertArrayEquals("$label $name (streamed)", plain, out.toByteArray())
        } else if (streamed.isSuccess) {
          fail("$label $name: streamed decrypt should have been rejected")
        }
      }
    }
    println("PASS $label: ${cases.size} vectors")
  }

  @Test fun platformCipherMatchesJavaScript() {
    assumeTrue("no platform ChaCha20-Poly1305", platform)
    CubeCrypto.usePlatform = true
    checkAll("platform")
  }

  @Test fun pureKotlinMatchesJavaScript() {
    CubeCrypto.usePlatform = false
    checkAll("pure")
  }

  @Test fun stripMatchesJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val strip = File(dir, "strip")
    val ins = strip.listFiles { f -> f.name.endsWith(".in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no strip vectors" }
    for (f in ins) {
      val expect = File(strip, f.name.removeSuffix(".in") + ".out").readBytes()
      assertArrayEquals("strip ${f.name}", expect, CubeStrip.strip(f.readBytes()))
    }
    println("PASS strip: ${ins.size} vectors")
  }

  @Test fun encryptionRoundTripsAndIsReadableByJavaScript() {
    val (dir, _) = vectors()
    val outDir = File(dir, "out").apply { mkdirs() }
    val key = ByteArray(32) { (it * 7 + 3).toByte() }
    for (pure in listOf(false, true)) {
      if (!pure && !platform) continue
      for (n in listOf(0, 1, 65_535, 65_536, 200_000)) {
        val plain = ByteArray(n) { ((it * 31) xor (it ushr 9)).toByte() }
        CubeCrypto.usePlatform = !pure
        val out = ByteArrayOutputStream()
        val size = CubeCrypto.encryptV2(key, plain, plain.size, out)
        val blob = out.toByteArray()
        assertEquals(size, blob.size.toLong())
        for (decryptPure in listOf(false, true)) {          // each implementation reads the other's output
          if (!decryptPure && !platform) continue
          CubeCrypto.usePlatform = !decryptPure
          val p = CubeCrypto.openV2(key, blob)
          assertArrayEquals("n=$n pure=$pure/$decryptPure", plain, p.bytes.copyOf(p.length))
        }
        val tag = if (pure) "pure" else "platform"
        File(outDir, "kotlin-$tag-$n.blob").writeBytes(blob)
        File(outDir, "kotlin-$tag-$n.plain").writeBytes(plain)
        File(outDir, "kotlin-$tag-$n.key").writeBytes(key)
      }
    }
    println("PASS encryption")
  }

  @Test fun streamingWriterIsReadableByJavaScript() {
    val (dir, _) = vectors()
    val outDir = File(dir, "out").apply { mkdirs() }
    val key = ByteArray(32) { (it * 7 + 3).toByte() }
    for (n in listOf(0, 1, 65_535, 65_536, 65_537, 300_001)) {
      val plain = ByteArray(n) { ((it * 13) xor (it ushr 7)).toByte() }
      val out = ByteArrayOutputStream()
      val w = CubeCrypto.V2Writer(key, out)
      var at = 0
      var step = 1
      while (at < n) { val k = minOf(step, n - at); w.write(plain, at, k); at += k; step = step * 3 + 7 }
      w.finish()
      val blob = out.toByteArray()
      assertEquals(blob.size.toLong(), w.blobBytes)
      assertEquals(n.toLong(), w.plainBytes)
      val p = CubeCrypto.openV2(key, blob)
      assertArrayEquals("writer n=$n", plain, p.bytes.copyOf(p.length))
      File(outDir, "kotlin-writer-$n.blob").writeBytes(blob)
      File(outDir, "kotlin-writer-$n.plain").writeBytes(plain)
      File(outDir, "kotlin-writer-$n.key").writeBytes(key)
    }
    println("PASS streaming writer")
  }

  @Test fun pdfCleanerMatchesJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val doc = File(dir, "doc")
    val ins = doc.listFiles { f -> f.name.endsWith(".in") && !f.name.endsWith(".cfb.in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no PDF vectors" }
    for (f in ins) {
      val input = f.readBytes()
      val expect = File(doc, f.name.removeSuffix(".in") + ".out").readBytes()
      for (piece in listOf(1 shl 20, 65_536, 4_093, 1)) {
        if (piece < 64 && input.size >= 300_000) continue
        val c = CubeDocClean.PdfCleaner()
        val got = ByteArrayOutputStream()
        var at = 0
        while (at < input.size) { val k = minOf(piece, input.size - at); got.write(c.push(input, at, k)); at += k }
        got.write(c.finish())
        assertArrayEquals("pdf ${f.name} in pieces of $piece", expect, got.toByteArray())
      }
    }
    println("PASS pdf: ${ins.size} vectors")
  }

  @Test fun officeOutputForJavaScriptToCheck() {
    val (dir, _) = vectors()
    val doc = File(dir, "doc")
    val outDir = File(dir, "out").apply { mkdirs() }
    val files = doc.listFiles { f -> f.name.endsWith(".office") }!!.sortedBy { it.name }
    check(files.isNotEmpty()) { "no Office vectors" }
    for (f in files) {
      val fromFile = ByteArrayOutputStream()
      val changed = java.io.RandomAccessFile(f, "r").use { raf ->
        CubeDocClean.cleanOffice(CubeDocClean.ChannelSource(raf.channel)) { fromFile.write(it) }
      }
      val fromMemory = ByteArrayOutputStream()
      CubeDocClean.cleanOffice(CubeDocClean.ArraySource(f.readBytes())) { fromMemory.write(it) }
      assertArrayEquals("office ${f.name}: file and memory agree", fromFile.toByteArray(), fromMemory.toByteArray())
      File(outDir, "kotlin-${f.name}").writeBytes(if (changed) fromFile.toByteArray() else f.readBytes())
      println("office ${f.name}: ${if (changed) "rewritten" else "unchanged"}")
    }
  }

  @Test fun wholePdfOutputForJavaScriptToCheck() {
    val (dir, _) = vectors()
    val doc = File(dir, "doc")
    val outDir = File(dir, "out").apply { mkdirs() }
    val files = doc.listFiles { f -> f.name.endsWith(".full") }!!.sortedBy { it.name }
    check(files.isNotEmpty()) { "no whole-PDF vectors" }
    for (f in files) {
      val input = f.readBytes()
      val patches = java.io.RandomAccessFile(f, "r").use { CubeDocClean.pdfStreamPatches(CubeDocClean.ChannelSource(it.channel)) }
      // wrong-length: a /Length that does not end at "endstream" is never patched
      if (f.name.startsWith("wrong-length")) check(patches.isEmpty()) { "${f.name}: patched a stream with a wrong length" }
      else check(patches.isNotEmpty()) { "${f.name}: no compressed stream found" }
      for (p in patches) System.arraycopy(p.bytes, 0, input, p.at.toInt(), p.length)
      val c = CubeDocClean.PdfCleaner()
      val out = c.push(input) + c.finish()
      assertEquals("${f.name}: same length", f.length(), out.size.toLong())
      File(outDir, "kotlin-${f.name}").writeBytes(out)
    }
    println("PASS whole pdf: ${files.size} vectors")
  }
  @Test fun rtfCleanerMatchesJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val rtf = File(dir, "rtf")
    val ins = rtf.listFiles { f -> f.name.endsWith(".in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no RTF vectors" }
    for (f in ins) {
      val input = f.readBytes()
      val expect = File(rtf, f.name.removeSuffix(".in") + ".out").readBytes()
      for (piece in listOf(1 shl 20, 65_536, 4_093, 7, 1)) {
        val c = CubeDocClean.RtfCleaner()
        val got = ByteArrayOutputStream()
        var at = 0
        while (at < input.size) { val k = minOf(piece, input.size - at); got.write(c.push(input, at, k)); at += k }
        got.write(c.finish())
        assertArrayEquals("rtf ${f.name} in pieces of $piece", expect, got.toByteArray())
      }
    }
    println("PASS rtf: ${ins.size} vectors")
  }

  @Test fun cleanXmlMatchesJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val xml = File(dir, "xml")
    val ins = xml.listFiles { f -> f.name.endsWith(".in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no XML vectors" }
    for (f in ins) {
      val base = f.name.removeSuffix(".in")
      val elems = ArrayList<String>()
      val attrs = ArrayList<String>()
      var comments = false
      for (line in File(xml, "$base.rules").readText().split("\n")) {
        when {
          line.startsWith("e ") -> elems.add(line.substring(2))
          line.startsWith("a ") -> attrs.add(line.substring(2))
          line == "c" -> comments = true
          line.isEmpty() -> {}
          else -> fail("$base.rules: unknown line \"$line\"")
        }
      }
      val rules = CubeDocClean.XmlRules(elems, attrs, comments)
      val expect = File(xml, "$base.out").readBytes()
      val input = f.readBytes()
      assertArrayEquals("xml $base", expect, CubeDocClean.cleanXml(input, rules))
      for (piece in listOf(1, 2, 3, 7, 10, 64, 333, 4_093, input.size.coerceAtLeast(1))) {
        val c = CubeDocClean.XmlCleaner(rules)
        val got = ByteArrayOutputStream()
        var at = 0
        while (at < input.size) { val k = minOf(piece, input.size - at); got.write(c.push(input, at, k)); at += k }
        got.write(c.finish())
        assertArrayEquals("xml $base in pieces of $piece", expect, got.toByteArray())
      }
    }
    println("PASS xml: ${ins.size} vectors")
  }

  @Test fun compoundFilePatchesMatchJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val doc = File(dir, "doc")
    val ins = doc.listFiles { f -> f.name.endsWith(".cfb.in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no compound-file vectors" }
    fun apply(input: ByteArray, patches: List<CubeDocClean.Patch>): ByteArray {
      val b = input.copyOf()
      for (p in patches) System.arraycopy(p.bytes, 0, b, p.at.toInt(), p.length)
      return b
    }
    for (f in ins) {
      val input = f.readBytes()
      val expect = File(doc, f.name.removeSuffix(".in") + ".out").readBytes()
      check(CubeDocClean.isCfb(input, input.size.toLong())) { "${f.name}: not a compound file" }
      val fromMemory = apply(input, CubeDocClean.cfbPatches(CubeDocClean.ArraySource(input)))
      val fromFile = apply(input, java.io.RandomAccessFile(f, "r").use { CubeDocClean.cfbPatches(CubeDocClean.ChannelSource(it.channel)) })
      assertArrayEquals("cfb ${f.name}: file and memory agree", fromMemory, fromFile)
      assertArrayEquals("cfb ${f.name}", expect, fromFile)
      check(CubeMediaClean.ZERO.all { it == 0.toByte() }) { "cfb ${f.name}: the shared zeros were written to" }
    }
    println("PASS cfb: ${ins.size} vectors")
  }

  @Test fun mediaPatchesMatchJavaScriptByteForByte() {
    val (dir, _) = vectors()
    val media = File(dir, "media")
    val ins = media.listFiles { f -> f.name.endsWith(".in") }!!.sortedBy { it.name }
    check(ins.isNotEmpty()) { "no media vectors" }
    fun apply(input: ByteArray, patches: List<CubeDocClean.Patch>): ByteArray {
      val b = input.copyOf()
      for (p in patches) System.arraycopy(p.bytes, 0, b, p.at.toInt(), p.length)
      return b
    }
    for (f in ins) {
      val input = f.readBytes()
      val expect = File(media, f.name.removeSuffix(".in") + ".out").readBytes()
      val fromMemory = apply(input, CubeMediaClean.patches(CubeDocClean.ArraySource(input)))
      val fromFile = apply(input, java.io.RandomAccessFile(f, "r").use { CubeMediaClean.patches(CubeDocClean.ChannelSource(it.channel)) })
      assertArrayEquals("media ${f.name}: file and memory agree", fromMemory, fromFile)
      assertArrayEquals("media ${f.name}", expect, fromFile)
      check(CubeMediaClean.ZERO.all { it == 0.toByte() }) { "media ${f.name}: the shared zeros were written to" }
    }
    println("PASS media: ${ins.size} vectors")
  }
  @Test fun officeFallsBackPartByPart() {
    // A stored core.xml naming someone: cleaned normally; copied raw when its CRC is wrong; and an
    // encrypted entry leaves the whole file as picked (nothing emitted).
    val core = "<cp:coreProperties><dc:creator>Jane Doe</dc:creator></cp:coreProperties>".toByteArray()
    val zipped = ByteArrayOutputStream()
    java.util.zip.ZipOutputStream(zipped).use { z ->
      z.putNextEntry(java.util.zip.ZipEntry("[Content_Types].xml"))
      z.write("<Types/>".toByteArray())
      z.putNextEntry(java.util.zip.ZipEntry("docProps/core.xml").apply {
        method = java.util.zip.ZipEntry.STORED
        size = core.size.toLong()
        crc = java.util.zip.CRC32().apply { update(core) }.value
      })
      z.write(core)
    }
    val zip = zipped.toByteArray()
    val name = "docProps/core.xml".toByteArray()
    val central = (zip.size - name.size downTo 0).first { at -> name.indices.all { zip[at + it] == name[it] } } - 46
    fun clean(b: ByteArray): Pair<Boolean, String> {
      val out = ByteArrayOutputStream()
      val ok = CubeDocClean.cleanOffice(CubeDocClean.ArraySource(b)) { out.write(it) }
      return ok to String(out.toByteArray(), Charsets.ISO_8859_1)
    }
    val (ok, text) = clean(zip)
    assertEquals(true, ok)
    assertEquals(false, text.contains("Jane"))
    val badCrc = zip.copyOf().also { it[central + 16] = (it[central + 16].toInt() xor 1).toByte() }
    val (ok2, text2) = clean(badCrc)
    assertEquals(true, ok2)
    assertEquals(true, text2.contains("<dc:creator>Jane Doe</dc:creator>"))
    val encrypted = zip.copyOf().also { it[central + 8] = (it[central + 8].toInt() or 1).toByte() }
    assertEquals(false to "", clean(encrypted))
  }
}
