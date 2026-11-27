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
///   (CubeStrip); XML parts too large to hold whole stream through XmlCleaner. Every other entry is
///   copied byte for byte, still compressed. Anything unusual
///   (encryption, not a document zip, sizes that need zip64 on the way out) leaves the file as it
///   was picked.
/// - Office 97–2003 (OLE compound files): cfbPatches empties the summary properties, PowerPoint's
///   current user and Excel's WriteAccess name, in same-length patches.
/// - RTF: RtfCleaner drops \info fields, revision and comment authors and the generator as the file
///   streams through.
/// - SVG: cleanXml (or XmlCleaner, streaming) with svgRules (comments, <metadata>, editor attributes
///   holding file paths).
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

  /// The same streams and patches as lib/docmeta.ts pdfStreamPatches: compressed object streams
  /// (/Type /ObjStm) and XMP streams (/Type /Metadata) whose contents PdfCleaner changes are decoded
  /// (Flate, LZW, ASCII85, ASCIIHex and run-length, alone or chained; PNG predictors undone),
  /// cleaned, encoded again with the same filters and written back at the same offset, padded with
  /// newlines, with the /Length number rewritten (spaces after it), where the dictionary has it or in
  /// the object an indirect /Length points to (a length kept inside an object stream stays, the
  /// newlines then inside the stream). JPEG photos (/DCTDecode) get their Exif, XMP, IPTC and comment
  /// segments zeroed. Anything unusual is left alone.
  static func pdfStreamPatches(_ src: RandomSource) -> [Patch] {
    var patches: [Patch] = []
    var pending: [Pending] = []
    var ints: [String: Int] = [:]
    let step = 1 << 20
    let kw = Array("stream".utf8)
    var start = 0
    while start < src.size {
      guard let win = try? src.read(start, min(step + kw.count, src.size - start)) else { break }
      var i = 0
      while i < min(step, win.count) && i + kw.count <= win.count {
        if win[i] == 0x73 && win[i..<(i + kw.count)].elementsEqual(kw) {
          streamPatch(src, start + i, &patches, &pending, &ints, first: true, given: nil)
        }
        i += 1
      }
      start += step
    }
    if !pending.isEmpty {
      let lengths = indirectLengths(src, Set(pending.map { $0.ref }))
      var none: [Pending] = []
      var noInts: [String: Int] = [:]
      for x in pending {
        if let len = lengths[x.ref] ?? ints[x.ref].map({ Length(value: $0, at: -1, digits: 0) }) {
          streamPatch(src, x.p, &patches, &none, &noInts, first: false, given: len)
        }
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

  /// Finds "n g obj <integer> endobj" for each wanted "n g" (the last definition wins). Lengths kept
  /// inside object streams come from objStmIntegers instead.
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
                                  _ ints: inout [String: Int], first: Bool, given: Length?) {
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
    guard find(#"/Type\#(ws)*/(ObjStm|Metadata)(?![A-Za-z0-9])"#) != nil, let chain = filterChain(dict),
          let (columns, early) = decodeParms(dict, chain) else { return }
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
    guard var data = try? src.read(dataStart, L) else { return }
    guard var stored = decodeChain(data, chain, early) else { wipe(&data); return }
    defer { wipe(&data); wipe(&stored) }
    var plain: [UInt8]
    if columns > 0 {
      guard let u = unpredict(stored, columns) else { return }
      plain = u
    } else {
      plain = stored
    }
    defer { wipe(&plain) }
    if first && find(#"/Type\#(ws)*/ObjStm"#) != nil { objStmIntegers(dict, plain, &ints) }
    var c = PdfCleaner()
    var clean = c.push(plain) + c.finish()
    defer { wipe(&clean) }
    if clean == plain { return }
    // The blanked strings and runs of white space are shortened first (an object stream's offsets
    // rewritten to match), so the result fits even where Cube's compressor does worse than the one that
    // wrote the file, and comes out the same whichever compressor runs (JavaScript's or the platform's).
    var short = compact(clean, dict, columns)
    let body = short ?? clean
    var rows = columns > 0 ? predictNone(body, columns) : body
    let z = encodeChain(rows, chain, early)
    wipe(&rows)
    if short != nil { wipe(&short!) }
    guard let z = z, z.count <= L else { return }   // cannot fit: left as it is
    var bytes = [UInt8](repeating: 0x0A, count: L)
    bytes.replaceSubrange(0..<z.count, with: z)
    patches.append(Patch(at: dataStart, bytes: bytes))
    // a length kept inside an object stream stays: the newlines after the data are then inside the
    // stream, where every decoder stops at the end of its data
    if len.at >= 0 {
      let s = Array(String(z.count).utf8)
      patches.append(Patch(at: len.at, bytes: s + [UInt8](repeating: 0x20, count: max(0, len.digits - s.count))))
    }
  }

  /// The stream's decode parameters, one dictionary (or null) per filter: a PNG predictor (10–15, one
  /// 8-bit colour) is allowed on the last filter only, when it is Flate or LZW; /EarlyChange 0 or 1 on
  /// LZW (the same for every LZW filter). Nil for anything else.
  private static func decodeParms(_ dict: String, _ chain: [Filter]) -> (columns: Int, early: Int)? {
    let ns = dict as NSString
    let all = NSRange(location: 0, length: ns.length)
    if regex(#"/DecodeParms"#)?.firstMatch(in: dict, range: all) == nil { return (0, 1) }
    var entries: [String?]
    let one = regex(#"/DecodeParms\#(ws)*<<([^<>]*)>>"#)?.firstMatch(in: dict, range: all)
    let list = regex(#"/DecodeParms\#(ws)*\[((?:\#(ws)*(?:null|<<[^<>]*>>))*)\#(ws)*\]"#)?.firstMatch(in: dict, range: all)
    if let one = one {
      if chain.count != 1 { return nil }
      entries = [ns.substring(with: one.range(at: 1))]
    } else if let list = list {
      let body = ns.substring(with: list.range(at: 1))
      let bns = body as NSString
      entries = (regex(#"null|<<([^<>]*)>>"#)?.matches(in: body, range: NSRange(location: 0, length: bns.length)) ?? []).map {
        bns.substring(with: $0.range) == "null" ? nil : bns.substring(with: $0.range(at: 1))
      }
      if entries.count != chain.count { return nil }
    } else {
      return nil
    }
    var columns = 0
    var early = -1
    for i in 0..<chain.count {
      guard let e = entries[i], !e.unicodeScalars.allSatisfy({ $0.value < 256 && isJsSpace(UInt8($0.value)) }) else { continue }
      if chain[i] != .flate && chain[i] != .lzw { return nil }
      func num(_ key: String, _ dflt: Int) -> Int {
        let ens = e as NSString
        guard let m = regex(#"/\#(key)\#(ws)+(\d+)"#)?.firstMatch(in: e, range: NSRange(location: 0, length: ens.length)) else { return dflt }
        return number(ens.substring(with: m.range(at: 1)))
      }
      if chain[i] == .lzw {
        let ec = num("EarlyChange", 1)
        if ec > 1 || (early >= 0 && ec != early) { return nil }
        early = ec
      }
      let predictor = num("Predictor", 1)
      if predictor == 1 { continue }
      if i != chain.count - 1 || predictor < 10 || predictor > 15 || num("Colors", 1) != 1 || num("BitsPerComponent", 8) != 8 { return nil }
      columns = num("Columns", 1)
      if columns < 1 || columns > streamMax { return nil }
    }
    return (columns, early < 0 ? 1 : early)
  }

  /// A number as JavaScript writes it (`${x}`), for the integers compact puts in an object stream's header.
  private static func jsString(_ x: Double) -> String {
    if x == x.rounded() && abs(x) < 1e21 { return String(format: "%.0f", x == 0 ? 0 : x) }
    return "\(x)"
  }

  /// JavaScript's latin1(b).trim().split(/\s+/).map(Number).
  private static func jsNumbers(_ b: ArraySlice<UInt8>) -> [Double] {
    var nums: [Double] = []
    var token: [UInt8] = []
    for c in b {
      if isJsSpace(c) {
        if !token.isEmpty { nums.append(jsNumber(token)); token.removeAll(keepingCapacity: true) }
      } else {
        token.append(c)
      }
    }
    if !token.isEmpty { nums.append(jsNumber(token)) }
    return nums.isEmpty ? [0] : nums   // Number("")
  }

  /// A shorter form of cleaned stream contents, or nil. XMP: runs of white space become one space.
  /// Object streams: in each object, a blanked string (only spaces, or hex for spaces) becomes empty
  /// and runs of white space outside strings become one space; the offsets at the start are rewritten
  /// (padded with spaces to the same /First). Padded with spaces to whole predictor rows.
  static func compact(_ clean: [UInt8], _ dict: String, _ columns: Int) -> [UInt8]? {
    let ns = dict as NSString
    let all = NSRange(location: 0, length: ns.length)
    var out: [UInt8]
    if regex(#"/Type\#(ws)*/Metadata"#)?.firstMatch(in: dict, range: all) != nil {
      out = squeeze(clean[...], false)
    } else {
      guard let n = regex(#"/N\#(ws)+(\d+)"#)?.firstMatch(in: dict, range: all),
            let first = regex(#"/First\#(ws)+(\d+)"#)?.firstMatch(in: dict, range: all) else { return nil }
      let F = number(ns.substring(with: first.range(at: 1)))
      if F > clean.count { return nil }
      let nums = jsNumbers(clean[0..<F])
      let count = number(ns.substring(with: n.range(at: 1)))
      if count > nums.count || nums.count < 2 * count || nums.contains(where: { !($0.isFinite && $0 == $0.rounded() && $0 >= 0) }) { return nil }
      var parts: [[UInt8]] = []
      var header = ""
      var at = 0
      for i in 0..<count {
        let from = Double(F) + nums[2 * i + 1]
        let to = i + 1 < count ? Double(F) + nums[2 * i + 3] : Double(clean.count)
        if from > to || to > Double(clean.count) { return nil }
        let obj = squeeze(clean[Int(from)..<Int(to)], true)
        header += "\(jsString(nums[2 * i])) \(at) "
        parts.append(obj)
        at += obj.count
      }
      let h = Array(header.utf8)
      if h.count > F { return nil }
      out = h + [UInt8](repeating: 0x20, count: F - h.count)
      for var x in parts { out += x; wipe(&x) }
    }
    if columns > 0 && out.count % columns != 0 { out += [UInt8](repeating: 0x20, count: columns - out.count % columns) }
    if out.count < clean.count { return out }
    wipe(&out)
    return nil
  }

  /// Runs of white space become one space; with `pdf`, outside strings only (comments are copied as
  /// they are), and strings that are only spaces, or hex strings of only "20", become empty.
  private static func squeeze(_ s: ArraySlice<UInt8>, _ pdf: Bool) -> [UInt8] {
    let b = Array(s)
    // a fixed-size output, as in JavaScript: writes past its end are dropped, and a string cut short
    // by a final backslash counts one byte more than it copies (a zero then, if there is room)
    var out = [UInt8](repeating: 0, count: b.count)
    var n = 0
    func put(_ c: UInt8) { if n < out.count { out[n] = c }; n += 1 }
    func copy(_ from: Int, _ to: Int) {
      let end = min(to, b.count)
      if from < end { for k in from..<end where n + k - from < out.count { out[n + k - from] = b[k] } }
      n += to - from
    }
    var space = false
    var i = 0
    while i < b.count {
      let c = b[i]
      if isPdfWhite(c) && c != 0x00 {
        if !space { put(0x20) }
        space = true
        i += 1
        continue
      }
      space = false
      if pdf && c == 0x25 {   // %: a comment, to the end of the line
        while i < b.count && b[i] != 0x0A && b[i] != 0x0D { put(b[i]); i += 1 }
        continue
      }
      if pdf && c == 0x28 {   // (: a literal string
        var depth = 1
        var j = i + 1
        var blank = true
        while j < b.count && depth > 0 {
          if b[j] == 0x5C { blank = false; j += 2; continue }
          if b[j] == 0x28 { depth += 1 } else if b[j] == 0x29 { depth -= 1 }
          if depth > 0 && b[j] != 0x20 { blank = false }
          j += 1
        }
        if blank && depth == 0 {
          put(0x28)
          put(0x29)
        } else {
          copy(i, j)
        }
        i = j
        continue
      }
      if pdf && c == 0x3C && (i + 1 >= b.count || b[i + 1] != 0x3C) {   // <: a hex string (<< is a dictionary)
        guard let j = b[(i + 1)...].firstIndex(of: 0x3E) else {
          copy(i, b.count)
          break
        }
        let hex = b[(i + 1)..<j].filter { !isJsSpace($0) }
        var twenties = !hex.isEmpty && hex.count % 2 == 0
        if twenties { for k in stride(from: 0, to: hex.count, by: 2) where hex[k] != 0x32 || hex[k + 1] != 0x30 { twenties = false; break } }
        if twenties {
          put(0x3C)
          put(0x3E)
        } else {
          copy(i, j + 1)
        }
        i = j + 1
        continue
      }
      if pdf && c == 0x3C {   // <<
        put(0x3C)
        put(0x3C)
        i += 2
        continue
      }
      put(c)
      i += 1
    }
    var b2 = b
    wipe(&b2)
    let result = Array(out[0..<min(n, out.count)])
    wipe(&out)
    return result
  }

  private static func isPdfWhite(_ c: UInt8) -> Bool { c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 || c == 0x0C || c == 0x00 }
  /// JavaScript's \s within Latin-1.
  private static func isJsSpace(_ c: UInt8) -> Bool { c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 }

  /// A token as JavaScript's Number() reads it (decimal, 0x/0o/0b integers, Infinity); NaN otherwise.
  private static func jsNumber(_ t: [UInt8]) -> Double {
    let s = String(decoding: t, as: UTF8.self)
    if s.isEmpty { return 0 }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] where s.hasPrefix(prefix) {
      let digits = s.dropFirst(2)
      if digits.isEmpty { return .nan }
      var v = 0.0
      for c in digits {
        guard let d = c.hexDigitValue, d < radix else { return .nan }
        v = v * Double(radix) + Double(d)
      }
      return v
    }
    if s == "Infinity" || s == "+Infinity" { return .infinity }
    if s == "-Infinity" { return -.infinity }
    guard let re = regex(#"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"#),
          re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil else { return .nan }
    return Double(s) ?? .nan
  }

  /// "n 0" → value for each object of an object stream that is just an integer (a stream length).
  private static func objStmIntegers(_ dict: String, _ plain: [UInt8], _ ints: inout [String: Int]) {
    let ns = dict as NSString
    let range = NSRange(location: 0, length: ns.length)
    guard let n = regex(#"/N\#(ws)+(\d+)"#)?.firstMatch(in: dict, range: range),
          let first = regex(#"/First\#(ws)+(\d+)"#)?.firstMatch(in: dict, range: range) else { return }
    let count0 = number(ns.substring(with: n.range(at: 1)))
    let start = number(ns.substring(with: first.range(at: 1)))
    if start > plain.count || count0 > 1_000_000 { return }
    var nums: [Double] = []
    var token: [UInt8] = []
    for c in plain[0..<start] {
      if isJsSpace(c) {
        if !token.isEmpty { nums.append(jsNumber(token)); token.removeAll(keepingCapacity: true) }
      } else {
        token.append(c)
      }
    }
    if !token.isEmpty { nums.append(jsNumber(token)) }
    if nums.isEmpty { nums = [0] }   // Number("")
    let count = min(count0, nums.count / 2)
    let size = Double(plain.count)
    for i in 0..<count {
      let from = Double(start) + nums[2 * i + 1]
      let to = i + 1 < count ? Double(start) + nums[2 * i + 3] : size
      if !(from >= 0 && to <= size && from <= to) || to - from > 32 { continue }
      let b = plain[Int(from)..<Int(to)]
      // /^\s*(\d+)\s*$/
      var k = b.startIndex
      while k < b.endIndex && isJsSpace(b[k]) { k += 1 }
      let d0 = k
      while k < b.endIndex && b[k] >= 0x30 && b[k] <= 0x39 { k += 1 }
      let d1 = k
      while k < b.endIndex && isJsSpace(b[k]) { k += 1 }
      if d1 == d0 || k != b.endIndex { continue }
      let obj = nums[2 * i]
      // only an integral object number can match a pending "n g" (formatted as JavaScript would)
      guard obj.rounded() == obj, abs(obj) < 1e21 else { continue }
      let name = abs(obj) < 9e18 ? String(Int64(obj)) : String(format: "%.0f", obj)
      ints["\(name) 0"] = number(String(decoding: b[d0..<d1], as: UTF8.self))
    }
  }

  // MARK: - PDF stream filters

  enum Filter: String { case flate = "FlateDecode", lzw = "LZWDecode", a85 = "ASCII85Decode", hex = "ASCIIHexDecode", rl = "RunLengthDecode" }

  /// The stream's filters, in decoding order; nil without one, or with one Cube cannot redo.
  private static func filterChain(_ dict: String) -> [Filter]? {
    let ns = dict as NSString
    guard let m = regex(#"/Filter\#(ws)*(?:/([A-Za-z0-9]+)|\[([^\]]*)\])"#)?.firstMatch(in: dict, range: NSRange(location: 0, length: ns.length))
    else { return nil }
    var names: [String] = []
    if m.range(at: 1).location != NSNotFound {
      names = [ns.substring(with: m.range(at: 1))]
    } else {
      let list = ns.substring(with: m.range(at: 2))
      let lns = list as NSString
      for x in regex(#"/[A-Za-z0-9]+"#)?.matches(in: list, range: NSRange(location: 0, length: lns.length)) ?? [] {
        names.append(String(lns.substring(with: x.range).dropFirst()))
      }
    }
    if names.isEmpty || names.count > 4 { return nil }
    var chain: [Filter] = []
    for x in names {
      guard let f = Filter(rawValue: x) else { return nil }
      chain.append(f)
    }
    return chain
  }

  /// A stream's data through its filters; nil if any of them finds it malformed.
  static func decodeChain(_ data: [UInt8], _ chain: [Filter], _ early: Int = 1) -> [UInt8]? {
    var b = data
    for (i, f) in chain.enumerated() {
      let next: [UInt8]?
      switch f {
      case .flate: next = flateDecode(b)
      case .lzw: next = lzwDecode(b, early)
      case .a85: next = a85Decode(b)
      case .hex: next = hexDecode(b)
      case .rl: next = rlDecode(b)
      }
      if i > 0 { wipe(&b) }
      guard var n = next else { return nil }
      if n.count > streamMax { wipe(&n); return nil }
      b = n
    }
    return b
  }

  /// Plain bytes encoded for the same filters (the last filter first); nil if Flate fails.
  static func encodeChain(_ plain: [UInt8], _ chain: [Filter], _ early: Int = 1) -> [UInt8]? {
    var b = plain
    for (i, f) in chain.enumerated().reversed() {
      let next: [UInt8]?
      switch f {
      case .flate: next = zlib(b)
      case .lzw: next = lzwEncode(b, early)
      case .a85: next = a85Encode(b)
      case .hex: next = hexEncode(b)
      case .rl: next = rlEncode(b)
      }
      if i < chain.count - 1 { wipe(&b) }
      guard let n = next else { return nil }
      b = n
    }
    return b
  }

  private static func flateDecode(_ data: [UInt8]) -> [UInt8]? {
    guard data.count >= 6, data[0] & 0x0F == 8, (Int(data[0]) << 8 | Int(data[1])) % 31 == 0 else { return nil }
    return unzlib(data)   // Adler-32 checked, up to streamMax
  }

  private static func hexValue(_ c: UInt8) -> Int {
    c >= 0x30 && c <= 0x39 ? Int(c) - 0x30 : c >= 0x41 && c <= 0x46 ? Int(c) - 0x37 : c >= 0x61 && c <= 0x66 ? Int(c) - 0x57 : -1
  }

  static func hexDecode(_ b: [UInt8]) -> [UInt8]? {
    var out: [UInt8] = []
    out.reserveCapacity(b.count / 2 + 1)
    var hi = -1
    for c in b {
      if c == 0x3E { break }   // ">": the end
      if isPdfWhite(c) { continue }
      let v = hexValue(c)
      if v < 0 { return nil }
      if hi < 0 { hi = v }
      else {
        out.append(UInt8(hi * 16 + v))
        hi = -1
      }
    }
    if hi >= 0 { out.append(UInt8(hi * 16)) }
    return out
  }

  static func hexEncode(_ b: [UInt8]) -> [UInt8] {
    let d = Array("0123456789ABCDEF".utf8)
    var out = [UInt8](repeating: 0, count: b.count * 2 + 1)
    for i in 0..<b.count {
      out[2 * i] = d[Int(b[i] >> 4)]
      out[2 * i + 1] = d[Int(b[i] & 15)]
    }
    out[b.count * 2] = 0x3E
    return out
  }

  static func a85Decode(_ b: [UInt8]) -> [UInt8]? {
    var out: [UInt8] = []
    out.reserveCapacity(b.count)
    var i = 0
    while i < b.count && isPdfWhite(b[i]) { i += 1 }
    if i + 1 < b.count && b[i] == 0x3C && b[i + 1] == 0x7E { i += 2 }   // "<~"
    var group: [Int] = []
    while i < b.count {
      let c = b[i]
      i += 1
      if isPdfWhite(c) { continue }
      if c == 0x7E { break }   // "~>": the end
      if c == 0x7A && group.isEmpty {   // "z": four zeros
        out += [0, 0, 0, 0]
        if out.count > streamMax { return nil }
        continue
      }
      if c < 0x21 || c > 0x75 { return nil }
      group.append(Int(c) - 0x21)
      if group.count == 5 {
        var v = 0
        for x in group { v = v * 85 + x }
        if v > 0xFFFF_FFFF { return nil }
        out += [UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
        group.removeAll(keepingCapacity: true)
      }
    }
    if group.count == 1 { return nil }
    if group.count > 1 {
      let k = group.count
      while group.count < 5 { group.append(84) }
      var v = 0
      for x in group { v = v * 85 + x }
      if v > 0xFFFF_FFFF { return nil }
      for j in 0..<(k - 1) { out.append(UInt8((v >> (24 - 8 * j)) & 0xFF)) }
    }
    return out
  }

  static func a85Encode(_ b: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity((b.count + 3) / 4 * 5 + 2)
    var i = 0
    while i < b.count {
      let n = min(4, b.count - i)
      var v = 0
      for k in 0..<4 { v = v * 256 + (k < n ? Int(b[i + k]) : 0) }
      i += 4
      if n == 4 && v == 0 {
        out.append(0x7A)
        continue
      }
      var c = [UInt8](repeating: 0, count: 5)
      for k in stride(from: 4, through: 0, by: -1) {
        c[k] = UInt8(v % 85 + 0x21)
        v /= 85
      }
      out += c[0..<(n + 1)]
    }
    out += [0x7E, 0x3E]
    return out
  }

  static func rlDecode(_ b: [UInt8]) -> [UInt8]? {
    var out: [UInt8] = []
    out.reserveCapacity(b.count * 2)
    var i = 0
    while i < b.count {
      let n = Int(b[i])
      i += 1
      if n == 128 { break }
      if n < 128 {
        if i + n + 1 > b.count { return nil }
        out += b[i..<(i + n + 1)]
        i += n + 1
      } else {
        if i >= b.count { return nil }
        out += [UInt8](repeating: b[i], count: 257 - n)
        i += 1
      }
      if out.count > streamMax { return nil }
    }
    return out
  }

  static func rlEncode(_ b: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(b.count + b.count / 64 + 2)
    var i = 0
    while i < b.count {
      var r = 1
      while i + r < b.count && r < 128 && b[i + r] == b[i] { r += 1 }
      if r >= 2 {
        out.append(UInt8(257 - r))
        out.append(b[i])
        i += r
        continue
      }
      var j = i + 1
      while j < b.count && j - i < 128 && !(j + 1 < b.count && b[j] == b[j + 1]) { j += 1 }
      out.append(UInt8(j - i - 1))
      out += b[i..<j]
      i = j
    }
    out.append(128)
    return out
  }

  /// LZW as PDF uses it: 9- to 12-bit codes, 256 clears the table, 257 ends; `early` is /EarlyChange.
  static func lzwDecode(_ b: [UInt8], _ early: Int) -> [UInt8]? {
    var prefix = [Int](repeating: 0, count: 4096)
    var suffix = [UInt8](repeating: 0, count: 4096)
    var length = [Int](repeating: 0, count: 4096)
    var first = [UInt8](repeating: 0, count: 4096)
    for i in 0..<256 {
      prefix[i] = -1
      suffix[i] = UInt8(i)
      length[i] = 1
      first[i] = UInt8(i)
    }
    var out: [UInt8] = []
    out.reserveCapacity(min(b.count * 3, streamMax))
    func emit(_ code: Int) -> Bool {
      let n = length[code]
      if out.count + n > streamMax { return false }
      let base = out.count
      out += repeatElement(0, count: n)
      var k = base + n - 1, c = code
      while k >= base {
        out[k] = suffix[c]
        k -= 1
        c = prefix[c]
      }
      return true
    }
    var width = 9
    var next = 258
    var prev = -1
    let bits = b.count * 8
    var bit = 0
    while bit + width <= bits {
      var code = 0
      for _ in 0..<width {
        code = code << 1 | Int((b[bit >> 3] >> (7 - UInt8(bit & 7))) & 1)
        bit += 1
      }
      if code == 256 {
        width = 9
        next = 258
        prev = -1
        continue
      }
      if code == 257 { break }
      if prev < 0 {
        if code > 255 { return nil }
        if !emit(code) { return nil }
        prev = code
        continue
      }
      if code > next || (code == next && next >= 4096) { return nil }
      let head = code < next ? first[code] : first[prev]
      if next < 4096 {
        prefix[next] = prev
        suffix[next] = head
        length[next] = length[prev] + 1
        first[next] = first[prev]
        next += 1
      }
      if !emit(code) { return nil }
      prev = code
      if next + early >= 1 << width && width < 12 { width += 1 }
    }
    return out
  }

  static func lzwEncode(_ b: [UInt8], _ early: Int) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(b.count + 16)
    var acc = 0
    var accBits = 0
    var width = 9
    var decoderNext = 258   // the decoder's table size, which decides the code width
    var fresh = true        // the next code is the first after a clear (the decoder adds nothing)
    func put(_ code: Int) {
      acc = acc << width | code
      accBits += width
      while accBits >= 8 {
        out.append(UInt8((acc >> (accBits - 8)) & 0xFF))
        accBits -= 8
      }
      acc &= (1 << accBits) - 1
      if code == 256 {
        width = 9
        decoderNext = 258
        fresh = true
        return
      }
      if code == 257 { return }
      if !fresh && decoderNext < 4096 { decoderNext += 1 }
      fresh = false
      if decoderNext + early >= 1 << width && width < 12 { width += 1 }
    }
    put(256)
    if !b.isEmpty {
      // (prefix code, next byte) → code; -1: not in the table
      var table = [Int16](repeating: -1, count: 4096 * 256)
      var used: [Int] = []
      used.reserveCapacity(4096)
      var next = 258
      var w = Int(b[0])
      for i in 1..<b.count {
        let key = w * 256 + Int(b[i])
        let got = table[key]
        if got >= 0 {
          w = Int(got)
          continue
        }
        put(w)
        if next < 4096 {
          table[key] = Int16(next)
          used.append(key)
          next += 1
        }
        if next == 4096 {
          put(256)
          for k in used { table[k] = -1 }
          used.removeAll(keepingCapacity: true)
          next = 258
        }
        w = Int(b[i])
      }
      put(w)
    }
    put(257)
    if accBits > 0 { out.append(UInt8((acc << (8 - accBits)) & 0xFF)) }
    return out
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

  /// JPEG segments zeroed in photos inside PDFs and in motion-JPEG video frames (lib/mediameta.ts):
  /// APP1 (Exif, XMP), APP3–APP13 (IPTC…), APP15 and comments. JFIF/AVI1 (APP0), the colour profile
  /// (APP2) and Adobe (APP14) segments stay.
  private static func blankSegment(_ m: UInt8) -> Bool { m == 0xE1 || (m >= 0xE3 && m <= 0xED) || m == 0xEF || m == 0xFE }

  /// Zeroes the identifying segments of the JPEG at `at` (up to its image data), in place.
  static func jpegPatches(_ src: RandomSource, _ at: Int, _ patches: inout [Patch]) {
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
  /// other byte as it was: the same scanner as lib/docmeta.ts cleanXml, giving the same bytes (one
  /// push and finish of XmlCleaner).
  static func cleanXml(_ b: [UInt8], _ rules: XmlRules) -> [UInt8] {
    var c = XmlCleaner(rules)
    let head = c.push(b)
    let tail = c.finish()
    return tail.isEmpty ? head : head + tail
  }

  /// Markup longer than this that has not ended yet is copied as it is (as at the end of the input).
  static let xmlCarryMax = 16 * 1024 * 1024

  /// cleanXml a piece at a time, for parts too large to hold whole (lib/docmeta.ts XmlCleaner): each
  /// push returns what is final; markup cut by the end of a piece waits for the next one (up to
  /// xmlCarryMax). Pieces of any size give the same bytes as cleanXml on the whole.
  struct XmlCleaner {
    private let elems: [NamePattern]
    private let attrs: [AttrPattern]
    private let comments: Bool
    private var carry: [UInt8] = []
    private var skip = 0   // > 0 inside an element being emptied: its depth

    init(_ rules: XmlRules) {
      elems = rules.elems.map(NamePattern.init)
      attrs = rules.attrs.map(AttrPattern.init)
      comments = rules.comments
    }

    mutating func push(_ input: [UInt8]) -> [UInt8] {
      let joined = !carry.isEmpty
      var b = joined ? carry + input : input
      if joined { wipe(&carry) }
      let (out, rest) = scan(b, false)
      carry = rest >= b.count ? [] : Array(b[rest...])
      if joined { wipe(&b) }
      if carry.count > xmlCarryMax {   // markup that never ends: as at the end of the input
        let more = scan(carry, true).out
        wipe(&carry)
        return out + more
      }
      return out
    }

    mutating func finish() -> [UInt8] {
      if carry.isEmpty { return [] }
      let out = scan(carry, true).out
      wipe(&carry)
      return out
    }

    /// Scans b; unless `final`, stops at markup that does not end within b (rest: where it starts).
    private mutating func scan(_ b: [UInt8], _ final: Bool) -> (out: [UInt8], rest: Int) {
      let n = b.count
      var out = [UInt8]()
      out.reserveCapacity(n)
      var skip = self.skip
      defer { self.skip = skip }
      func copy(_ from: Int, _ to: Int) {
        if skip == 0 && to > from { out.append(contentsOf: b[from..<to]) }
      }
      /// The end of `seq` from `from`, or -1 if b ends first.
      func until(_ seq: [UInt8], _ from: Int) -> Int {
        let e = find(b, seq, from)
        return e < 0 ? -1 : e + seq.count
      }
      var i = 0
      while i < n {
        let lt = indexOf(b, 0x3C, i)
        if lt < 0 {
          copy(i, n)
          break
        }
        copy(i, lt)
        if !final && lt + 9 > n { return (out, lt) }   // too little to tell which markup this is
        if startsAt(b, lt, commentOpen) {
          let e = until(commentClose, lt + 4)
          if e < 0 && !final { return (out, lt) }
          let end = e < 0 ? n : e
          if !comments { copy(lt, end) }
          i = end
        } else if startsAt(b, lt, cdataOpen) {
          let e = until(cdataClose, lt + 9)
          if e < 0 && !final { return (out, lt) }
          let end = e < 0 ? n : e
          copy(lt, end)
          i = end
        } else if startsAt(b, lt, piOpen) {
          let e = until(piClose, lt + 2)
          if e < 0 && !final { return (out, lt) }
          let end = e < 0 ? n : e
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
          if k >= n && !final { return (out, lt) }
          let end = k < n ? k + 1 : n
          copy(lt, end)
          i = end
        } else if lt + 1 < n && b[lt + 1] == 0x2F {   // end tag
          let gt = indexOf(b, 0x3E, lt)
          if gt < 0 && !final { return (out, lt) }
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
            if !final { return (out, lt) }
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
      return (out, n)
    }
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
  /// SVG files up to this size are cleaned whole, in memory; larger ones stream through XmlCleaner.
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

  /// Photos larger than this (uncompressed) inside zip documents are copied as they are; XML parts of
  /// any size are cleaned (those larger than this stream through XmlCleaner).
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

  // MARK: - Office 97–2003 and encrypted Office files: OLE compound files

  static let cfbSig: [UInt8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
  private static let cfbFree: UInt32 = 0xFFFF_FFFF
  private static let endOfChain: UInt32 = 0xFFFF_FFFE

  /// A compound file (lib/docmeta.ts isCfb): the signature, and at least the 512-byte header.
  static func isCfb(_ src: RandomSource) -> Bool {
    src.size >= 512 && (try? src.read(0, 8)) == cfbSig
  }

  private static func le16(_ b: [UInt8], _ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
  private static func le32(_ b: [UInt8], _ at: Int) -> UInt32 {
    UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
  }

  /// Property-set sections (format IDs, as stored) and the string properties emptied in each (nil: all).
  private static let propertySets: [([UInt8], Set<UInt32>?)] = [
    // SummaryInformation: title, subject, author, keywords, comments, template, last saved by, application
    ([0xE0, 0x85, 0x9F, 0xF2, 0xF9, 0x4F, 0x68, 0x10, 0xAB, 0x91, 0x08, 0x00, 0x2B, 0x27, 0xB3, 0xD9], [2, 3, 4, 5, 6, 7, 8, 18]),
    // DocumentSummaryInformation: category, manager, company
    ([0x02, 0xD5, 0xCD, 0xD5, 0x9C, 0x2E, 0x1B, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2B, 0x2C, 0xF9, 0xAE], [2, 14, 15]),
    // custom properties: every value
    ([0x05, 0xD5, 0xCD, 0xD5, 0x9C, 0x2E, 0x1B, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2B, 0x2C, 0xF9, 0xAE], nil),
  ]
  private static let cfbTableMax = 64 * 1024 * 1024
  private static let cfbStreamMax = 16 * 1024 * 1024

  /// Same-length patches for an OLE compound file (Word, Excel, PowerPoint 97–2003, Visio, Publisher;
  /// encrypted Office files are compound files too), as lib/docmeta.ts cfbPatches: the file is read
  /// through its sector tables and
  /// - the summary property sets lose their title, subject, author, keywords, comments, template,
  ///   last-saved-by, application, category, manager and company, and every custom property value
  ///   (string values become zeros: empty);
  /// - PowerPoint's "Current User" stream loses the user name;
  /// - Excel's workbook stream loses the user name in its WriteAccess record.
  /// Dates, statistics and the document itself stay. Anything malformed: no patches.
  static func cfbPatches(_ src: RandomSource) -> [Patch] {
    (try? cfb(src)) ?? []
  }

  private struct CfbEntry { let name: [UInt16]; let type: UInt8; let start: UInt32; let size: Int }

  private static func cfb(_ src: RandomSource) throws -> [Patch] {
    // reads as JavaScript's subarray of the whole file does: what is past the end reads as zeros
    func readZ(_ at: Int, _ n: Int) throws -> [UInt8] {
      if at >= src.size { return [UInt8](repeating: 0, count: n) }
      var b = try src.read(at, min(n, src.size - at))
      if b.count < n { b += [UInt8](repeating: 0, count: n - b.count) }
      return b
    }
    let h = try readZ(0, 512)
    if Array(h[0..<8]) != cfbSig { return [] }
    let shift = le16(h, 0x1E)
    if shift != 9 && shift != 12 { return [] }
    let sector = 1 << shift
    let miniShift = le16(h, 0x20)
    if miniShift != 6 { return [] }
    let cutoff = Int(le32(h, 0x38))
    func at(_ n: UInt32) -> Int { (Int(n) + 1) * sector }
    // the FAT: its sectors from the header's 109 entries and the DIFAT chain
    var fatSectors: [UInt32] = []
    for i in 0..<109 {
      let n = le32(h, 0x4C + i * 4)
      if n == cfbFree || n == endOfChain { break }
      fatSectors.append(n)
    }
    var difat = le32(h, 0x44)
    var k = 0
    while difat != endOfChain && difat != cfbFree && k < 1 << 16 {
      let d = try readZ(at(difat), sector)
      for i in 0..<(sector / 4 - 1) {
        let n = le32(d, i * 4)
        if n != cfbFree && n != endOfChain { fatSectors.append(n) }
      }
      difat = le32(d, sector - 4)
      k += 1
    }
    if fatSectors.count * sector > cfbTableMax { return [] }
    var fat = [UInt32](repeating: 0, count: fatSectors.count * (sector / 4))
    for (i, n) in fatSectors.enumerated() {
      if at(n) + sector > src.size { throw Malformed() }   // FAT past the end
      let d = try src.read(at(n), sector)
      for k in 0..<(sector / 4) { fat[i * (sector / 4) + k] = le32(d, k * 4) }
    }
    func chain(_ start: UInt32, _ table: [UInt32]) throws -> [UInt32] {
      var list: [UInt32] = []
      var n = start
      while n != endOfChain {
        if Int(n) >= table.count || list.count > table.count { throw Malformed() }   // a bad chain
        list.append(n)
        n = table[Int(n)]
      }
      return list
    }
    // the directory
    var entries: [CfbEntry] = []
    for n in try chain(le32(h, 0x30), fat) {
      let d = try readZ(at(n), sector)
      var e = 0
      while e + 128 <= sector {
        let len = min(64, le16(d, e + 0x40))
        var name: [UInt16] = []
        var i = 0
        while i + 2 < len { name.append(UInt16(le16(d, e + i))); i += 2 }
        let size = Int(le32(d, e + 0x78)) + (shift == 12 ? Int(le32(d, e + 0x7C)) << 32 : 0)
        entries.append(CfbEntry(name: name, type: d[e + 0x42], start: le32(d, e + 0x74), size: size))
        e += 128
      }
    }
    guard let root = entries.first, root.type == 5 else { return [] }
    // the mini stream (small streams live there, in 64-byte sectors) and its table
    let miniSectorsOfRoot = root.size > 0 ? try chain(root.start, fat) : []
    let miniFatChain = le32(h, 0x3C) == endOfChain ? [] : try chain(le32(h, 0x3C), fat)
    if miniFatChain.count * sector > cfbTableMax { return [] }
    var miniFat = [UInt32](repeating: 0, count: miniFatChain.count * (sector / 4))
    for (i, n) in miniFatChain.enumerated() {
      let d = try readZ(at(n), sector)
      for k in 0..<(sector / 4) { miniFat[i * (sector / 4) + k] = le32(d, k * 4) }
    }
    /// Where a stream's bytes are in the file: (file offset, length) pieces in order.
    func pieces(_ e: CfbEntry) throws -> [(Int, Int)] {
      var out: [(Int, Int)] = []
      var left = e.size
      if e.size < cutoff {
        for m in try chain(e.start, miniFat) {
          if left <= 0 { break }
          let off = Int(m) * 64   // within the mini stream
          let index = off / sector
          if index >= miniSectorsOfRoot.count { throw Malformed() }   // mini sector past the mini stream
          let k = min(64, left)
          out.append((at(miniSectorsOfRoot[index]) + off % sector, k))
          left -= k
        }
      } else {
        for n in try chain(e.start, fat) {
          if left <= 0 { break }
          let k = min(sector, left)
          out.append((at(n), k))
          left -= k
        }
      }
      if left > 0 { throw Malformed() }   // stream shorter than its size
      for (o, k) in out where o + k > src.size { throw Malformed() }   // stream past the end
      return out
    }
    let summary = Array("\u{05}SummaryInformation".utf16), docSummary = Array("\u{05}DocumentSummaryInformation".utf16)
    let currentUserName = Array("Current User".utf16), workbookName = Array("Workbook".utf16), bookName = Array("Book".utf16)
    let zerosBase = Patch.zeros.withUnsafeBufferPointer { $0.baseAddress }
    var patches: [Patch] = []
    for e in entries {
      if e.type != 2 || e.size == 0 || e.size > cfbStreamMax { continue }
      let isSummary = e.name == summary || e.name == docSummary
      let isUser = e.name == currentUserName
      let isBook = e.name == workbookName || e.name == bookName
      if !isSummary && !isUser && !isBook { continue }
      let map = try pieces(e)
      var data = [UInt8]()
      data.reserveCapacity(e.size)
      for (o, k) in map { data += try src.read(o, k) }
      var local: [Patch] = []   // in stream offsets
      if isSummary { propertySet(data, &local) }
      else if isUser { currentUser(data, &local) }
      else { workbook(data, &local, e.name == bookName) }
      wipe(&data)
      // stream offsets to file offsets, split where the stream crosses a sector
      for p in local {
        let zeros = p.bytes.withUnsafeBufferPointer { $0.baseAddress } == zerosBase
        var s = 0
        var done = 0
        for (o, k) in map {
          let from = max(p.at, s), to = min(p.at + p.count, s + k)
          if from < to {
            patches.append(zeros ? Patch(zerosAt: o + (from - s), count: to - from)
                                 : Patch(at: o + (from - s), bytes: Array(p.bytes[(from - p.at)..<(to - p.at)])))
            done += to - from
          }
          s += k
          if done == p.count { break }
        }
      }
    }
    return patches
  }

  /// Empties string properties (see propertySets): their bytes become zeros, their lengths stay.
  private static func propertySet(_ d: [UInt8], _ patches: inout [Patch]) {
    if d.count < 28 || le16(d, 0) != 0xFFFE { return }
    let sections = Int(le32(d, 24))
    var i = 0
    while i < sections && i < 8 {
      defer { i += 1 }
      let s = 28 + i * 20
      if s + 20 > d.count { return }
      let format = Array(d[s..<(s + 16)])
      guard let set = propertySets.first(where: { $0.0 == format }) else { continue }
      let ids = set.1
      let off = Int(le32(d, s + 16))
      if off + 8 > d.count { continue }
      let size = Int(le32(d, off))
      let count = Int(le32(d, off + 4))
      let end = min(d.count, off + size)
      var k = 0
      while k < count && off + 8 + k * 8 + 8 <= end {
        defer { k += 1 }
        let id = le32(d, off + 8 + k * 8)
        let at = off + Int(le32(d, off + 12 + k * 8))
        if id == 0 || id == 1 || at + 8 > end { continue }   // the dictionary of names, the code page
        if let ids = ids, !ids.contains(id) { continue }
        let type = le16(d, at)
        let n = Int(le32(d, at + 4))
        let bytes = type == 0x1E ? n : type == 0x1F ? n * 2 : -1   // VT_LPSTR, VT_LPWSTR
        if bytes > 0 && at + 8 + bytes <= end { zeroPatches(&patches, at + 8, bytes) }
      }
    }
  }

  /// PowerPoint's CurrentUserAtom: the user name, in ANSI and then in Unicode.
  private static func currentUser(_ d: [UInt8], _ patches: inout [Patch]) {
    if d.count < 28 || le16(d, 2) != 0x0FF6 { return }
    let len = le16(d, 20)
    let ansi = 28
    if ansi + len > d.count { return }
    zeroPatches(&patches, ansi, len)
    let unicode = ansi + len + 4   // after the release version
    if unicode + len * 2 <= d.count && Int(le32(d, 4)) >= 24 + 3 * len { zeroPatches(&patches, unicode, len * 2) }
  }

  /// Excel's workbook globals: the WriteAccess record's user name becomes empty (its length 0) and its
  /// characters spaces, as Excel pads the record. `biff5`: the older "Book" stream, with a one-byte length.
  private static func workbook(_ d: [UInt8], _ patches: inout [Patch], _ biff5: Bool) {
    var p = 0
    var k = 0
    while p + 4 <= d.count && k < 4096 {
      let type = le16(d, p)
      let len = le16(d, p + 2)
      if p + 4 + len > d.count { return }
      if type == 0x002F || type == 0x000A { return }   // FilePass (the rest is encrypted), EOF
      if type == 0x005C && len >= (biff5 ? 1 : 3) {
        if biff5 {
          patches.append(Patch(at: p + 4, bytes: [0]))
          patches.append(Patch(at: p + 5, bytes: [UInt8](repeating: 0x20, count: len - 1)))
        } else {
          patches.append(Patch(at: p + 4, bytes: [0, 0]))   // no characters
          patches.append(Patch(at: p + 7, bytes: [UInt8](repeating: 0x20, count: len - 3)))
        }
        return
      }
      p += 4 + len
      k += 1
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
      let original = e
      // an XML part too large to hold whole streams through XmlCleaner, twice: once to learn its CRC
      // and sizes (the local header comes first), once to write it (the same bytes: deterministic)
      let rules = e.cleanable && e.usize > partMax && !isZipImage(e.name) ? xmlRules(format, String(decoding: e.name, as: UTF8.self)) : nil
      var streamed: (method: UInt16, crc: UInt32, csize: Int, usize: Int)? = nil
      if let rules = rules, let r = try? streamXml(src, e, rules, nil, { _ in }), r.changed {
        let method: UInt16 = r.deflated < r.usize ? 8 : 0
        streamed = (method, r.crc, method == 8 ? r.deflated : r.usize, r.usize)
      }
      var replacement = e.cleanable && rules == nil ? cleanEntry(src, e, format) : nil
      if let r = streamed {
        e.method = r.method
        e.flags &= ~0x0006   // deflate options: none
        e.crc = r.crc
        e.csize = r.csize
        e.usize = r.usize
      }
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
      if let r = streamed {
        let again = try streamXml(src, original, rules!, r.method, emit)
        guard again.crc == r.crc, again.usize == r.usize, (r.method == 0 ? again.usize : again.deflated) == r.csize else { throw Malformed() }
      } else if replacement != nil {
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

  /// One XML part streamed through XmlCleaner: inflated (or read, if stored) a piece at a time, its CRC
  /// and size checked, cleaned, and deflated. With `method` nil nothing is written: the result gives
  /// the cleaned part's CRC, its size and its deflated size, and whether it changed (nil: the part
  /// cannot be read exactly). With `method` 8 the deflated bytes go to `emit`, with 0 the cleaned bytes.
  private static func streamXml(_ src: RandomSource, _ e: Entry, _ rules: XmlRules, _ method: UInt16?,
                                _ emit: ([UInt8]) throws -> Void) throws -> (crc: UInt32, usize: Int, deflated: Int, changed: Bool) {
    let inflater = e.method == 8 ? try FlateStream(encode: false) : nil
    let deflater = method != 0 ? try FlateStream(encode: true) : nil
    var cleaner = XmlCleaner(rules)
    var rawCrc: UInt32 = 0xFFFF_FFFF, cleanCrc: UInt32 = 0xFFFF_FFFF
    var rawSize = 0, cleanSize = 0, deflated = 0
    func feed(_ piece: [UInt8], last: Bool) throws {
      var piece = piece
      cleanCrc = crc32(piece, cleanCrc)
      cleanSize += piece.count
      if let d = deflater {
        var z = try d.process(piece, final: last)
        deflated += z.count
        if method == 8 && !z.isEmpty { try emit(z) }
        wipe(&z)
      } else if method == 0 && !piece.isEmpty {
        try emit(piece)
      }
      wipe(&piece)
    }
    var at = 0
    while at < e.csize {
      let n = min(1 << 20, e.csize - at)
      var part = try src.read(e.dataStart + at, n)
      at += n
      var raw = try inflater?.process(part, final: at == e.csize) ?? part
      wipe(&part)
      rawCrc = crc32(raw, rawCrc)
      rawSize += raw.count
      guard rawSize <= e.usize else { wipe(&raw); throw Malformed() }
      let clean = cleaner.push(raw)
      wipe(&raw)
      try feed(clean, last: false)
    }
    try feed(cleaner.finish(), last: true)
    guard rawSize == e.usize, rawCrc ^ 0xFFFF_FFFF == e.crc else { throw Malformed() }
    // the cleaner only takes bytes out: the same length means nothing changed
    return (cleanCrc ^ 0xFFFF_FFFF, cleanSize, deflated, cleanSize != rawSize)
  }

  /// Raw DEFLATE (as zip stores it), compressed or decompressed a piece at a time.
  final class FlateStream {
    private var stream: compression_stream
    private var ended = false
    private var buffer = [UInt8](repeating: 0, count: 1 << 16)

    init(encode: Bool) throws {
      let dummy = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
      defer { dummy.deallocate() }
      stream = compression_stream(dst_ptr: dummy, dst_size: 0, src_ptr: UnsafePointer(dummy), src_size: 0, state: nil)
      guard compression_stream_init(&stream, encode ? COMPRESSION_STREAM_ENCODE : COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
              == COMPRESSION_STATUS_OK else { throw Malformed() }
    }

    deinit {
      compression_stream_destroy(&stream)
      wipe(&buffer)
    }

    /// Feeds `input` (`final`: nothing comes after it) and returns what comes out. Decoding stops at
    /// the end of the DEFLATE stream.
    func process(_ input: [UInt8], final: Bool) throws -> [UInt8] {
      var out = [UInt8]()
      if ended { return out }
      let flags = final ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
      let size = buffer.count
      try input.withUnsafeBufferPointer { src in
        let one = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
        defer { one.deallocate() }
        stream.src_ptr = src.baseAddress ?? UnsafePointer(one)
        stream.src_size = src.count
        while true {
          let status = buffer.withUnsafeMutableBufferPointer { dst -> compression_status in
            stream.dst_ptr = dst.baseAddress!
            stream.dst_size = size
            return compression_stream_process(&stream, flags)
          }
          let produced = size - stream.dst_size
          out.append(contentsOf: buffer[0..<produced])
          if status == COMPRESSION_STATUS_ERROR { throw Malformed() }
          if status == COMPRESSION_STATUS_END { ended = true; break }
          // more to come while input is left or the buffer filled up; finishing, until the end
          if stream.src_size == 0 && stream.dst_size > 0 && (!final || produced == 0) { break }
        }
      }
      return out
    }
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
      // photos up to partMax; XML parts of any size (the large ones are streamed)
      entries[k].cleanable = (e.method == 0 || e.method == 8)
        && (isZipImage(e.name) ? e.usize <= partMax : xmlRules(format, names[k]) != nil)
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

  static func crc32(_ b: [UInt8]) -> UInt32 { crc32(b, 0xFFFF_FFFF) ^ 0xFFFF_FFFF }

  /// The CRC register carried on over `b` (start at 0xFFFFFFFF; the CRC is the register ^ 0xFFFFFFFF).
  static func crc32(_ b: [UInt8], _ register: UInt32) -> UInt32 {
    var c = register
    for x in b { c = crcTable[Int((c ^ UInt32(x)) & 0xFF)] ^ (c >> 8) }
    return c
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
