import Compression
import Foundation

/// Removes author and organisation details from documents while they stream in (modules/cube-native
/// runImport). Foundation and Compression only (plus CubeStrip for photos inside zip documents), so
/// it compiles on its own for tests/native. Every cleaner here is a port of lib/docmeta.ts, checked
/// byte for byte against it by tests/native (videos and audio: CubeMediaClean.swift).
///
/// - PDF: PdfCleaner blanks document-information strings and XMP packets in place;
///   pdfStreamPatches finds Flate-compressed object and XMP streams (PNG predictors and indirect
///   lengths included) and JPEG photos, and returns same-length patches for them.
/// - Office, OpenDocument, EPUB: the zip is read in place (central directory first, then each entry's
///   data where it is) and written out again, one entry in memory at a time: XML parts lose people's
///   names and properties (cleanXml with xmlRules), photos their location and camera details
///   (CubeStrip). Every other entry is copied byte for byte, still compressed. Anything unusual
///   (encryption, not a document zip, sizes that need zip64 on the way out) leaves the file as it
///   was picked.
/// - RTF: RtfCleaner drops \info fields, revision and comment authors and the generator as the file
///   streams through.
/// - SVG: cleanXml with svgRules (comments, <metadata>, editor attributes holding file paths).
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

  // MARK: - Patches

  /// Bytes to put at an offset, replacing as many: the file keeps its length. `count` bytes of
  /// `bytes` are used; zero runs all view the one shared block of zeros (zeroPatches).
  struct Patch {
    let at: Int
    let bytes: [UInt8]
    let count: Int
    init(at: Int, bytes: [UInt8]) { self.at = at; self.bytes = bytes; count = bytes.count }
    /// `count` zeros at `at`; count <= Patch.zeros.count.
    init(zerosAt at: Int, count: Int) { self.at = at; bytes = Patch.zeros; self.count = count }
    /// Zeros shared by every patch that blanks a region (patches never write to their bytes).
    static let zeros = [UInt8](repeating: 0, count: 1 << 20)
  }

  /// Patches that zero `n` bytes at `at`, all sharing one block of zeros (lib/mediameta.ts zeroPatches).
  static func zeroPatches(_ patches: inout [Patch], _ at: Int, _ n: Int) {
    var at = at, n = n
    while n > 0 {
      let k = min(n, Patch.zeros.count)
      patches.append(Patch(zerosAt: at, count: k))
      at += k
      n -= k
    }
  }

  /// Lays the patches (in order) over `piece`, which holds the file's bytes from `offset` on.
  static func overlay(_ patches: [Patch], on piece: inout [UInt8], at offset: Int) {
    let end = offset + piece.count
    for p in patches where p.at < end && p.at + p.count > offset {
      let from = max(p.at, offset), to = min(p.at + p.count, end)
      piece.replaceSubrange((from - offset)..<(to - offset), with: p.bytes[(from - p.at)..<(to - p.at)])
    }
  }

  // MARK: - PDF: compressed object and metadata streams, JPEG photos

  static let streamMax = 16 * 1024 * 1024
  /// JavaScript's \s within Latin-1 (ICU's \s differs: no vertical tab).
  private static let ws = #"[\t\n\x{0B}\f\r \x{A0}]"#

  /// A stream whose /Length is "n g R", to look at again once that object is found.
  private struct Pending { let p: Int; let ref: String }
  /// A stream length and where its digits sit in the file.
  private struct Length { let value: Int; let at: Int; let digits: Int }

  /// The same streams and patches as lib/docmeta.ts pdfStreamPatches: Flate-compressed object
  /// streams (/Type /ObjStm) and XMP streams (/Type /Metadata) whose contents PdfCleaner changes are
  /// decompressed (PNG predictors undone), cleaned, recompressed and written back at the same
  /// offset, padded with newlines, with the /Length number rewritten (spaces after it), where the
  /// dictionary has it or in the object an indirect /Length points to. JPEG photos (/DCTDecode) get
  /// their Exif, XMP, IPTC and comment segments zeroed. Anything unusual is left alone.
  static func pdfStreamPatches(_ src: RandomSource) -> [Patch] {
    var patches: [Patch] = []
    var pending: [Pending] = []
    let step = 1 << 20
    let kw = Array("stream".utf8)
    var start = 0
    while start < src.size {
      guard let win = try? src.read(start, min(step + kw.count, src.size - start)) else { break }
      var i = 0
      while i < min(step, win.count) && i + kw.count <= win.count {
        if win[i] == 0x73 && win[i..<(i + kw.count)].elementsEqual(kw) {
          streamPatch(src, start + i, &patches, &pending, first: true, given: nil)
        }
        i += 1
      }
      start += step
    }
    if !pending.isEmpty {
      let lengths = indirectLengths(src, Set(pending.map { $0.ref }))
      var none: [Pending] = []
      for x in pending {
        if let len = lengths[x.ref] { streamPatch(src, x.p, &patches, &none, first: false, given: len) }
      }
    }
    return patches
  }

  /// A digit string as a number, saturating where JavaScript's Number would lose precision.
  private static func number(_ s: String) -> Int {
    var v = 0
    for c in s.utf8 {
      let d = Int(c) - 0x30
      if v > (Int.max - d) / 10 { return Int.max }
      v = v * 10 + d
    }
    return v
  }

  private static func regex(_ pattern: String) -> NSRegularExpression? { try? NSRegularExpression(pattern: pattern) }

  /// Finds "n g obj <integer> endobj" for each wanted "n g" (the last definition wins).
  private static func indirectLengths(_ src: RandomSource, _ wanted: Set<String>) -> [String: Length] {
    var found: [String: Length] = [:]
    guard let re = regex(#"(?<![0-9])(\d+)\#(ws)+(\d+)\#(ws)+obj\#(ws)*(\d+)\#(ws)*endobj"#) else { return found }
    let step = 1 << 20
    var start = 0
    while start < src.size {
      // from 32 bytes before the window, so a number cut by the window's start is read whole
      let from = max(0, start - 32)
      guard let win = try? src.read(from, min(start + step + 256, src.size) - from),
            let t = String(bytes: win, encoding: .isoLatin1) else { break }
      let ns = t as NSString
      for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
        let ref = "\(number(ns.substring(with: m.range(at: 1)))) \(number(ns.substring(with: m.range(at: 2))))"
        if !wanted.contains(ref) { continue }
        let r = m.range(at: 3)
        let digits = ns.substring(with: r)
        found[ref] = Length(value: number(digits), at: from + r.location, digits: r.length)
      }
      start += step
    }
    return found
  }

  /// Looks at the "stream" keyword at `p`; adds patches if it starts a stream worth cleaning.
  private static func streamPatch(_ src: RandomSource, _ p: Int, _ patches: inout [Patch], _ pending: inout [Pending],
                                  first: Bool, given: Length?) {
    if p >= 3, (try? src.read(p - 3, 3)) == Array("end".utf8) { return }
    guard let eol = try? src.read(p + 6, min(2, src.size - p - 6)), !eol.isEmpty else { return }
    let dataStart = eol.count == 2 && eol[0] == 0x0D && eol[1] == 0x0A ? p + 8 : eol[0] == 0x0A ? p + 7 : -1
    if dataStart < 0 { return }
    let back = min(4096, p)
    guard let before = try? src.read(p - back, back) else { return }
    func white(_ c: UInt8) -> Bool { c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 || c == 0x0C || c == 0x00 }
    var q = before.count - 1
    while q >= 0 && white(before[q]) { q -= 1 }
    guard q >= 1, before[q] == 0x3E, before[q - 1] == 0x3E else { return }
    var depth = 0, open = -1, k = q
    while k >= 1 {
      if before[k] == 0x3E && before[k - 1] == 0x3E { depth += 1; k -= 1 }
      else if before[k] == 0x3C && before[k - 1] == 0x3C {
        depth -= 1
        k -= 1
        if depth == 0 { open = k; break }
      }
      k -= 1
    }
    guard open >= 0 else { return }
    let dict = String(bytes: before[open...q], encoding: .isoLatin1) ?? ""
    let ns = dict as NSString
    func find(_ pattern: String, in s: String? = nil) -> NSTextCheckingResult? {
      let text = s ?? dict
      return regex(pattern)?.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
    }
    if find(#"/Filter\#(ws)*(/DCTDecode|\[\#(ws)*/DCTDecode\#(ws)*\])"#) != nil {
      if first { jpegPatches(src, dataStart, &patches) }
      return
    }
    guard find(#"/Type\#(ws)*/(ObjStm|Metadata)(?![A-Za-z0-9])"#) != nil,
          find(#"/Filter\#(ws)*(/FlateDecode|\[\#(ws)*/FlateDecode\#(ws)*\])"#) != nil else { return }
    var columns = 0   // 0: no predictor
    if find(#"/DecodeParms"#) != nil {
      guard let parms = find(#"/DecodeParms\#(ws)*(?:\[\#(ws)*)?<<([^<>]*)>>"#) else { return }
      let body = ns.substring(with: parms.range(at: 1))
      func num(_ key: String, _ dflt: Int) -> Int {
        guard let m = find(#"/\#(key)\#(ws)+(\d+)"#, in: body) else { return dflt }
        return number((body as NSString).substring(with: m.range(at: 1)))
      }
      let predictor = num("Predictor", 1)
      if predictor >= 10 && predictor <= 15 && num("Colors", 1) == 1 && num("BitsPerComponent", 8) == 8 { columns = num("Columns", 1) }
      else if predictor != 1 { return }
      if predictor != 1 && (columns < 1 || columns > streamMax) { return }
    }
    let len: Length
    if let given = given {
      len = given
    } else {
      guard let direct = find(#"/Length\#(ws)+(\d+)(?!\#(ws)*\d*\#(ws)+R)(?![0-9])"#) else {
        if first, let ref = find(#"/Length\#(ws)+(\d+)\#(ws)+(\d+)\#(ws)+R"#) {
          pending.append(Pending(p: p, ref: "\(number(ns.substring(with: ref.range(at: 1)))) \(number(ns.substring(with: ref.range(at: 2))))"))
        }
        return
      }
      let r = direct.range(at: 1)
      len = Length(value: number(ns.substring(with: r)), at: p - back + open + r.location, digits: r.length)
    }
    let L = len.value
    guard L <= streamMax, dataStart + L <= src.size else { return }
    // the length must end where "endstream" starts (after an optional end of line): a wrong length is
    // never trusted with a patch
    guard let after = try? src.read(dataStart + L, min(11, src.size - dataStart - L)),
          [[0x0D, 0x0A], [0x0D], [0x0A], []].contains(where: { (eol: [UInt8]) in
            startsAt(after, 0, eol + Array("endstream".utf8))
          }) else { return }
    guard var data = try? src.read(dataStart, L), data.count >= 6,
          data[0] & 0x0F == 8, (Int(data[0]) << 8 | Int(data[1])) % 31 == 0,
          var stored = unzlib(data) else { return }
    defer { wipe(&data); wipe(&stored) }
    var plain: [UInt8]
    if columns > 0 {
      guard let u = unpredict(stored, columns) else { return }
      plain = u
    } else {
      plain = stored
    }
    defer { wipe(&plain) }
    var c = PdfCleaner()
    var clean = c.push(plain) + c.finish()
    defer { wipe(&clean) }
    if clean == plain { return }
    var rows = columns > 0 ? predictNone(clean, columns) : clean
    defer { wipe(&rows) }
    guard let z = zlib(rows), z.count <= L else { return }
    var bytes = [UInt8](repeating: 0x0A, count: L)
    bytes.replaceSubrange(0..<z.count, with: z)
    patches.append(Patch(at: dataStart, bytes: bytes))
    let s = Array(String(z.count).utf8)
    patches.append(Patch(at: len.at, bytes: s + [UInt8](repeating: 0x20, count: max(0, len.digits - s.count))))
  }

  /// PNG predictor rows (one 8-bit colour, `columns` bytes a row) back to plain bytes; nil if malformed.
  static func unpredict(_ data: [UInt8], _ columns: Int) -> [UInt8]? {
    let row = columns + 1
    if data.count % row != 0 { return nil }
    let rows = data.count / row
    var out = [UInt8](repeating: 0, count: rows * columns)
    for r in 0..<rows {
      let f = data[r * row]
      for x in 0..<columns {
        let raw = Int(data[r * row + 1 + x])
        let a = x > 0 ? Int(out[r * columns + x - 1]) : 0
        let b = r > 0 ? Int(out[(r - 1) * columns + x]) : 0
        let c = x > 0 && r > 0 ? Int(out[(r - 1) * columns + x - 1]) : 0
        let v: Int
        switch f {
        case 0: v = raw
        case 1: v = raw + a
        case 2: v = raw + b
        case 3: v = raw + ((a + b) >> 1)
        case 4:
          let pp = a + b - c
          let pa = abs(pp - a), pb = abs(pp - b), pc = abs(pp - c)
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        default:
          wipe(&out)
          return nil
        }
        out[r * columns + x] = UInt8(v & 0xFF)
      }
    }
    return out
  }

  /// Plain bytes as PNG predictor rows, each with filter type 0 (none).
  static func predictNone(_ plain: [UInt8], _ columns: Int) -> [UInt8] {
    let rows = plain.count / columns
    var out = [UInt8](repeating: 0, count: rows * (columns + 1))
    for r in 0..<rows {
      out.replaceSubrange((r * (columns + 1) + 1)..<((r + 1) * (columns + 1)), with: plain[(r * columns)..<((r + 1) * columns)])
    }
    return out
  }

  /// JPEG segments zeroed inside PDFs: APP1 (Exif, XMP), APP3–APP13 (IPTC…), APP15, comments.
  private static func blankSegment(_ m: UInt8) -> Bool { m == 0xE1 || (m >= 0xE3 && m <= 0xED) || m == 0xEF || m == 0xFE }

  /// Zeroes the identifying segments of the JPEG at `at` (up to its image data), in place.
  private static func jpegPatches(_ src: RandomSource, _ at: Int, _ patches: inout [Patch]) {
    if at + 2 > src.size { return }
    guard let soi = try? src.read(at, 2), soi[0] == 0xFF, soi[1] == 0xD8 else { return }
    var p = at + 2
    while p + 4 <= src.size {
      guard let m = try? src.read(p, 4), m[0] == 0xFF else { return }
      let marker = m[1]
      if marker == 0xFF { p += 1; continue }   // fill byte
      if marker == 0xDA || marker == 0xD9 { return }   // image data (or the end): metadata comes before
      if (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 { p += 2; continue }
      let len = Int(m[2]) << 8 | Int(m[3])
      if len < 2 || p + 2 + len > src.size { return }
      if blankSegment(marker) { zeroPatches(&patches, p + 4, len - 2) }
      p += 2 + len
    }
  }

  /// zlib (RFC 1950) decompression, up to streamMax bytes; nil if the data is not valid zlib.
  static func unzlib(_ data: [UInt8]) -> [UInt8]? {
    guard data.count >= 6 else { return nil }
    let body = Array(data[2..<(data.count - 4)])
    var cap = max(64 * 1024, body.count * 8)
    while true {
      var out = [UInt8](repeating: 0, count: cap)
      let n = body.withUnsafeBufferPointer { src in
        out.withUnsafeMutableBufferPointer { dst in
          compression_decode_buffer(dst.baseAddress!, cap, src.baseAddress!, src.count, nil, COMPRESSION_ZLIB)
        }
      }
      if n < cap {
        let plain = Array(out[0..<n])
        let a = data.suffix(4)
        let want = UInt32(a[a.startIndex]) << 24 | UInt32(a[a.startIndex + 1]) << 16 | UInt32(a[a.startIndex + 2]) << 8 | UInt32(a[a.startIndex + 3])
        return adler32(plain) == want && (n > 0 || body.count <= 2) ? plain : nil
      }
      if cap >= streamMax { return nil }
      cap = min(streamMax + 1, cap * 4)
    }
  }

  /// Raw DEFLATE (as zip stores it); nil if it could not be compressed.
  static func deflate(_ plain: [UInt8]) -> [UInt8]? {
    if plain.isEmpty { return [0x03, 0x00] }
    let cap = plain.count + plain.count / 8 + 1024
    var out = [UInt8](repeating: 0, count: cap)
    let n = plain.withUnsafeBufferPointer { src in
      out.withUnsafeMutableBufferPointer { dst in
        compression_encode_buffer(dst.baseAddress!, cap, src.baseAddress!, src.count, nil, COMPRESSION_ZLIB)
      }
    }
    guard n > 0 else { return nil }
    return Array(out[0..<n])
  }

  /// zlib (RFC 1950) compression: header, raw DEFLATE, Adler-32.
  static func zlib(_ plain: [UInt8]) -> [UInt8]? {
    guard let d = deflate(plain) else { return nil }
    let a = adler32(plain)
    return [0x78, 0x9C] + d + [UInt8(a >> 24), UInt8((a >> 16) & 0xFF), UInt8((a >> 8) & 0xFF), UInt8(a & 0xFF)]
  }

  static func adler32(_ b: [UInt8]) -> UInt32 {
    var s1: UInt32 = 1, s2: UInt32 = 0
    for x in b { s1 = (s1 + UInt32(x)) % 65521; s2 = (s2 + s1) % 65521 }
    return s2 << 16 | s1
  }

  static func wipe(_ b: inout [UInt8]) {
    for i in b.indices { b[i] = 0 }
    b.removeAll(keepingCapacity: true)
  }

  // MARK: - XML: Office, OpenDocument, EPUB, SVG

  /// Which parts of an XML document to empty (lib/docmeta.ts XmlRules). Names match a qualified
  /// name exactly when they have a prefix ("dc:creator"), every name with that prefix when they end
  /// in ":*" ("vt:*"), and the local part of any name otherwise ("author" matches "p188:author").
  /// - elems: these elements keep their tags and lose everything inside them.
  /// - attrs: these attributes keep their name and quotes and lose their value. "element@attribute"
  ///   limits one to an element; "...^prefix" to values that start with that prefix.
  /// - comments: drop XML comments.
  struct XmlRules {
    var elems: [String]
    var attrs: [String]
    var comments: Bool
    init(elems: [String], attrs: [String], comments: Bool = false) {
      self.elems = elems
      self.attrs = attrs
      self.comments = comments
    }
  }

  /// A name pattern, compiled to bytes (lib/docmeta.ts nameMatch).
  private struct NamePattern {
    enum Kind { case prefix, exact, local }
    let kind: Kind
    let bytes: [UInt8]
    init(_ s: String) {
      let u = Array(s.utf8)
      if u.count >= 2 && u[u.count - 2] == 0x3A && u[u.count - 1] == 0x2A { kind = .prefix; bytes = Array(u.dropLast()) }
      else if u.contains(0x3A) { kind = .exact; bytes = u }
      else { kind = .local; bytes = u }
    }
    func matches(_ q: ArraySlice<UInt8>) -> Bool {
      switch kind {
      case .prefix: return q.count >= bytes.count && q.prefix(bytes.count).elementsEqual(bytes)
      case .exact: return q.elementsEqual(bytes)
      case .local:
        if let c = q.firstIndex(of: 0x3A) { return q[(c + 1)...].elementsEqual(bytes) }
        return q.elementsEqual(bytes)
      }
    }
  }

  /// An attribute pattern (lib/docmeta.ts attrMatch): [element@]attribute[^value prefix].
  private struct AttrPattern {
    let elem: NamePattern?
    let attr: NamePattern
    let prefix: [UInt8]?
    init(_ s: String) {
      var p = s
      if let caret = p.firstIndex(of: "^") {
        prefix = Array(p[p.index(after: caret)...].utf8)
        p = String(p[..<caret])
      } else {
        prefix = nil
      }
      if let at = p.firstIndex(of: "@") {
        elem = NamePattern(String(p[..<at]))
        p = String(p[p.index(after: at)...])
      } else {
        elem = nil
      }
      attr = NamePattern(p)
    }
    func matches(_ elem: ArraySlice<UInt8>, _ attr: ArraySlice<UInt8>, _ value: ArraySlice<UInt8>) -> Bool {
      if let e = self.elem, !e.matches(elem) { return false }
      guard self.attr.matches(attr) else { return false }
      guard let prefix = prefix else { return true }
      return value.count >= prefix.count && value.prefix(prefix.count).elementsEqual(prefix)
    }
  }

  private static func isXmlSpace(_ c: UInt8) -> Bool { c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 }

  private static func indexOf(_ b: [UInt8], _ c: UInt8, _ from: Int) -> Int {
    var i = from
    while i < b.count { if b[i] == c { return i }; i += 1 }
    return -1
  }

  private static func startsAt(_ b: [UInt8], _ at: Int, _ s: [UInt8]) -> Bool {
    guard at >= 0, b.count >= at + s.count else { return false }
    for k in 0..<s.count where b[at + k] != s[k] { return false }
    return true
  }

  private static func find(_ b: [UInt8], _ sig: [UInt8], _ from: Int) -> Int {
    var i = indexOf(b, sig[0], from)
    while i >= 0 && i + sig.count <= b.count {
      if startsAt(b, i, sig) { return i }
      i = indexOf(b, sig[0], i + 1)
    }
    return -1
  }

  private static let commentOpen = Array("<!--".utf8), commentClose = Array("-->".utf8)
  private static let cdataOpen = Array("<![CDATA[".utf8), cdataClose = Array("]]>".utf8)
  private static let piOpen = Array("<?".utf8), piClose = Array("?>".utf8), declOpen = Array("<!".utf8)

  /// Empties the elements and attributes `rules` names (and drops comments if asked), leaving every
  /// other byte as it was: the same scanner as lib/docmeta.ts cleanXml, giving the same bytes.
  static func cleanXml(_ b: [UInt8], _ rules: XmlRules) -> [UInt8] {
    let elems = rules.elems.map(NamePattern.init)
    let attrs = rules.attrs.map(AttrPattern.init)
    let n = b.count
    var out = [UInt8]()
    out.reserveCapacity(n)
    var skip = 0   // > 0 inside an element being emptied: its depth
    func copy(_ from: Int, _ to: Int) {
      if skip == 0 && to > from { out.append(contentsOf: b[from..<to]) }
    }
    func until(_ seq: [UInt8], _ from: Int) -> Int {
      let e = find(b, seq, from)
      return e < 0 ? n : e + seq.count
    }
    var i = 0
    while i < n {
      let lt = indexOf(b, 0x3C, i)
      if lt < 0 {
        copy(i, n)
        break
      }
      copy(i, lt)
      if startsAt(b, lt, commentOpen) {
        let end = until(commentClose, lt + 4)
        if !rules.comments { copy(lt, end) }
        i = end
      } else if startsAt(b, lt, cdataOpen) {
        let end = until(cdataClose, lt + 9)
        copy(lt, end)
        i = end
      } else if startsAt(b, lt, piOpen) {
        let end = until(piClose, lt + 2)
        copy(lt, end)
        i = end
      } else if startsAt(b, lt, declOpen) {   // DOCTYPE, with an internal subset in [ ]
        var k = lt + 2
        var depth = 0
        while k < n {
          if b[k] == 0x5B { depth += 1 }
          else if b[k] == 0x5D { depth -= 1 }
          else if b[k] == 0x3E && depth <= 0 { break }
          k += 1
        }
        let end = k < n ? k + 1 : n
        copy(lt, end)
        i = end
      } else if lt + 1 < n && b[lt + 1] == 0x2F {   // end tag
        let gt = indexOf(b, 0x3E, lt)
        let end = gt < 0 ? n : gt + 1
        if skip > 0 {
          skip -= 1
          if skip == 0 { out.append(contentsOf: b[lt..<end]) }
        } else {
          copy(lt, end)
        }
        i = end
      } else {   // start tag
        var k = lt + 1
        while k < n && !isXmlSpace(b[k]) && b[k] != 0x2F && b[k] != 0x3E { k += 1 }
        let qname = b[(lt + 1)..<k]
        var drop: [Int] = []   // value spans to empty: start, end, start, end…
        var end = -1
        while k < n {
          let c = b[k]
          if c == 0x3E {
            end = k + 1
            break
          }
          if isXmlSpace(c) || c == 0x2F {
            k += 1
            continue
          }
          let ns = k
          while k < n && !isXmlSpace(b[k]) && b[k] != 0x3D && b[k] != 0x3E && b[k] != 0x2F { k += 1 }
          if k == ns { k += 1 }   // a stray '=': step over it
          let aname = b[ns..<k]
          while k < n && isXmlSpace(b[k]) { k += 1 }
          if k >= n || b[k] != 0x3D { continue }
          k += 1
          while k < n && isXmlSpace(b[k]) { k += 1 }
          if k >= n { continue }
          let q = b[k]
          if q != 0x22 && q != 0x27 { continue }
          let ve = indexOf(b, q, k + 1)
          if ve < 0 {
            k = n
            break
          }
          if skip == 0 && attrs.contains(where: { $0.matches(qname, aname, b[(k + 1)..<ve]) }) { drop.append(k + 1); drop.append(ve) }
          k = ve + 1
        }
        if end < 0 {   // unterminated: the rest as it is
          copy(lt, n)
          break
        }
        let selfClosing = b[end - 2] == 0x2F
        if skip > 0 {
          if !selfClosing { skip += 1 }
        } else {
          var from = lt
          var d = 0
          while d < drop.count {
            out.append(contentsOf: b[from..<drop[d]])
            from = drop[d + 1]
            d += 2
          }
          out.append(contentsOf: b[from..<end])
          if !selfClosing && elems.contains(where: { $0.matches(qname) }) { skip = 1 }
        }
        i = end
      }
    }
    return out
  }

  /// OOXML attributes naming people: comment and tracked-change authors, co-authors, shared users.
  static let ooxmlAttrs = [
    "w:author", "w:initials", "w15:author", "presenceInfo@providerId", "presenceInfo@userId",
    "person@displayName", "person@userId", "person@providerId", "cmAuthor@name", "cmAuthor@initials",
    "author@name", "author@initials", "author@userId", "author@providerId", "header@userName",
    "fileSharing@userName", "userInfo@name", "absPath@url",
  ]
  static let coreTags = ["dc:creator", "cp:lastModifiedBy", "dc:title", "dc:subject", "cp:keywords", "dc:description", "cp:category"]
  static let odfMeta = [
    "dc:creator", "meta:initial-creator", "dc:title", "dc:subject", "dc:description", "meta:keyword",
    "meta:user-defined", "meta:printed-by", "meta:generator",
  ]
  static let svgRules = XmlRules(
    elems: ["metadata", "i:pgf"],
    attrs: ["sodipodi:docname", "sodipodi:docbase", "sodipodi:version", "inkscape:export-filename", "inkscape:version"],
    comments: true
  )
  /// SVG files larger than this are stored as picked (they are cleaned whole, in memory).
  static let svgMax = 50 * 1024 * 1024

  /// A zip document's family: Office Open XML, OpenDocument or EPUB.
  enum ZipFormat { case ooxml, odf, epub }

  /// Which family a zip belongs to, from its part names and its "mimetype" part; nil: none.
  static func zipFormat(_ names: [String], _ mimetype: [UInt8]?) -> ZipFormat? {
    if names.contains(where: { Array($0.utf8) == Array("[Content_Types].xml".utf8) }) { return .ooxml }
    if let m = mimetype, startsAt(m, 0, Array("application/vnd.oasis.opendocument.".utf8)) { return .odf }
    if let m = mimetype, startsAt(m, 0, Array("application/epub+zip".utf8)) { return .epub }
    return nil
  }

  /// The rules for one part of a zip document, or nil to copy it as it is.
  static func xmlRules(_ format: ZipFormat, _ name: String) -> XmlRules? {
    let u = Array(name.utf8)
    func `is`(_ s: String) -> Bool { u == Array(s.utf8) }
    func ends(_ s: String) -> Bool { let t = Array(s.utf8); return u.count >= t.count && u.suffix(t.count).elementsEqual(t) }
    switch format {
    case .ooxml:
      if `is`("docProps/core.xml") { return XmlRules(elems: coreTags, attrs: []) }
      if `is`("docProps/app.xml") { return XmlRules(elems: ["Company", "Manager"], attrs: []) }
      if `is`("docProps/custom.xml") { return XmlRules(elems: ["vt:*"], attrs: []) }
      if ends(".rels") { return XmlRules(elems: [], attrs: ["Relationship@Target^file:"]) }
      if ends(".xml") && !`is`("[Content_Types].xml") { return XmlRules(elems: ["author"], attrs: ooxmlAttrs) }
      return nil
    case .odf:
      if `is`("meta.xml") { return XmlRules(elems: odfMeta, attrs: ["template@href", "template@title"]) }
      if `is`("content.xml") || `is`("styles.xml") { return XmlRules(elems: ["dc:creator", "meta:creator-initials"], attrs: []) }
      return nil
    case .epub:
      return ends(".opf") ? XmlRules(elems: ["dc:creator", "dc:contributor", "dc:publisher"], attrs: []) : nil
    }
  }

  /// Photos inside zip documents (lib/docmeta.ts ZIP_IMAGE): cleaned like photos added on their own.
  static func isZipImage(_ name: [UInt8]) -> Bool {
    let lower = name.map { $0 >= 0x41 && $0 <= 0x5A ? $0 + 0x20 : $0 }
    for ext in [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".gif"] {
      let t = Array(ext.utf8)
      if lower.count >= t.count && lower.suffix(t.count).elementsEqual(t) { return true }
    }
    return false
  }

  /// Parts larger than this (uncompressed) are copied as they are.
  static let partMax = 32 * 1024 * 1024

  // MARK: - RTF

  /// Drops the RTF groups in `drop` ({\author …}, {\*\company …}, …) as the file streams through;
  /// dates and everything else pass unchanged. Binary data (\binN) is passed over unread. The same
  /// machine as lib/docmeta.ts RtfCleaner, giving the same bytes whatever the piece sizes.
  struct RtfCleaner {
    private enum Mode { case normal, group, ctrl, skip, bin }

    static let drop: Set<String> = [
      "author", "operator", "title", "subject", "keywords", "doccomm", "comment", "company", "manager",
      "category", "hlinkbase", "userprops", "revtbl", "atnauthor", "atnid", "generator",
    ]

    private var mode = Mode.normal
    private var held: [UInt8] = []
    private var depth = 0
    private var escape = false
    private var bin = 0
    private var out: [UInt8] = []

    init() {}

    /// Feeds bytes in; returns the bytes that are final so far.
    mutating func push(_ input: [UInt8]) -> [UInt8] {
      out.reserveCapacity(out.count + input.count)
      var i = 0
      while i < input.count {
        if mode == .bin {   // binary data: passed over in one go
          let k = min(bin, input.count - i)
          out.append(contentsOf: input[i..<(i + k)])
          bin -= k
          i += k
          if bin == 0 { mode = .normal }
          continue
        }
        step(input[i])
        i += 1
      }
      return take()
    }

    /// Ends the stream: an unfinished group start or control word passes through as it is.
    mutating func finish() -> [UInt8] {
      if mode == .group || mode == .ctrl { out.append(contentsOf: held) }
      wipe(&held)
      mode = .normal
      return take()
    }

    private static func isLetter(_ c: UInt8) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
    private static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

    private mutating func step(_ c: UInt8) {
      switch mode {
      case .skip:
        if escape { escape = false }
        else if c == 0x5C { escape = true }
        else if c == 0x7B { depth += 1 }
        else if c == 0x7D { depth -= 1; if depth == 0 { mode = .normal } }
      case .group:   // after "{": a destination worth dropping?
        held.append(c)
        let n = held.count
        // held[0] = '{'; then '\' word, or '\' '*' '\' word
        let star = n >= 3 && held[2] == 0x2A
        let wordAt = star ? 4 : 2
        if n == 2 {
          if c != 0x5C { release() }
          return
        }
        if n == 3 {
          if c == 0x2A || Self.isLetter(c) { return }
          flush()   // an escaped symbol such as \{ or \'
          return
        }
        if star && n == 4 {
          if c != 0x5C { release() }
          return
        }
        if Self.isLetter(c) && n - wordAt <= 32 { return }
        let word = wordAt <= n - 1 ? String(decoding: held[wordAt..<(n - 1)], as: UTF8.self) : ""
        if !word.isEmpty && Self.drop.contains(word) {
          wipe(&held)
          mode = .skip
          depth = 1
          escape = false
          step(c)
          return
        }
        // kept: "{" (and "\*") out, the control word goes on as one outside a group start, so
        // {\binN is passed over like \binN
        out.append(contentsOf: held[0..<(wordAt - 1)])
        held = Array(held[(wordAt - 1)..<(n - 1)])
        mode = .ctrl
        step(c)
      case .ctrl:   // after "\" outside a group start: only \binN matters
        held.append(c)
        let n = held.count
        if n == 2 {
          if !Self.isLetter(c) { flush() }
          return
        }
        let prev = held[n - 2]
        let more = Self.isLetter(c) ? Self.isLetter(prev)
          : Self.isDigit(c) ? Self.isLetter(prev) || Self.isDigit(prev) || prev == 0x2D
          : c == 0x2D && Self.isLetter(prev)
        if more && n <= 48 { return }
        if let count = binCount(held[0..<(n - 1)]), count > 0 {
          out.append(contentsOf: held[0..<(n - 1)])
          wipe(&held)
          bin = count
          mode = .bin
          out.append(c)
          // a space ends the control word; any other byte is already the first byte of the data
          if c != 0x20 {
            bin -= 1
            if bin == 0 { mode = .normal }
          }
          return
        }
        release()
      case .normal, .bin:
        if c == 0x7B {
          mode = .group
          held = [c]
        } else if c == 0x5C {
          mode = .ctrl
          held = [c]
        } else {
          out.append(c)
        }
      }
    }

    /// N for exactly "\binN" (N saturating, as JavaScript's Number never overflows); nil otherwise.
    private func binCount(_ h: ArraySlice<UInt8>) -> Int? {
      let head: [UInt8] = [0x5C, 0x62, 0x69, 0x6E]   // \bin
      guard h.count > head.count, h.prefix(head.count).elementsEqual(head) else { return nil }
      var v = 0
      for c in h.dropFirst(head.count) {
        guard Self.isDigit(c) else { return nil }
        let d = Int(c) - 0x30
        v = v > (Int.max - d) / 10 ? Int.max : v * 10 + d
      }
      return v
    }

    /// Emits all held bytes but the last, which is looked at again in normal mode.
    private mutating func release() {
      let last = held.removeLast()
      out.append(contentsOf: held)
      wipe(&held)
      mode = .normal
      step(last)
    }

    /// Emits every held byte (an escaped symbol is complete).
    private mutating func flush() {
      out.append(contentsOf: held)
      wipe(&held)
      mode = .normal
    }

    private mutating func take() -> [UInt8] {
      let done = out
      wipe(&out)
      return done
    }
  }

  // MARK: - Zip documents

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
    var crc: UInt32, csize: Int, usize: Int
    var internalAttr: UInt16, externalAttr: UInt32, localOffset: Int
    var name: [UInt8]
    var dataStart = 0
    /// A photo, or an XML part with rules, that is small enough and compressed a known way.
    var cleanable = false
  }

  /// Writes the cleaned zip document (Office, OpenDocument or EPUB) through `emit` and returns true;
  /// or returns false, having emitted nothing, when the file should be stored as it is. A document
  /// zip is always rewritten, one entry in memory at a time, in its original entry order: photos and
  /// XML parts that change are written cleaned (photos stored, XML deflated unless that is no
  /// smaller); every other entry, and any part that cannot be read back exactly, is copied as it is.
  static func cleanOffice(_ src: RandomSource, emit: ([UInt8]) throws -> Void) throws -> Bool {
    guard let plan = try? planOffice(src) else { return false }
    let (entries, format) = plan

    var offset = 0
    var central = [UInt8]()
    for var e in entries.sorted(by: { $0.localOffset < $1.localOffset }) {
      var replacement = e.cleanable ? cleanEntry(src, e, format) : nil
      if let r = replacement {
        e.method = r.method
        e.flags &= ~0x0006   // deflate options: none
        e.crc = r.crc
        e.csize = r.bytes.count
        e.usize = r.usize
      }
      e.flags &= ~0x0008   // sizes and CRC are in the local header now, no data descriptor
      var local = [UInt8]()
      put32(&local, 0x0403_4B50); put16(&local, e.needed); put16(&local, e.flags); put16(&local, e.method)
      put16(&local, e.time); put16(&local, e.date); put32(&local, e.crc); put32(&local, UInt32(e.csize)); put32(&local, UInt32(e.usize))
      put16(&local, UInt16(e.name.count)); put16(&local, 0)
      local.append(contentsOf: e.name)
      try emit(local)
      if replacement != nil {
        try emit(replacement!.bytes)
        wipe(&replacement!.bytes)
      } else {
        var at = 0
        while at < e.csize {
          let n = min(1 << 20, e.csize - at)
          var part = try src.read(e.dataStart + at, n)
          try emit(part)
          wipe(&part)
          at += n
        }
      }
      put32(&central, 0x0201_4B50); put16(&central, e.madeBy); put16(&central, e.needed); put16(&central, e.flags)
      put16(&central, e.method); put16(&central, e.time); put16(&central, e.date); put32(&central, e.crc)
      put32(&central, UInt32(e.csize)); put32(&central, UInt32(e.usize)); put16(&central, UInt16(e.name.count))
      put16(&central, 0); put16(&central, 0); put16(&central, 0); put16(&central, e.internalAttr)
      put32(&central, e.externalAttr); put32(&central, UInt32(offset))
      central.append(contentsOf: e.name)
      offset += local.count + e.csize
      guard offset < 0xFFFF_FFFF else { throw Malformed() }   // planOffice made sure it fits
    }
    var end = [UInt8]()
    put32(&end, 0x0605_4B50); put16(&end, 0); put16(&end, 0)
    put16(&end, UInt16(entries.count)); put16(&end, UInt16(entries.count))
    put32(&end, UInt32(central.count)); put32(&end, UInt32(offset)); put16(&end, 0)
    try emit(central)
    try emit(end)
    return true
  }

  /// One entry, read, checked and cleaned; nil when it does not change or cannot be read exactly.
  private static func cleanEntry(_ src: RandomSource, _ e: Entry, _ format: ZipFormat)
    -> (bytes: [UInt8], method: UInt16, usize: Int, crc: UInt32)? {
    let photo = isZipImage(e.name)
    let rules = photo ? nil : xmlRules(format, String(decoding: e.name, as: UTF8.self))
    guard photo || rules != nil, var data = try? src.read(e.dataStart, e.csize) else { return nil }
    var raw: [UInt8]
    if e.method == 8 {
      let inflated = try? inflate(data, size: e.usize)
      wipe(&data)
      guard let r = inflated else { return nil }
      raw = r
    } else {
      raw = data
      data = []
    }
    defer { wipe(&raw) }
    guard crc32(raw) == e.crc else { return nil }
    var clean = photo ? CubeStrip.strip(raw) : cleanXml(raw, rules!)
    if clean == raw || clean.count > max(e.csize, e.usize) {   // unchanged, or larger than planned for
      wipe(&clean)
      return nil
    }
    let crc = crc32(clean), usize = clean.count
    if !photo, let d = deflate(clean), d.count < clean.count {
      wipe(&clean)
      return (d, 8, usize, crc)
    }
    return (clean, 0, usize, crc)
  }

  /// Reads the central directory (zip64 records included) and every local header, and finds the
  /// document's format; throws for anything not to be touched, before anything is written.
  private static func planOffice(_ src: RandomSource) throws -> ([Entry], ZipFormat) {
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
    var count = Int(u16(tail, eocd + 10))
    var cdSize = Int(u32(tail, eocd + 12)), cdOffset = Int(u32(tail, eocd + 16))
    guard u16(tail, eocd + 4) == 0, u16(tail, eocd + 6) == 0, u16(tail, eocd + 8) == u16(tail, eocd + 10) else { throw Malformed() }
    var cdLimit = eocdPos
    if eocdPos >= 20, try src.read(eocdPos - 20, 4) == [0x50, 0x4B, 0x06, 0x07] {   // zip64 locator
      let loc = try src.read(eocdPos - 20, 20)
      let recAt = try u64(loc, 8)
      guard u32(loc, 4) == 0, recAt + 56 <= eocdPos - 20 else { throw Malformed() }
      let rec = try src.read(recAt, 56)
      guard u32(rec, 0) == 0x0606_4B50, u32(rec, 16) == 0, u32(rec, 20) == 0,
            try u64(rec, 24) == u64(rec, 32) else { throw Malformed() }
      count = try u64(rec, 32)
      cdSize = try u64(rec, 40)
      cdOffset = try u64(rec, 48)
      cdLimit = recAt
    }
    // The output is a plain zip: no more than 0xFFFE entries.
    guard count > 0, count < 0xFFFF, cdOffset + cdSize <= cdLimit else { throw Malformed() }
    let cd = try src.read(cdOffset, cdSize)
    var entries: [Entry] = []
    var p = 0
    for _ in 0..<count {
      guard p + 46 <= cd.count, u32(cd, p) == 0x0201_4B50 else { throw Malformed() }
      let nameLen = Int(u16(cd, p + 28)), extraLen = Int(u16(cd, p + 30)), commentLen = Int(u16(cd, p + 32))
      guard p + 46 + nameLen + extraLen <= cd.count else { throw Malformed() }
      var e = Entry(
        madeBy: u16(cd, p + 4), needed: u16(cd, p + 6), flags: u16(cd, p + 8), method: u16(cd, p + 10),
        time: u16(cd, p + 12), date: u16(cd, p + 14), crc: u32(cd, p + 16), csize: Int(u32(cd, p + 20)),
        usize: Int(u32(cd, p + 24)), internalAttr: u16(cd, p + 36), externalAttr: u32(cd, p + 38),
        localOffset: Int(u32(cd, p + 42)), name: Array(cd[(p + 46)..<(p + 46 + nameLen)])
      )
      // zip64 extra field (0x0001): usize, csize, offset, each only where the 32-bit field is 0xFFFFFFFF
      var x = p + 46 + nameLen
      let xEnd = x + extraLen
      while x + 4 <= xEnd {
        let id = u16(cd, x), len = Int(u16(cd, x + 2))
        guard x + 4 + len <= xEnd else { break }
        if id == 0x0001 {
          var r = x + 4
          func next() throws -> Int {
            guard r + 8 <= x + 4 + len else { throw Malformed() }
            defer { r += 8 }
            return try u64(cd, r)
          }
          if e.usize == 0xFFFF_FFFF { e.usize = try next() }
          if e.csize == 0xFFFF_FFFF { e.csize = try next() }
          if e.localOffset == 0xFFFF_FFFF { e.localOffset = try next() }
        }
        x += 4 + len
      }
      // encrypted, or sizes that do not fit a plain zip: stored as picked
      guard e.flags & 1 == 0, e.csize < 0xFFFF_FFFF, e.usize < 0xFFFF_FFFF, e.localOffset < 0xFFFF_FFFF,
            e.localOffset + 30 <= cdOffset else { throw Malformed() }
      let head = try src.read(e.localOffset, 30)
      guard u32(head, 0) == 0x0403_4B50 else { throw Malformed() }
      e.dataStart = e.localOffset + 30 + Int(u16(head, 26)) + Int(u16(head, 28))
      guard e.dataStart + e.csize <= size else { throw Malformed() }
      entries.append(e)
      p += 46 + nameLen + extraLen + commentLen
    }
    let names = entries.map { String(decoding: $0.name, as: UTF8.self) }
    var mimetype: [UInt8]? = nil
    if let m = entries.first(where: { $0.name == Array("mimetype".utf8) }) {
      if m.method == 0 { mimetype = try? src.read(m.dataStart, min(m.csize, 256)) }
      else if m.method == 8, m.usize <= 1 << 20, let data = try? src.read(m.dataStart, m.csize) { mimetype = try? inflate(data, size: m.usize) }
    }
    guard let format = zipFormat(names, mimetype) else { throw Malformed() }   // a zip, not a document
    // What the rewritten zip can grow to (a cleaned part is never larger than max(csize, usize)): it
    // must fit a plain zip.
    var total = 22
    for k in entries.indices {
      let e = entries[k]
      entries[k].cleanable = e.usize <= partMax && (e.method == 0 || e.method == 8)
        && (isZipImage(e.name) || xmlRules(format, names[k]) != nil)
      total += 30 + e.name.count + (entries[k].cleanable ? max(e.csize, e.usize) : e.csize) + 46 + e.name.count
    }
    guard total < 0xFFFF_FFFF else { throw Malformed() }
    return (entries, format)
  }

  /// Raw DEFLATE (as zip stores it) of exactly `size` bytes.
  static func inflate(_ data: [UInt8], size: Int) throws -> [UInt8] {
    if size == 0 { return [] }
    if data.isEmpty { throw Malformed() }
    var out = [UInt8](repeating: 0, count: size + 1)   // one spare byte shows an overlong stream
    let n = data.withUnsafeBufferPointer { src in
      out.withUnsafeMutableBufferPointer { dst in
        compression_decode_buffer(dst.baseAddress!, dst.count, src.baseAddress!, src.count, nil, COMPRESSION_ZLIB)
      }
    }
    guard n == size else { wipe(&out); throw Malformed() }
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
  /// A 64-bit little-endian size or offset; throws if it is beyond any real file.
  private static func u64(_ b: [UInt8], _ i: Int) throws -> Int {
    let hi = u32(b, i + 4)
    guard hi < 0x4000_0000 else { throw Malformed() }
    return Int(hi) << 32 | Int(u32(b, i))
  }
  private static func put16(_ b: inout [UInt8], _ v: UInt16) { b.append(UInt8(v & 0xFF)); b.append(UInt8(v >> 8)) }
  private static func put32(_ b: inout [UInt8], _ v: UInt32) {
    for k in 0..<4 { b.append(UInt8((v >> (8 * UInt32(k))) & 0xFF)) }
  }
}
