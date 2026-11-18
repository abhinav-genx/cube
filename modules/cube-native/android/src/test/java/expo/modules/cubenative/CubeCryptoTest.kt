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
 * pure-Kotlin one (Android 7-8). Generate the vectors, then run:
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
}
