import Foundation

/// Removes identifying details from videos and audio while they stream in (modules/cube-native
/// runImport): a port of lib/mediameta.ts mediaPatches, giving exactly the same patches (checked by
/// tests/native). Foundation only (with CubeDocClean's Patch and RandomSource), so it compiles on
/// its own for those checks.
///
/// Everything is edited in place, at the same length, so every offset in the file stays valid. Only
/// box, frame and chunk headers are read (never sample data), from the picked file where it is.
/// - MP4, MOV, M4A, 3GP: user-data and metadata items inside moov (and each trak) other than the
///   creation date become "free" boxes with their contents zeroed; so do XMP boxes.
/// - MP3: ID3v2 frames other than dates become padding; ID3v1, Enhanced ID3v1 and APEv2 are emptied.
/// - FLAC: Vorbis comments, pictures and application blocks become padding.
/// - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks.
/// Anything else, or anything malformed, gives no patches: the file is stored as picked.
enum CubeMediaClean {
  typealias Patch = CubeDocClean.Patch

  private struct PastEnd: Error {}

  /// Same-length patches that remove identifying details from a video or audio file (see above).
  static func patches(_ src: CubeDocClean.RandomSource) -> [Patch] {
    var patches: [Patch] = []
    do {
      if src.size < 12 { return [] }
      let head = try read(src, 0, 12)
      if isMp4(head) {
        try mp4(src, 0, src.size, .top, &patches)
        return patches
      }
      if has(head, 0, "RIFF") || has(head, 0, "RF64") {
        if has(head, 8, "WAVE") { try riff(src, &patches) }
        return patches
      }
      var at = 0
      if has(head, 0, "ID3") && head[3] >= 2 && head[3] <= 4 { at = try id3v2(src, head, &patches) }
      if at + 4 <= src.size, has(try read(src, at, 4), 0, "fLaC") {
        try flac(src, at + 4, &patches)
        return patches
      }
      // tags at the end only for MPEG audio: an ID3v2 tag at the start, or a frame sync
      if at > 0 || (head[0] == 0xFF && head[1] & 0xE0 == 0xE0) { try endTags(src, &patches) }
      return patches
    } catch {
      return []   // malformed: store as picked
    }
  }

  // MARK: - Bytes

  /// Latin-1 bytes of a short ASCII (or "©…") name.
  private static func l1(_ s: String) -> [UInt8] { s.unicodeScalars.map { UInt8($0.value) } }

  private static func has(_ b: [UInt8], _ at: Int, _ s: String) -> Bool {
    let t = l1(s)
    guard at >= 0, at + t.count <= b.count else { return false }
    return b[at..<(at + t.count)].elementsEqual(t)
  }

