package expo.modules.cubenative

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import androidx.annotation.RequiresApi
import java.io.FileDescriptor
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private const val MAX_PAGE_PX = 2048        // page bitmaps are at most this wide
private const val MAX_PAGE_HEIGHT_PX = 8192 // and this tall (very long pages are drawn smaller and scaled)

/**
 * A decrypted PDF for CubeImageView (Android 11+). The plaintext lives only in a RAM-backed
 * memory file (memfd_create), never on storage; PdfRenderer reads it through a duplicated
 * descriptor. Pages are rendered one at a time on the document's own thread (PdfRenderer allows
 * one open page and is not thread-safe). close() stops rendering, closes the renderer, overwrites
 * the memory file with zeros before closing it, and wipes then recycles every page bitmap.
 *
 * PdfRenderer only draws pixels: no text layer, no links, nothing to select, copy or follow.
 */
internal class PdfDoc private constructor(
  private val memfd: FileDescriptor,
  private val length: Int,
  private val renderer: PdfRenderer,
  private val pfd: ParcelFileDescriptor,
  /** Each page's size in points (width, height). */
  val sizes: List<Pair<Int, Int>>,
) {
  private val thread: ExecutorService = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  // Every page bitmap not yet wiped (created on the render thread, wiped on the main thread).
  private val bitmaps = HashSet<Bitmap>()
  // Views showing this document (main thread only); told to let go when it closes.
  private val views = HashSet<CubeImageView>()

  @Volatile var closed = false
    private set

  val pageCount get() = sizes.size

  /** Main thread. */
  fun addView(v: CubeImageView) { if (!closed) views.add(v) }
  fun removeView(v: CubeImageView) { views.remove(v) }

  /**
   * Renders page `index` at most `width` pixels wide on the render thread (white background);
   * `done` gets the bitmap on the main thread. Nothing happens once the document is closed.
   */
  fun render(index: Int, width: Int, done: (Bitmap) -> Unit) {
    if (closed || width <= 0) return
    try {
      thread.execute {
        if (closed) return@execute
        val (pw, ph) = sizes[index]
        var w = minOf(width, MAX_PAGE_PX)
        var h = maxOf(1, (w.toLong() * ph / pw).toInt())
        if (h > MAX_PAGE_HEIGHT_PX) {
          w = maxOf(1, (w.toLong() * MAX_PAGE_HEIGHT_PX / h).toInt())
          h = MAX_PAGE_HEIGHT_PX
        }
        val bmp = try {
          Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
          return@execute
        }
        synchronized(bitmaps) { bitmaps.add(bmp) }
        val ok = try {
          bmp.eraseColor(Color.WHITE)
          val page = renderer.openPage(index)
          try {
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          } finally {
            page.close()
          }
          true
        } catch (e: Exception) {
          false
        }
        main.post { if (ok && !closed) done(bmp) else release(bmp) }
      }
    } catch (e: RejectedExecutionException) {
      // closed meanwhile
    }
  }

  /** Main thread: wipes and recycles a page bitmap. Callers make sure no view still shows it. */
  fun release(bmp: Bitmap) {
    if (!bmp.isRecycled) {
      bmp.eraseColor(0)
      bmp.recycle()
    }
    synchronized(bitmaps) { bitmaps.remove(bmp) }
  }

  /** Any thread. Views drop their pages first; the render thread then closes everything. */
  fun close() {
    if (closed) return
    closed = true
    main.post {
      for (v in views.toList()) v.pdfClosed(this)
      views.clear()
    }
    try {
      thread.execute {
        runCatching { renderer.close() }   // closes the duplicated descriptor too
        runCatching { pfd.close() }
        wipe(memfd, length)
        // Posted after every earlier render's result, so this sees every bitmap.
        main.post { for (b in synchronized(bitmaps) { bitmaps.toList() }) release(b) }
      }
    } finally {
      thread.shutdown()
    }
  }

  companion object {
    /**
     * Copies `length` bytes of `plain` into a memory file and opens it. The caller zeroes `plain`.
     * Throws for a damaged PDF (IOException) or a password-protected one (SecurityException).
     */
    @RequiresApi(30)
    fun open(plain: ByteArray, length: Int): PdfDoc {
      val fd = Os.memfd_create("cube-pdf", OsConstants.MFD_CLOEXEC)
      var renderer: PdfRenderer? = null
      var pfd: ParcelFileDescriptor? = null
      try {
        var off = 0
        while (off < length) {
          val n = Os.write(fd, plain, off, length - off)
          if (n <= 0) throw IOException("Could not fill the memory file")
          off += n
        }
        Os.lseek(fd, 0, OsConstants.SEEK_SET)
        pfd = ParcelFileDescriptor.dup(fd)
        val r = PdfRenderer(pfd)
        renderer = r
        if (r.pageCount < 1) throw IOException("The PDF has no pages")
        val sizes = (0 until r.pageCount).map { i ->
          val page = r.openPage(i)
          try {
            if (page.width <= 0 || page.height <= 0) throw IOException("Page $i has no size")
            page.width to page.height
          } finally {
            page.close()
          }
        }
        return PdfDoc(fd, length, r, pfd, sizes)
      } catch (e: Throwable) {
        runCatching { renderer?.close() }
        runCatching { pfd?.close() }
        wipe(fd, length)
        throw e
      }
    }

    /** Overwrites the memory file with zeros, empties it and closes it. */
    private fun wipe(fd: FileDescriptor, length: Int) {
      runCatching {
        val zeros = ByteArray(64 * 1024)
        var off = 0L
        while (off < length) {
          val n = Os.pwrite(fd, zeros, 0, minOf(zeros.size.toLong(), length - off).toInt(), off)
          if (n <= 0) break
          off += n
        }
        Os.ftruncate(fd, 0)
      }
      runCatching { Os.close(fd) }
    }
  }
}
