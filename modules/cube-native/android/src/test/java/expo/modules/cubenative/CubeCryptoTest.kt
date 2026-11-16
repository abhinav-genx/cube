package expo.modules.cubenative

import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Checks CubeCrypto against blobs written by lib/vault.ts. Generate the vectors, then run:
 *   node --import ./tests/register.mjs tests/native/make-vectors.mjs /tmp/vectors
 *   CUBE_VECTORS=/tmp/vectors ./gradlew :cube-native:testDebugUnitTest      (in android/)
 * Skipped when CUBE_VECTORS is not set.
 */
class CubeCryptoTest {
  @Test
  fun matchesTheJavaScriptImplementation() {
    val dir = System.getenv("CUBE_VECTORS")?.let(::File)
    assumeTrue("CUBE_VECTORS not set", dir != null && dir.isDirectory)
    val manifest = File(dir, "manifest.json").readText()
    val cases = Regex("\"name\":\\s*\"([^\"]+)\",\\s*\"format\":\\s*(\\d),\\s*\"ok\":\\s*(true|false)")
      .findAll(manifest).map { Triple(it.groupValues[1], it.groupValues[2].toInt(), it.groupValues[3] == "true") }.toList()
    check(cases.size >= 10) { "found only ${cases.size} vectors" }
    for ((name, format, ok) in cases) {
      val key = File(dir, "$name.key").readBytes()
      val plain = File(dir, "$name.plain").readBytes()
      val blobFile = File(dir, "$name.blob")
      val whole = runCatching { CubeCrypto.open(format, key, blobFile.readBytes()) }
      if (ok) {
        val p = whole.getOrElse { fail("$name: whole decrypt threw $it"); return }
        assertArrayEquals(name, plain, p.bytes.copyOf(p.length))
      } else if (whole.isSuccess) {
        fail("$name: should have been rejected")
      }
      if (format == 2) {
        val out = ByteArrayOutputStream()
        val streamed = runCatching { blobFile.inputStream().use { CubeCrypto.streamV2(key, it, blobFile.length(), out) } }
        if (ok) {
          streamed.getOrElse { fail("$name: streamed decrypt threw $it"); return }
          assertArrayEquals("$name (streamed)", plain, out.toByteArray())
        } else if (streamed.isSuccess) {
          fail("$name: streamed decrypt should have been rejected")
        }
      }
      println("PASS $name")
    }
  }
}
