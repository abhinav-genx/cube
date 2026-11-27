import Foundation

/// Native port of lib/strip.ts: removes location and camera details from an image without touching
/// its pixels. Must produce exactly the same bytes as the JavaScript version (tests/native/ checks
/// both against the same inputs). Foundation only, so it compiles on its own for those checks.
enum CubeStrip {
  static func strip(_ input: [UInt8]) -> [UInt8] {
    var b = input
    if b.count < 12 { return b }
    if b[0] == 0xFF && b[1] == 0xD8 {
      stripJpeg(&b)
      scanAll(&b)
      return b
    }
    if starts(b, 0, pngSig) { return stripPng(b) }
    if starts(b, 0, ascii("RIFF")) && starts(b, 8, ascii("WEBP")) {
      stripWebp(&b)
      scanAll(&b)
      return b
    }
    if starts(b, 0, jxlSig) {
      stripJxl(&b)
      scanAll(&b)
      return b
    }
    let isHeif = starts(b, 4, ascii("ftyp"))
    let isGif = starts(b, 0, ascii("GIF8"))
    let isTiff = isTiffHeader(b, 0)
    if isHeif || isGif || isTiff {
      if isTiff { scrubTiff(&b, 0, b.count) }
      scanAll(&b)
    }
    return b
  }

  // MARK: - Containers