  private static func u32(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at]) << 24 | Int(b[at + 1]) << 16 | Int(b[at + 2]) << 8 | Int(b[at + 3])
  }
  private static func u32le(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at]) | Int(b[at + 1]) << 8 | Int(b[at + 2]) << 16 | Int(b[at + 3]) << 24
  }
  private static func syncsafe(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at] & 0x7F) << 21 | Int(b[at + 1] & 0x7F) << 14 | Int(b[at + 2] & 0x7F) << 7 | Int(b[at + 3] & 0x7F)
  }

  /// Reads exactly `n` bytes at `at`, or throws (the file is shorter than its headers say).
  private static func read(_ src: CubeDocClean.RandomSource, _ at: Int, _ n: Int) throws -> [UInt8] {
    guard at >= 0, n >= 0, n <= src.size, at <= src.size - n else { throw PastEnd() }
    return try src.read(at, n)
  }

  // MARK: - MP4 / MOV

  private static let topTypes: Set<[UInt8]> = Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"].map(l1))
  private static let xmpUuid: [UInt8] = [0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC]
  /// User-data boxes that stay: the creation date, chapters and track-selection or hint details.
  private static let keepUdta: Set<[UInt8]> = Set(["©day", "chpl", "tsel", "hnti", "hinf"].map(l1))
  /// Metadata keys that stay (case-insensitive): dates and what players need for slow motion.
  private static let keepKey: [[UInt8]] = ["creationdate", "capture.fps", "full-frame-rate-playback-intent"].map(l1)
  private static let day = l1("©day")

  private static func isKeepKey(_ name: [UInt8]) -> Bool {
    let lower = name.map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 }
    for k in keepKey where lower.count >= k.count {
      for i in 0...(lower.count - k.count) where lower[i..<(i + k.count)].elementsEqual(k) { return true }
    }
    return false
  }

  private static func isMp4(_ head: [UInt8]) -> Bool {
    let size = u32(head, 0)
    return topTypes.contains(Array(head[4..<8])) && (size == 0 || size == 1 || size >= 8)
  }

  private struct Box { let at: Int; let size: Int; let type: [UInt8]; let head: Int }

  private static func boxes(_ src: CubeDocClean.RandomSource, _ from: Int, _ to: Int) throws -> [Box] {
    var list: [Box] = []
    var at = from
    while at + 8 <= to {
      let h = try read(src, at, min(16, to - at))
      var size = u32(h, 0)
      let type = Array(h[4..<8])
      var head = 8
      if size == 1 {
        if h.count < 16 { break }
        let hi = u32(h, 8)
        if hi >= 0x4000_0000 { break }   // past any real file: past `to` too
        size = hi << 32 | u32(h, 12)
        head = 16
      } else if size == 0 {
        size = to - at
      }
      if size < head || size > to - at { break }
      list.append(Box(at: at, size: size, type: type, head: head))
      at += size
    }
    return list
  }

  private static func blank(_ b: Box, _ patches: inout [Patch]) {
    patches.append(Patch(at: b.at + 4, bytes: l1("free")))
    CubeDocClean.zeroPatches(&patches, b.at + b.head, b.size - b.head)
  }

  private static func isXmpUuid(_ src: CubeDocClean.RandomSource, _ b: Box) throws -> Bool {
    if b.type != l1("uuid") || b.size < b.head + 16 { return false }
    return try read(src, b.at + b.head, 16) == xmpUuid
  }

  private enum Where { case top, moov, trak, udta }

  private static func mp4(_ src: CubeDocClean.RandomSource, _ from: Int, _ to: Int, _ place: Where, _ patches: inout [Patch]) throws {
    for b in try boxes(src, from, to) {
      let inner = b.at + b.head
      if try isXmpUuid(src, b) { blank(b, &patches) }
      else if b.type == l1("meta") { try meta(src, b, &patches) }
      else if place == .top {
        if b.type == l1("moov") { try mp4(src, inner, b.at + b.size, .moov, &patches) }
      } else if place == .udta {
        if !keepUdta.contains(b.type) { blank(b, &patches) }
      } else if b.type == l1("udta") { try mp4(src, inner, b.at + b.size, .udta, &patches) }
      else if b.type == l1("trak") && place == .moov { try mp4(src, inner, b.at + b.size, .trak, &patches) }
    }
  }

  /// A metadata box: QuickTime's (children right away) or ISO's (version and flags first).
  private static func meta(_ src: CubeDocClean.RandomSource, _ b: Box, _ patches: inout [Patch]) throws {
    var inner = b.at + b.head
    let end = b.at + b.size
    if inner + 8 > end { return }
    if !has(try read(src, inner, 8), 4, "hdlr") { inner += 4 }
    let children = try boxes(src, inner, end)
    var keys: [[UInt8]]? = nil
    for c in children where c.type == l1("keys") { keys = try readKeys(src, c) }
    for c in children {
      if c.type == l1("ilst") {
        for item in try boxes(src, c.at + c.head, c.at + c.size) {
          let index = u32(try read(src, item.at + 4, 4), 0)
          let name: [UInt8]
          if let keys = keys, index >= 1 && index <= keys.count { name = keys[index - 1] } else { name = item.type }
          if name != day && !isKeepKey(name) { blank(item, &patches) }
        }
      } else if try c.type == l1("xml ") || c.type == l1("XMP_") || isXmpUuid(src, c) {
        blank(c, &patches)
      }
    }
  }

  /// QuickTime metadata key names, in order (item types in ilst are 1-based indexes into them).
  private static func readKeys(_ src: CubeDocClean.RandomSource, _ b: Box) throws -> [[UInt8]]? {
    let n = b.size - b.head
    if n < 8 || n > 1 << 20 { return nil }
    let k = try read(src, b.at + b.head, n)
    let count = u32(k, 4)
    var keys: [[UInt8]] = []
    var p = 8
    var i = 0
    while i < count {
      if p + 8 > k.count { return nil }
      let size = u32(k, p)
      if size < 8 || p + size > k.count { return nil }
      keys.append(Array(k[(p + 8)..<(p + size)]))
      p += size
      i += 1
    }
    return keys
  }

  // MARK: - MP3: ID3v2, ID3v1, Enhanced ID3v1, APEv2

  private static let id3Dates: Set<[UInt8]> = Set(["TDRC", "TYER", "TDAT", "TIME", "TDOR", "TORY", "TDRL", "TYE", "TDA", "TIM", "TOR"].map(l1))
  /// Tags larger than this are zeroed whole rather than read to keep their dates.
  private static let id3Max = 64 * 1024 * 1024

  /// Keeps only date frames (moved to the front), padding after them; returns where the tag ends.
  private static func id3v2(_ src: CubeDocClean.RandomSource, _ head: [UInt8], _ patches: inout [Patch]) throws -> Int {
    let ver = head[3]
    let flags = head[5]
    let size = syncsafe(head, 6)
    let footer = ver == 4 && flags & 0x10 != 0 ? 10 : 0
    if 10 + size + footer > src.size { throw PastEnd() }
    let plain = flags & 0x80 == 0 && flags & 0x40 == 0   // unsynchronised, extended header (v2.2: compressed)
    if plain && size <= id3Max {
      let tag = try read(src, 10, size)
      var body = [UInt8](repeating: 0, count: size)
      var q = 0
      var p = 0
      let hl = ver == 2 ? 6 : 10
      while p < size && tag[p] != 0 {
        if p + hl > size { break }
        let id = Array(tag[p..<(p + (ver == 2 ? 3 : 4))])
        let n = ver == 2 ? Int(tag[p + 3]) << 16 | Int(tag[p + 4]) << 8 | Int(tag[p + 5]) : ver == 4 ? syncsafe(tag, p + 4) : u32(tag, p + 4)
        if p + hl + n > size { break }
        if id3Dates.contains(id) {
          body.replaceSubrange(q..<(q + hl + n), with: tag[p..<(p + hl + n)])
          q += hl + n
        }
        p += hl + n
      }
      patches.append(Patch(at: 10, bytes: body))
    } else {
      CubeDocClean.zeroPatches(&patches, 10, size)
    }
    let clean = [flags & ~0xC0]
    patches.append(Patch(at: 5, bytes: clean))
    if footer > 0 { patches.append(Patch(at: 10 + size + 5, bytes: clean)) }
    return 10 + size + footer
  }

  private static func endTags(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    var end = src.size
    if end >= 128, has(try read(src, end - 128, 3), 0, "TAG") {
      let at = end - 128
      CubeDocClean.zeroPatches(&patches, at + 3, 90)    // title, artist, album; the year (4 bytes) stays
      CubeDocClean.zeroPatches(&patches, at + 97, 30)   // comment (and track number)
      patches.append(Patch(at: at + 127, bytes: [0xFF]))   // no genre
      end = at
      if end >= 227, has(try read(src, end - 227, 4), 0, "TAG+") {
        CubeDocClean.zeroPatches(&patches, end - 227 + 4, 223)
        end -= 227
      }
    }
    if end >= 32 {
      let f = try read(src, end - 32, 32)
      if has(f, 0, "APETAGEX") {
        let size = u32le(f, 12)   // items and footer
        let hasHeader = u32le(f, 20) & 0x8000_0000 != 0
        let items = end - size
        if size >= 32 && items - (hasHeader ? 32 : 0) >= 0 {
          CubeDocClean.zeroPatches(&patches, items, size - 32)
          CubeDocClean.zeroPatches(&patches, end - 32 + 16, 4)   // item count 0
          if hasHeader { CubeDocClean.zeroPatches(&patches, items - 32 + 16, 4) }
        }
      }
    }
  }

  // MARK: - FLAC

  private static func flac(_ src: CubeDocClean.RandomSource, _ from: Int, _ patches: inout [Patch]) throws {
    var p = from
    while true {
      let h = try read(src, p, 4)
      let last = h[0] & 0x80
      let type = h[0] & 0x7F
      let n = Int(h[1]) << 16 | Int(h[2]) << 8 | Int(h[3])
      if p + 4 + n > src.size { return }
      if type == 2 || type == 4 || type == 6 {   // application, Vorbis comment, picture → padding
        patches.append(Patch(at: p, bytes: [last | 1]))
        CubeDocClean.zeroPatches(&patches, p + 4, n)
      }
      p += 4 + n
      if last != 0 { return }
    }
  }

  // MARK: - WAV

  private static let riffBlank: Set<[UInt8]> = Set(["bext", "iXML", "_PMX", "id3 ", "ID3 ", "cart", "axml"].map(l1))

  private static func riff(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    let declared = u32le(try read(src, 4, 4), 0)
    let end = declared == 0xFFFF_FFFF ? src.size : min(src.size, 8 + declared)
    var p = 12
    while p + 8 <= end {
      let h = try read(src, p, 12 <= end - p ? 12 : 8)
      let id = Array(h[0..<4])
      let n = u32le(h, 4)
      if n == 0xFFFF_FFFF || p + 8 + n > end { return }
      if riffBlank.contains(id) || (id == l1("LIST") && h.count >= 12 && has(h, 8, "INFO")) {
        patches.append(Patch(at: p, bytes: l1("JUNK")))
        CubeDocClean.zeroPatches(&patches, p + 8, n)
      }
      p += 8 + n + (n & 1)
    }
  }
}
