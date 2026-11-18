import Compression
import Foundation

/// Removes author and organisation details from documents while they stream in (modules/cube-native
/// runImport). Foundation and Compression only, so it compiles on its own for tests/native.
///
/// - PDF: PdfCleaner, a port of the machine in lib/docmeta.ts (byte for byte the same output,
///   checked by tests/native): document-information strings and XMP packets are blanked in place.
/// - Office: the zip is read in place (central directory first, then each entry's data where it is)
///   and written out again with docProps/core.xml, app.xml and custom.xml values emptied, the same
///   fields lib/docmeta.ts empties. Every other entry is copied byte for byte, still compressed.
///   Anything unusual (zip64, encryption, not an Office file, nothing to change) leaves the file as
///   it was picked.
enum CubeDocClean {
  // MARK: - PDF

  struct PdfCleaner {
    private enum Mode { case normal, name, afterKey, hexOrDict, hex, literal, tag, capture }

    static let keys: Set<String> = ["Author", "Creator", "Producer", "Title", "Subject", "Keywords"]
    static let tags: [([UInt8], [UInt8], [UInt8])] = [
      (Array("<x:xmpmeta".utf8), Array("</x:xmpmeta>".utf8), Array("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">".utf8)),
      (Array("<rdf:RDF".utf8), Array("</rdf:RDF>".utf8),
       Array("<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">".utf8)),
    ]
    static let xmpMax = 16 * 1024 * 1024

    private var mode = Mode.normal
    private var name: [UInt8] = []
    private var depth = 0
    private var escape = false
    private var hexN = 0
    private var held: [UInt8] = []
    private var kind = 0
    private var out: [UInt8] = []

    init() {}

    /// Feeds bytes in; returns the bytes that are final so far.
    mutating func push(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
      out.reserveCapacity(out.count + input.count)
      for c in input { step(c) }
      return take()
    }

    mutating func push(_ input: [UInt8]) -> [UInt8] {
      input.withUnsafeBufferPointer { push($0) }
    }

    /// Ends the stream: anything still held passes through as it is.
    mutating func finish() -> [UInt8] {
      out.append(contentsOf: held)
      wipe(&held)
      mode = .normal
      return take()
    }

    private static func isWhite(_ c: UInt8) -> Bool { c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 || c == 0x0C || c == 0x00 }
    private static func isAlnum(_ c: UInt8) -> Bool { (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }

    private mutating func step(_ c: UInt8) {
      switch mode {
      case .name:
        if Self.isAlnum(c) {
          if name.count <= 8 { name.append(c) }
          out.append(c)
          return
        }
        mode = name.count <= 8 && Self.keys.contains(String(decoding: name, as: UTF8.self)) ? .afterKey : .normal
        step(c)
      case .afterKey:
        if Self.isWhite(c) { out.append(c); return }
        if c == 0x28 { mode = .literal; depth = 1; escape = false; out.append(c); return }
        if c == 0x3C { mode = .hexOrDict; out.append(c); return }
        mode = .normal
        step(c)
      case .hexOrDict:
        if c == 0x3C { mode = .normal; out.append(c); return }
        mode = .hex
        hexN = 0
        step(c)
      case .hex:
        if c == 0x3E { mode = .normal; out.append(c); return }
        if Self.isWhite(c) { out.append(c); return }
        out.append(hexN % 2 == 0 ? 0x32 : 0x30)
        hexN += 1
      case .literal:
        if escape { escape = false; out.append(0x20); return }
        if c == 0x5C { escape = true; out.append(0x20); return }
        if c == 0x28 { depth += 1; out.append(0x20); return }
        if c == 0x29 {
          depth -= 1
          if depth == 0 { mode = .normal; out.append(c); return }
          out.append(0x20)
          return
        }
        out.append(0x20)
      case .tag:
        held.append(c)
        var prefix = false
        for (k, t) in Self.tags.enumerated() {
          let open = t.0
          if held.count > open.count { continue }
          if !held.elementsEqual(open.prefix(held.count)) { continue }
          if held.count == open.count { mode = .capture; kind = k; return }
          prefix = true
        }
        if prefix { return }
        held.removeLast()
        out.append(contentsOf: held)
        held.removeAll(keepingCapacity: true)
        mode = .normal
        step(c)
      case .capture:
        held.append(c)
        let (open, close, head) = Self.tags[kind]
        if held.count >= open.count + close.count && held.suffix(close.count).elementsEqual(close) {
          if held.count >= head.count + close.count {
            for i in 0..<(held.count - close.count) { held[i] = i < head.count ? head[i] : 0x20 }
          }
          out.append(contentsOf: held)
          wipe(&held)
          mode = .normal
        } else if held.count > Self.xmpMax {
          out.append(contentsOf: held)
          wipe(&held)
          mode = .normal
        }
      case .normal:
        if c == 0x2F { mode = .name; name.removeAll(keepingCapacity: true); out.append(c); return }
        if c == 0x3C { mode = .tag; held = [c]; return }
        out.append(c)
      }
    }

    private mutating func take() -> [UInt8] {
      let done = out
      wipe(&out)
      return done
    }
  }

  static func wipe(_ b: inout [UInt8]) {
    for i in b.indices { b[i] = 0 }
    b.removeAll(keepingCapacity: true)
  }

  // MARK: - Office

  /// Somewhere bytes can be read at any offset: a picked file, or a photo/document held in memory.
  protocol RandomSource {
    var size: Int { get }
    func read(_ at: Int, _ count: Int) throws -> [UInt8]
  }

  struct Malformed: Error {}

  final class FileSource: RandomSource {
    private let handle: FileHandle
    let size: Int
    init(_ url: URL) throws {
      handle = try FileHandle(forReadingFrom: url)
      size = Int(try handle.seekToEnd())
    }
    func read(_ at: Int, _ count: Int) throws -> [UInt8] {
      guard at >= 0, count >= 0, at + count <= size else { throw Malformed() }
      try handle.seek(toOffset: UInt64(at))
      var out = [UInt8]()
      out.reserveCapacity(count)
      while out.count < count {
        guard let part = try handle.read(upToCount: count - out.count), !part.isEmpty else { throw Malformed() }
        out.append(contentsOf: part)
      }
      return out
    }
    deinit { try? handle.close() }
  }

  struct DataSource: RandomSource {
    let data: Data
    var size: Int { data.count }
    func read(_ at: Int, _ count: Int) throws -> [UInt8] {
      guard at >= 0, count >= 0, at + count <= data.count else { throw Malformed() }
      return [UInt8](data[(data.startIndex + at)..<(data.startIndex + at + count)])
    }
  }

  private struct Entry {
    var madeBy: UInt16, needed: UInt16, flags: UInt16, method: UInt16, time: UInt16, date: UInt16
    var crc: UInt32, csize: UInt32, usize: UInt32
    var internalAttr: UInt16, externalAttr: UInt32, localOffset: UInt32
    var name: [UInt8]
  }

  static let coreTags = ["dc:creator", "cp:lastModifiedBy", "dc:title", "dc:subject", "cp:keywords", "dc:description", "cp:category"]
  static let appTags = ["Company", "Manager"]
  /// docProps entries larger than this are left alone (they are a few KB).
  static let propsMax = 16 * 1024 * 1024

  /// The cleaned docProps part, or nil if it does not change.
  static func cleanProps(_ name: String, _ xml: String) -> String? {
    var out = xml
    func empty(_ pattern: String) {
      guard let re = try? NSRegularExpression(pattern: pattern) else { return }
      out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "$1$2")
    }
    switch name {
    case "docProps/core.xml": for t in coreTags { empty("(<\(t)(?:\\s[^>]*)?>)[\\s\\S]*?(</\(t)>)") }
    case "docProps/app.xml": for t in appTags { empty("(<\(t)(?:\\s[^>]*)?>)[\\s\\S]*?(</\(t)>)") }
    case "docProps/custom.xml": empty("(<vt:[A-Za-z0-9]+(?:\\s[^>]*)?>)[\\s\\S]*?(</vt:[A-Za-z0-9]+>)")
    default: return nil
    }
    return out == xml ? nil : out
  }

  /// Writes the cleaned Office file through `emit` and returns true; or returns false, having
  /// emitted nothing, when the file should be stored as it is.
  static func cleanOffice(_ src: RandomSource, emit: ([UInt8]) throws -> Void) throws -> Bool {
    guard let plan = try? planOffice(src) else { return false }
    let (entries, changed) = plan
    if changed.isEmpty { return false }

    var offset: UInt64 = 0
    var central = [UInt8]()
    for var e in entries.sorted(by: { $0.localOffset < $1.localOffset }) {
      let head = try src.read(Int(e.localOffset), 30)
      let dataStart = Int(e.localOffset) + 30 + Int(u16(head, 26)) + Int(u16(head, 28))
      let replacement = changed[String(decoding: e.name, as: UTF8.self)]
      let oldSize = Int(e.csize)
      if let r = replacement {
        e.method = 0
        e.flags &= ~0x0006   // deflate options mean nothing for a stored entry
        e.crc = crc32(r)
        e.csize = UInt32(r.count)
        e.usize = UInt32(r.count)
      }
      e.flags &= ~0x0008   // sizes and CRC are in the local header now, no data descriptor
      var local = [UInt8]()
      put32(&local, 0x0403_4B50); put16(&local, e.needed); put16(&local, e.flags); put16(&local, e.method)
      put16(&local, e.time); put16(&local, e.date); put32(&local, e.crc); put32(&local, e.csize); put32(&local, e.usize)
      put16(&local, UInt16(e.name.count)); put16(&local, 0)
      local.append(contentsOf: e.name)
      try emit(local)
      if let r = replacement {
        try emit(r)
      } else {
        var at = 0
        while at < oldSize {
          let n = min(1 << 20, oldSize - at)
          var part = try src.read(dataStart + at, n)
          try emit(part)
          wipe(&part)
          at += n
        }
      }
      put32(&central, 0x0201_4B50); put16(&central, e.madeBy); put16(&central, e.needed); put16(&central, e.flags)
      put16(&central, e.method); put16(&central, e.time); put16(&central, e.date); put32(&central, e.crc)
      put32(&central, e.csize); put32(&central, e.usize); put16(&central, UInt16(e.name.count))
      put16(&central, 0); put16(&central, 0); put16(&central, 0); put16(&central, e.internalAttr)
      put32(&central, e.externalAttr); put32(&central, UInt32(offset))
      central.append(contentsOf: e.name)
      offset += UInt64(local.count) + UInt64(e.csize)
      guard offset < 0xFFFF_FFFF else { throw Malformed() }
    }
    var end = [UInt8]()
    put32(&end, 0x0605_4B50); put16(&end, 0); put16(&end, 0)
    put16(&end, UInt16(entries.count)); put16(&end, UInt16(entries.count))
    put32(&end, UInt32(central.count)); put32(&end, UInt32(offset)); put16(&end, 0)
    try emit(central)
    try emit(end)
    return true
  }

  /// Reads the central directory and the docProps parts; throws for anything not to be touched.
  private static func planOffice(_ src: RandomSource) throws -> ([Entry], [String: [UInt8]]) {
    let size = src.size
    guard size >= 22 else { throw Malformed() }
    let tailLen = min(size, 0xFFFF + 22)
    let tail = try src.read(size - tailLen, tailLen)
    var eocd = -1
    var i = tailLen - 22
    while i >= 0 {
      if tail[i] == 0x50 && tail[i + 1] == 0x4B && tail[i + 2] == 0x05 && tail[i + 3] == 0x06 { eocd = i; break }
      i -= 1
    }
    guard eocd >= 0 else { throw Malformed() }
    let eocdPos = size - tailLen + eocd
    let count = Int(u16(tail, eocd + 10))
    let cdSize = Int(u32(tail, eocd + 12)), cdOffset = Int(u32(tail, eocd + 16))
    guard u16(tail, eocd + 4) == 0, u16(tail, eocd + 6) == 0, u16(tail, eocd + 8) == count,
          count > 0, count != 0xFFFF, cdSize != 0xFFFF_FFFF, cdOffset != 0xFFFF_FFFF,
          cdOffset + cdSize <= eocdPos else { throw Malformed() }
    if eocdPos >= 20, try src.read(eocdPos - 20, 4) == [0x50, 0x4B, 0x06, 0x07] { throw Malformed() }   // zip64
    let cd = try src.read(cdOffset, cdSize)
    var entries: [Entry] = []
    var p = 0
    for _ in 0..<count {
      guard p + 46 <= cd.count, u32(cd, p) == 0x0201_4B50 else { throw Malformed() }
      let nameLen = Int(u16(cd, p + 28)), extraLen = Int(u16(cd, p + 30)), commentLen = Int(u16(cd, p + 32))
      guard p + 46 + nameLen <= cd.count else { throw Malformed() }
      let e = Entry(
        madeBy: u16(cd, p + 4), needed: u16(cd, p + 6), flags: u16(cd, p + 8), method: u16(cd, p + 10),
        time: u16(cd, p + 12), date: u16(cd, p + 14), crc: u32(cd, p + 16), csize: u32(cd, p + 20),
        usize: u32(cd, p + 24), internalAttr: u16(cd, p + 36), externalAttr: u32(cd, p + 38),
        localOffset: u32(cd, p + 42), name: Array(cd[(p + 46)..<(p + 46 + nameLen)])
      )
      guard e.flags & 1 == 0, e.csize != 0xFFFF_FFFF, e.usize != 0xFFFF_FFFF, e.localOffset != 0xFFFF_FFFF,
            Int(e.localOffset) + 30 <= cdOffset else { throw Malformed() }
      entries.append(e)
      p += 46 + nameLen + extraLen + commentLen
    }
    let names = entries.map { String(decoding: $0.name, as: UTF8.self) }
    guard names.contains("[Content_Types].xml") else { throw Malformed() }   // a zip, not an Office file
    var changed: [String: [UInt8]] = [:]
    for (k, e) in entries.enumerated() where names[k].hasPrefix("docProps/") {
      guard ["docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"].contains(names[k]) else { continue }
      guard Int(e.usize) <= propsMax, Int(e.csize) <= propsMax else { throw Malformed() }
      let head = try src.read(Int(e.localOffset), 30)
      guard u32(head, 0) == 0x0403_4B50 else { throw Malformed() }
      let dataStart = Int(e.localOffset) + 30 + Int(u16(head, 26)) + Int(u16(head, 28))
      let data = try src.read(dataStart, Int(e.csize))
      let raw: [UInt8]
      switch e.method {
      case 0: raw = data
      case 8: raw = try inflate(data, size: Int(e.usize))
      default: throw Malformed()
      }
      guard crc32(raw) == e.crc, let xml = String(bytes: raw, encoding: .utf8) else { throw Malformed() }
      if let clean = cleanProps(names[k], xml) { changed[names[k]] = Array(clean.utf8) }
    }
    return (entries, changed)
  }

  /// Raw DEFLATE (as zip stores it) of exactly `size` bytes.
  static func inflate(_ data: [UInt8], size: Int) throws -> [UInt8] {
    if size == 0 { return [] }
    var out = [UInt8](repeating: 0, count: size + 1)   // one spare byte shows an overlong stream
    let n = data.withUnsafeBufferPointer { src in
      out.withUnsafeMutableBufferPointer { dst in
        compression_decode_buffer(dst.baseAddress!, dst.count, src.baseAddress!, src.count, nil, COMPRESSION_ZLIB)
      }
    }
    guard n == size else { throw Malformed() }
    out.removeLast()
    return out
  }

  private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
  }

  static func crc32(_ b: [UInt8]) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for x in b { c = crcTable[Int((c ^ UInt32(x)) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }

  private static func u16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
  private static func u32(_ b: [UInt8], _ i: Int) -> UInt32 {
    UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
  }
  private static func put16(_ b: inout [UInt8], _ v: UInt16) { b.append(UInt8(v & 0xFF)); b.append(UInt8(v >> 8)) }
  private static func put32(_ b: inout [UInt8], _ v: UInt32) {
    for k in 0..<4 { b.append(UInt8((v >> (8 * UInt32(k))) & 0xFF)) }
  }
}
