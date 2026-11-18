package expo.modules.cubenative

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.security.SecureRandom

/** Files shared without a readable copy: token -> what to decrypt, until it expires or the vault locks. */
internal object ShareRegistry {
  class Share(val path: String, val key: ByteArray, val format: Int, val name: String, val mime: String, val size: Long, val expiresAt: Long)

  private const val LIFETIME_MS = 2 * 60 * 1000L   // the same allowance a picker or share sheet gets
  private val shares = HashMap<String, Share>()
  private val random = SecureRandom()

  @Synchronized fun add(path: String, key: ByteArray, format: Int, name: String, mime: String, size: Long): String {
    val token = ByteArray(16).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    shares[token] = Share(path, key, format, name, mime, size, SystemClock.elapsedRealtime() + LIFETIME_MS)
    return token
  }

  @Synchronized fun get(token: String): Share? {
    val s = shares[token] ?: return null
    if (SystemClock.elapsedRealtime() > s.expiresAt) {
      s.key.fill(0)
      shares.remove(token)
      return null
    }
    return s
  }

  /** Ends every share and wipes the keys (the vault locked, or the screen that shared is gone). */
  @Synchronized fun clear() {
    shares.values.forEach { it.key.fill(0) }
    shares.clear()
  }
}

/**
 * Serves content://<package>.cubeexport/<token>/<name>. openFile hands the receiving app the read
 * end of a pipe and decrypts into the write end on a background thread, chunk by chunk for v2
 * files, so the plaintext never touches storage. Apps that need to seek in a file cannot read a
 * pipe; for those the share fails in that app and nothing is left behind.
 */
class CubeExportProvider : ContentProvider() {
  override fun onCreate() = true

  private fun share(uri: Uri) = uri.pathSegments.firstOrNull()?.let(ShareRegistry::get)

  override fun getType(uri: Uri): String? = share(uri)?.mime

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
    val s = share(uri) ?: return null
    val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    val row = cols.map { c ->
      when (c) {
        OpenableColumns.DISPLAY_NAME -> s.name
        OpenableColumns.SIZE -> s.size
        else -> null
      }
    }
    return MatrixCursor(cols).apply { addRow(row) }
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("read only")
    val s = share(uri) ?: throw FileNotFoundException("expired")
    val key = s.key.copyOf()
    val pipe = ParcelFileDescriptor.createReliablePipe()
    Thread {
      try {
        ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { out ->
          val src = File(s.path)
          if (s.format == 2) {
            src.inputStream().buffered().use { CubeCrypto.streamV2(key, it, src.length(), out) }
          } else {
            val plain = CubeCrypto.openV1(key, src.readBytes())
            try { out.write(plain.bytes, 0, plain.length) } finally { plain.bytes.fill(0) }
          }
        }
      } catch (e: Exception) {
        runCatching { pipe[1].closeWithError("Could not decrypt") }
      } finally {
        key.fill(0)
      }
    }.start()
    return pipe[0]
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
}