  private static func stripJpeg(_ b: inout [UInt8]) {
    var i = 2
    while i + 4 <= b.count {
      if b[i] != 0xFF { return }
      let m = b[i + 1]
      if m == 0xFF { i += 1; continue }
      if m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7) { i += 2; continue }
      if m == 0xDA || m == 0xD9 { return }
      let len = Int(b[i + 2]) << 8 | Int(b[i + 3])
      let data = i + 4
      let end = i + 2 + len
      if len < 2 || end > b.count { return }
      if m == 0xE1 && starts(b, data, exifId) {
        scrubTiff(&b, data + exifId.count, end)
      } else if (m == 0xE1 && (starts(b, data, xmpId) || starts(b, data, xmpExtId))) || m == 0xED {
        b[i + 1] = 0xFE
        for k in data..<end { b[k] = 0 }
      }
      i = end
    }
  }

  private static func stripPng(_ b: [UInt8]) -> [UInt8] {
    var out = Array(b[0..<8])
    var i = 8
    while i + 12 <= b.count {
      let len = Int(u32be(b, i))
      let end = i + 12 + len
      if end > b.count { break }
      let type = String(bytes: b[(i + 4)..<(i + 8)], encoding: .isoLatin1) ?? ""
      if type == "eXIf" {
        var chunk = Array(b[i..<end])
        scrubTiff(&chunk, 8, 8 + len)
        let c = crc32(chunk, 4, 8 + len)
        chunk[8 + len] = UInt8(c >> 24); chunk[9 + len] = UInt8((c >> 16) & 0xFF)
        chunk[10 + len] = UInt8((c >> 8) & 0xFF); chunk[11 + len] = UInt8(c & 0xFF)
        out += chunk
      } else if type != "tEXt" && type != "zTXt" && type != "iTXt" && type != "tIME" {
        out += b[i..<end]
      }
      i = end
      if type == "IEND" { break }
    }
    if i < b.count { out += b[i...] }
    return out
  }

  private static func stripWebp(_ b: inout [UInt8]) {
    var i = 12
    while i + 8 <= b.count {
      let raw = UInt32(b[i + 4]) | UInt32(b[i + 5]) << 8 | UInt32(b[i + 6]) << 16 | UInt32(b[i + 7]) << 24
      if raw > UInt32(Int32.max) { return }   // the JS version sees these as negative and stops
      let len = Int(raw)
      let data = i + 8
      let end = data + len
      if end > b.count { return }
      if starts(b, i, ascii("EXIF")) {
        scrubTiff(&b, starts(b, data, exifId) ? data + exifId.count : data, end)
      }
      i = end + (len & 1)
    }
  }

  /// JPEG XL in its container (a bare codestream has no metadata): the Exif box is scrubbed in place;
  /// JUMBF boxes (content credentials, which can name the author and the device) and Brotli-compressed
  /// Exif, XMP or JUMBF boxes become "free" boxes, zeroed, which decoders skip. XMP boxes are blanked
  /// by scanAll. JPEG XL keeps its orientation in the codestream, so nothing here affects how it shows.
  private static func stripJxl(_ b: inout [UInt8]) {
    var i = 0
    while i + 8 <= b.count {
      var size = Int(u32be(b, i))
      var head = 8
      if size == 1 {
        if i + 16 > b.count || u32be(b, i + 8) != 0 { return }   // over 4 GB: not in memory anyway
        size = Int(u32be(b, i + 12))
        head = 16
      } else if size == 0 { size = b.count - i }
      let end = i + size
      if size < head || end > b.count { return }
      let type = Array(b[(i + 4)..<(i + 8)])
      let data = i + head
      let inner: [UInt8] = type == ascii("brob") && end - data >= 4 ? Array(b[data..<(data + 4)]) : []
      if type == ascii("Exif") && end - data >= 4 {
        let tiff = data + 4 + Int(u32be(b, data))
        if tiff < end && isTiffHeader(b, tiff) { scrubTiff(&b, tiff, end) }
      } else if type == ascii("jumb") || inner == ascii("Exif") || inner == ascii("xml ") || inner == ascii("jumb") {
        for (k, c) in ascii("free").enumerated() { b[i + 4 + k] = c }
        for k in data..<end { b[k] = 0 }
      }
      i = end
    }
  }

  private static func scanAll(_ b: inout [UInt8]) {
    var i = 0
    while i + 14 <= b.count {
      if b[i] == 0x45 && starts(b, i, exifId) && isTiffHeader(b, i + 6) { scrubTiff(&b, i + 6, b.count) }
      i += 1
    }
    for sig in [tiffLE8, tiffBE8] {
      var j = 0
      while j + 8 <= b.count {
        if b[j] == sig[0] && starts(b, j, sig) { scrubTiff(&b, j, b.count) }
        j += 1
      }
    }
    blankXml(&b, ascii("<x:xmpmeta"), ascii("</x:xmpmeta>"), ascii("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">"))
    blankXml(&b, ascii("<rdf:RDF"), ascii("</rdf:RDF>"), ascii("<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"))
  }

  private static func blankXml(_ b: inout [UInt8], _ open: [UInt8], _ close: [UInt8], _ head: [UInt8]) {
    var from = 0
    while true {
      guard let s = find(b, open, from), let c = find(b, close, s + open.count) else { return }
      let end = c + close.count
      if end - s >= head.count + close.count {
        for k in 0..<head.count { b[s + k] = head[k] }
        for k in (s + head.count)..<c { b[k] = 0x20 }
      }
      from = end
    }
  }

  // MARK: - TIFF / Exif

  private static let gpsIfd = 0x8825
  private static let exifIfd = 0x8769
  private static let dropMain: Set<Int> = [
    0x010E, 0x010F, 0x0110, 0x0131, 0x013B, 0x013C, 0x02BC, 0x8298, 0x83BB, 0x8649,
    0x9C9B, 0x9C9C, 0x9C9D, 0x9C9E, 0x9C9F, gpsIfd,
  ]
  private static let dropExif: Set<Int> = [0x927C, 0x9286, 0xA420, 0xA430, 0xA431, 0xA432, 0xA433, 0xA434, 0xA435, gpsIfd]
  private static let typeSize = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]
  private static let maxEntries = 1000

  private struct Entry { let at: Int; let tag: Int; let type: Int; let count: Int; let value: Int }

  private static func scrubTiff(_ b: inout [UInt8], _ base: Int, _ end: Int) {
    if !isTiffHeader(b, base) || end - base < 8 { return }
    var t = Tiff(le: b[base] == 0x49, base: base, size: end - base)
    t.scrub(&b, t.u32(b, 4), dropMain, true)
  }

  /// One TIFF block being scrubbed. Every helper takes the bytes as a parameter (Swift forbids a
  /// closure capturing an array that is being modified).
  private struct Tiff {
    let le: Bool
    let base: Int
    let size: Int
    var seen = Set<Int>()

    func u16(_ b: [UInt8], _ o: Int) -> Int {
      le ? Int(b[base + o]) | Int(b[base + o + 1]) << 8 : Int(b[base + o]) << 8 | Int(b[base + o + 1])
    }

    func u32(_ b: [UInt8], _ o: Int) -> Int {
      let x = le
        ? UInt32(b[base + o]) | UInt32(b[base + o + 1]) << 8 | UInt32(b[base + o + 2]) << 16 | UInt32(b[base + o + 3]) << 24
        : UInt32(b[base + o]) << 24 | UInt32(b[base + o + 1]) << 16 | UInt32(b[base + o + 2]) << 8 | UInt32(b[base + o + 3])
      return Int(x)
    }

    func read(_ b: [UInt8], _ off: Int) -> [Entry]? {
      if off < 8 || off + 2 > size { return nil }
      let n = u16(b, off)
      if n == 0 || n > maxEntries || off + 2 + 12 * n + 4 > size { return nil }
      var out: [Entry] = []
      for k in 0..<n {
        let at = off + 2 + 12 * k
        let type = u16(b, at + 2)
        if type < 1 || type > 13 { return nil }
        out.append(Entry(at: at, tag: u16(b, at), type: type, count: u32(b, at + 4), value: u32(b, at + 8)))
      }
      return out
    }

    func zeroValue(_ b: inout [UInt8], _ e: Entry) {
      let len = e.count * typeSize[e.type]
      if len > 4 && e.value >= 8 && e.value + len <= size {
        for k in (base + e.value)..<(base + e.value + len) { b[k] = 0 }
      }
    }

    mutating func wipe(_ b: inout [UInt8], _ off: Int) {
      guard let entries = read(b, off), !seen.contains(off) else { return }
      seen.insert(off)
      for e in entries { zeroValue(&b, e) }
      for k in (base + off)..<(base + off + 2 + 12 * entries.count + 4) { b[k] = 0 }
    }

    mutating func scrub(_ b: inout [UInt8], _ off: Int, _ drop: Set<Int>, _ main: Bool) {
      guard let entries = read(b, off), !seen.contains(off) else { return }
      seen.insert(off)
      var kept: [Entry] = []
      for e in entries {
        if e.tag == gpsIfd { wipe(&b, e.value) }
        if main && e.tag == exifIfd { scrub(&b, e.value, dropExif, false) }
        if drop.contains(e.tag) { zeroValue(&b, e) } else { kept.append(e) }
      }
      let n = entries.count
      let nextAt = off + 2 + 12 * n
      let next = u32(b, nextAt)
      if kept.count < n {
        let saved = kept.map { Array(b[(base + $0.at)..<(base + $0.at + 12)]) }
        for (k, raw) in saved.enumerated() {
          for j in 0..<12 { b[base + off + 2 + 12 * k + j] = raw[j] }
        }
        let c = kept.count
        b[base + off + (le ? 0 : 1)] = UInt8(c & 0xFF)
        b[base + off + (le ? 1 : 0)] = UInt8((c >> 8) & 0xFF)
        let newNext = off + 2 + 12 * kept.count
        let ptr = Array(b[(base + nextAt)..<(base + nextAt + 4)])
        for j in 0..<4 { b[base + newNext + j] = ptr[j] }
        for k in (base + newNext + 4)..<(base + nextAt + 4) { b[k] = 0 }
      }
      if main && next != 0 { scrub(&b, next, dropMain, true) }
    }
  }

  // MARK: - Bytes

  private static func ascii(_ s: String) -> [UInt8] { Array(s.utf8) }
  private static let pngSig: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  /// the JPEG XL container's signature box
  private static let jxlSig: [UInt8] = [0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A]
  private static let exifId: [UInt8] = [0x45, 0x78, 0x69, 0x66, 0, 0]
  private static let xmpId: [UInt8] = Array("http://ns.adobe.com/xap/1.0/".utf8) + [0]
  private static let xmpExtId: [UInt8] = Array("http://ns.adobe.com/xmp/extension/".utf8) + [0]
  private static let tiffLE8: [UInt8] = [0x49, 0x49, 0x2A, 0, 8, 0, 0, 0]
  private static let tiffBE8: [UInt8] = [0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8]

  private static func isTiffHeader(_ b: [UInt8], _ i: Int) -> Bool {
    i + 8 <= b.count &&
      ((b[i] == 0x49 && b[i + 1] == 0x49 && b[i + 2] == 0x2A && b[i + 3] == 0) ||
        (b[i] == 0x4D && b[i + 1] == 0x4D && b[i + 2] == 0 && b[i + 3] == 0x2A))
  }

  private static func starts(_ b: [UInt8], _ at: Int, _ sig: [UInt8]) -> Bool {
    if at < 0 || at + sig.count > b.count { return false }
    for k in 0..<sig.count where b[at + k] != sig[k] { return false }
    return true
  }

  private static func find(_ b: [UInt8], _ sig: [UInt8], _ from: Int) -> Int? {
    var i = max(0, from)
    while i + sig.count <= b.count {
      if b[i] == sig[0] && starts(b, i, sig) { return i }
      i += 1
    }
    return nil
  }

  private static func u32be(_ b: [UInt8], _ i: Int) -> UInt32 {
    UInt32(b[i]) << 24 | UInt32(b[i + 1]) << 16 | UInt32(b[i + 2]) << 8 | UInt32(b[i + 3])
  }

  private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
  }

  private static func crc32(_ b: [UInt8], _ from: Int, _ to: Int) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for i in from..<to { c = crcTable[Int((c ^ UInt32(b[i])) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }
}
