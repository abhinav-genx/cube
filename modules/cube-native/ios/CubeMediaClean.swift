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
/// - WAV: LIST/INFO, bext, iXML, XMP, ID3, cart and axml chunks become JUNK chunks. AVI: the same,
///   and the camera chunks in its header (stream data, Nikon's tags).
/// - AIFF, AIFC: name, author, copyright, annotation, comment and ID3 chunks become JUNK chunks.
/// - Ogg (Vorbis, Opus, Theora, Speex, FLAC): the comment header of every stream (chained files
///   included) is emptied (no vendor, no comments; Ogg FLAC as for FLAC) and the page checksums updated.
/// - Matroska, WebM: tags become Void elements; the title, the muxing and writing apps, track names
///   and chapter titles are emptied; image attachments (cover art) become Void elements.
/// - Location tracks that action cameras record beside the video (GoPro GPMF, Google CAMM, DJI and
///   Sony metadata tracks, and DJI subtitle tracks that print the position) become "free" boxes and
///   their samples are zeroed; so are the GPS records and serial number in an Insta360 trailer.
/// - Motion-JPEG video (MP4, MOV, Matroska, AVI): each frame loses its Exif, XMP and comment segments.
/// - Video tracks lose the encoder name in their sample descriptions.
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
        try insta360(src, &patches)
        return patches
      }
      if has(head, 0, "RIFF") || has(head, 0, "RF64") {
        if has(head, 8, "WAVE") || has(head, 8, "AVI ") { try riff(src, &patches) }
        return patches
      }
      if has(head, 0, "FORM") {
        if has(head, 8, "AIFF") || has(head, 8, "AIFC") { try aiff(src, &patches) }
        return patches
      }
      if has(head, 0, "OggS") {
        try ogg(src, &patches)
        return patches
      }
      if u32(head, 0) == 0x1A45_DFA3 {
        try matroska(src, &patches)
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
  private static func u16(_ b: [UInt8], _ at: Int) -> Int { Int(b[at]) << 8 | Int(b[at + 1]) }
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
      else if b.type == l1("trak") && place == .moov {
        if try locationTrack(src, b, &patches) { blank(b, &patches) }
        else {
          try mjpegTrack(src, b, &patches)
          try compressorNames(src, b, &patches)
          try mp4(src, inner, b.at + b.size, .trak, &patches)
        }
      }
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

  private static func flac(_ src: CubeDocClean.RandomSource, _ from: Int, _ patches: inout [Patch], _ end: Int? = nil) throws {
    let end = end ?? src.size
    var p = from
    while true {
      if p + 4 > end { return }
      let h = try read(src, p, 4)
      let last = h[0] & 0x80
      let type = h[0] & 0x7F
      let n = Int(h[1]) << 16 | Int(h[2]) << 8 | Int(h[3])
      if p + 4 + n > end { return }
      if type == 2 || type == 4 || type == 6 {   // application, Vorbis comment, picture → padding
        patches.append(Patch(at: p, bytes: [last | 1]))
        CubeDocClean.zeroPatches(&patches, p + 4, n)
      }
      p += 4 + n
      if last != 0 { return }
    }
  }

  // MARK: - WAV, AVI

  /// Chunks that become JUNK: broadcast, iXML, XMP, ID3, cart and axml (WAV), stream data (AVI cameras).
  private static let riffBlank: Set<[UInt8]> = Set(["bext", "iXML", "_PMX", "id3 ", "ID3 ", "cart", "axml", "strd"].map(l1))
  /// Lists that become JUNK: text tags, and Nikon's camera tags in an AVI header.
  private static let riffBlankList: Set<[UInt8]> = Set(["INFO", "ncdt"].map(l1))
  /// Lists looked inside: an AVI's header and its stream headers, and its frames ("rec " groups some).
  private static let riffOpenList: Set<[UInt8]> = Set(["hdrl", "strl", "movi", "rec "].map(l1))

  private static func riff(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    let declared = u32le(try read(src, 4, 4), 0)
    let end = declared == 0xFFFF_FFFF ? src.size : min(src.size, 8 + declared)
    try riffChunks(src, 12, end, 0, &patches)
    // an AVI over 1 GB goes on in more RIFF chunks ("AVIX"), each with frames of its own
    var p = end + (end & 1)
    while p + 12 <= src.size {
      let h = try read(src, p, 12)
      let n = u32le(h, 4)
      if !has(h, 0, "RIFF") || !has(h, 8, "AVIX") || p + 8 + n > src.size { return }
      try riffChunks(src, p + 12, p + 8 + n, 0, &patches)
      p += 8 + n + (n & 1)
    }
  }

  /// A chunk ID of a video frame: two digits (the stream) and "dc" or "db".
  private static func isFrameId(_ id: [UInt8]) -> Bool {
    id.count == 4 && id[0] >= 0x30 && id[0] <= 0x39 && id[1] >= 0x30 && id[1] <= 0x39 && id[2] == 0x64 && (id[3] == 0x63 || id[3] == 0x62)
  }

  private static func riffChunks(_ src: CubeDocClean.RandomSource, _ from: Int, _ end: Int, _ depth: Int, _ patches: inout [Patch]) throws {
    var p = from
    while p + 8 <= end {
      let h = try read(src, p, 12 <= end - p ? 12 : 8)
      let id = Array(h[0..<4])
      let n = u32le(h, 4)
      if n == 0xFFFF_FFFF || p + 8 + n > end { return }
      let list: [UInt8] = id == l1("LIST") && h.count >= 12 ? Array(h[8..<12]) : []
      if riffBlank.contains(id) || riffBlankList.contains(list) {
        patches.append(Patch(at: p, bytes: l1("JUNK")))
        CubeDocClean.zeroPatches(&patches, p + 8, n)
      } else if riffOpenList.contains(list) && depth < 3 {
        try riffChunks(src, p + 12, p + 8 + n, depth + 1, &patches)
      } else if depth > 0 && isFrameId(id) && n >= 4 {
        let soi = try read(src, p + 8, 2)
        if soi[0] == 0xFF && soi[1] == 0xD8 { CubeDocClean.jpegPatches(src, p + 8, &patches) }   // a motion-JPEG frame
      }
      p += 8 + n + (n & 1)
    }
  }

  // MARK: - MP4 / MOV: location tracks

  /// Sample formats of timed-metadata tracks that carry a location: GoPro GPMF, Google's camera motion
  /// metadata, DJI's metadata and debug tracks, Sony's real-time metadata.
  private static let locationFormats: Set<[UInt8]> = Set(["gpmd", "camm", "djmd", "dbgi", "rtmd"].map(l1))
  /// Sample tables larger than this are not read (the track is still turned into a free box).
  private static let tableMax = 64 * 1024 * 1024

  private static func child(_ src: CubeDocClean.RandomSource, _ b: Box, _ type: String) throws -> Box? {
    let t = l1(type)
    return try boxes(src, b.at + b.head, b.at + b.size).first { $0.type == t }
  }

  /// Text tracks (subtitles) whose samples are looked at for a printed position, as DJI drones write.
  private static let textFormats: Set<[UInt8]> = Set(["tx3g", "text", "wvtt"].map(l1))

  /// How DJI subtitles print the position: "GPS (8.6332, 47.4028, 21)" or "[latitude: 47.40] [longitude: 8.63]"
  /// (lib/mediameta.ts PRINTED_POSITION: /GPS\s*\(\s*-?\d|\[\s*latitude\s*:|\[\s*longitude\s*:/i on Latin-1 text).
  private static func printedPosition(_ b: [UInt8]) -> Bool {
    func space(_ c: UInt8) -> Bool { c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 }
    func lower(_ c: UInt8) -> UInt8 { c >= 0x41 && c <= 0x5A ? c + 0x20 : c }
    func word(_ i: Int, _ w: [UInt8]) -> Int? {
      if i + w.count > b.count { return nil }
      for k in 0..<w.count where lower(b[i + k]) != w[k] { return nil }
      return i + w.count
    }
    func spaces(_ i: Int) -> Int { var j = i; while j < b.count && space(b[j]) { j += 1 }; return j }
    func digit(_ i: Int) -> Bool { i < b.count && b[i] >= 0x30 && b[i] <= 0x39 }
    for i in 0..<b.count {
      if var j = word(i, l1("gps")) {
        j = spaces(j)
        if j < b.count && b[j] == 0x28 {
          j = spaces(j + 1)
          if digit(j) || (j < b.count && b[j] == 0x2D && digit(j + 1)) { return true }
        }
      }
      if b[i] == 0x5B {
        let j = spaces(i + 1)
        for w in [l1("latitude"), l1("longitude")] {
          if let e = word(j, w) {
            let k = spaces(e)
            if k < b.count && b[k] == 0x3A { return true }
          }
        }
      }
    }
    return false
  }

  /// A track's sample table and the format of its first sample entry.
  private static func sampleTable(_ src: CubeDocClean.RandomSource, _ trak: Box) throws -> (stbl: Box, format: [UInt8])? {
    guard let mdia = try child(src, trak, "mdia"), let minf = try child(src, mdia, "minf"),
          let stbl = try child(src, minf, "stbl"), let stsd = try child(src, stbl, "stsd"),
          stsd.size >= stsd.head + 16 else { return nil }
    return (stbl, try read(src, stsd.at + stsd.head + 12, 4))
  }

  /// True (with its samples zeroed) for a track whose samples are locations: see locationFormats, and
  /// text tracks whose first samples print a position.
  private static func locationTrack(_ src: CubeDocClean.RandomSource, _ trak: Box, _ patches: inout [Patch]) throws -> Bool {
    guard let t = try sampleTable(src, trak) else { return false }
    if !locationFormats.contains(t.format) {
      if !textFormats.contains(t.format) { return false }
      var printed = false
      for (at, n) in try samples(src, t.stbl, 8) where printedPosition(try read(src, at, min(n, 512))) {
        printed = true
        break
      }
      if !printed { return false }
    }
    for (at, n) in try sampleRanges(src, t.stbl) { CubeDocClean.zeroPatches(&patches, at, n) }
    return true
  }

  /// A video track's sample entries name the encoder (the 32-byte compressor name: "Lavc61 mjpeg",
  /// an editor's name); it becomes empty. Only in tracks whose handler is video.
  private static func compressorNames(_ src: CubeDocClean.RandomSource, _ trak: Box, _ patches: inout [Patch]) throws {
    guard let mdia = try child(src, trak, "mdia"), let hdlr = try child(src, mdia, "hdlr"),
          hdlr.size >= hdlr.head + 12, has(try read(src, hdlr.at + hdlr.head + 8, 4), 0, "vide") else { return }
    guard let minf = try child(src, mdia, "minf"), let stbl = try child(src, minf, "stbl"),
          let stsd = try child(src, stbl, "stsd"), stsd.size >= stsd.head + 8 else { return }
    for e in try boxes(src, stsd.at + stsd.head + 8, stsd.at + stsd.size) where e.head == 8 && e.size >= 86 {
      CubeDocClean.zeroPatches(&patches, e.at + 50, 32)
    }
  }

  /// Sample formats of motion-JPEG video: every frame is a JPEG that can carry Exif.
  private static let mjpegFormats: Set<[UInt8]> = Set(["jpeg", "mjpa", "mjpb", "AVDJ", "dmb1"].map(l1))

  /// Zeroes the Exif, XMP and comment segments of every frame of a motion-JPEG track.
  private static func mjpegTrack(_ src: CubeDocClean.RandomSource, _ trak: Box, _ patches: inout [Patch]) throws {
    guard let t = try sampleTable(src, trak), mjpegFormats.contains(t.format) else { return }
    for (at, n) in try samples(src, t.stbl) where n >= 4 { CubeDocClean.jpegPatches(src, at, &patches) }
  }

  private static func table(_ src: CubeDocClean.RandomSource, _ b: Box?) throws -> [UInt8]? {
    guard let b = b, b.size - b.head >= 8, b.size - b.head <= tableMax else { return nil }
    return try read(src, b.at + b.head, b.size - b.head)
  }

  /// Where a track's samples are in the file, adjacent samples merged; empty if the tables are odd.
  private static func sampleRanges(_ src: CubeDocClean.RandomSource, _ stbl: Box) throws -> [(Int, Int)] {
    var ranges: [(Int, Int)] = []
    for (at, n) in try samples(src, stbl) {
      if let last = ranges.last, last.0 + last.1 == at { ranges[ranges.count - 1].1 += n }
      else if n > 0 { ranges.append((at, n)) }
    }
    return ranges
  }

  /// Where each of a track's samples is in the file (the first `max`); empty if the tables are odd.
  private static func samples(_ src: CubeDocClean.RandomSource, _ stbl: Box, _ max: Int = Int.max) throws -> [(Int, Int)] {
    let kids = try boxes(src, stbl.at + stbl.head, stbl.at + stbl.size)
    func find(_ t: String) -> Box? { let u = l1(t); return kids.first { $0.type == u } }
    let stsz = try table(src, find("stsz"))
    let stsc = try table(src, find("stsc"))
    let co64 = find("stco") == nil
    let stco = try table(src, find("stco") ?? find("co64"))
    guard let stsz = stsz, let stsc = stsc, let stco = stco, stsz.count >= 12 else { return [] }
    let uniform = u32(stsz, 4)
    let count = u32(stsz, 8)
    if uniform == 0 && stsz.count < 12 + count * 4 { return [] }
    let chunks = u32(stco, 4)
    if stco.count < 8 + chunks * (co64 ? 8 : 4) { return [] }
    let entries = u32(stsc, 4)
    if stsc.count < 8 + entries * 12 { return [] }
    var list: [(Int, Int)] = []
    var s = 0
    var e = 0
    var c = 1
    while c <= chunks && s < count && s < max {
      while e + 1 < entries && u32(stsc, 8 + (e + 1) * 12) <= c { e += 1 }
      let perChunk = entries > 0 ? u32(stsc, 8 + e * 12 + 4) : 0
      var at: Int
      if co64 {
        let hi = u32(stco, 8 + (c - 1) * 8)
        at = hi >= 0x4000_0000 ? Int.max / 2 : hi << 32 | u32(stco, 12 + (c - 1) * 8)   // past any real file
      } else {
        at = u32(stco, 8 + (c - 1) * 4)
      }
      var k = 0
      while k < perChunk && s < count && s < max {
        let n = uniform != 0 ? uniform : u32(stsz, 12 + s * 4)
        if at + n > src.size { return list }
        list.append((at, n))
        at += n
        k += 1
        s += 1
      }
      c += 1
    }
    return list
  }

  // MARK: - Insta360 trailer

  private static let insta360Magic = l1("8db42d694ccc418790edff439fe026bf")

  /// Insta360 cameras append a trailer after the video: records (each its data, then a record ID and
  /// length) and 72 bytes ending in a magic number, with the trailer's length 38 bytes into the last
  /// 78. The GPS record (0x700) is zeroed, and the serial number (tag 0x0a) in the camera record
  /// (0x101); the motion, exposure and lens records that stitching needs stay. Record 0 is a table of
  /// where the others are, used when present (as ExifTool reads it).
  private static func insta360(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    if src.size < 78 { return }
    let tail = try read(src, src.size - 78, 78)
    if !tail[46..<78].elementsEqual(insta360Magic) { return }
    let length = u32le(tail, 38)
    if length > src.size || length < 78 { return }
    let start = src.size - length
    var records: [(id: Int, at: Int, len: Int)] = []   // ID, where its data starts, its length
    var foot = src.size - 78   // where the last record's ID and length are
    for _ in 0..<4096 {
      let f = try read(src, foot, 6)
      let id = Int(f[0]) | Int(f[1]) << 8
      let len = u32le(f, 2)
      if foot - len < start { break }
      records.append((id, foot - len, len))
      if id == 0 {   // the table: ID, size, offset from the trailer's start, 10 bytes each
        let table = try read(src, foot - len, min(len, 1 << 16))
        records.removeAll()
        var p = 0
        while p + 10 <= table.count {
          let rid = Int(table[p]) | Int(table[p + 1]) << 8
          let size = u32le(table, p + 2)
          let off = u32le(table, p + 6)
          if rid != 0 && size != 0 && off + size < length { records.append((rid, start + off, size)) }
          p += 10
        }
        break
      }
      foot = foot - len - 6
      if foot < start { break }
    }
    for (id, at, len) in records {
      if id == 0x700 { CubeDocClean.zeroPatches(&patches, at, len) }
      else if id == 0x101 {
        let r = try read(src, at, min(len, 4096))
        var p = 0
        var i = 0
        while i < 4 && p + 2 <= r.count {
          let n = Int(r[p + 1])
          if p + 2 + n > r.count { break }
          if r[p] == 0x0A { CubeDocClean.zeroPatches(&patches, at + p + 2, n) }   // serial number
          p += 2 + n
          i += 1
        }
      }
    }
  }

  // MARK: - AIFF

  private static let aiffBlank: Set<[UInt8]> = Set(["NAME", "AUTH", "(c) ", "ANNO", "COMT", "ID3 ", "id3 "].map(l1))

  private static func aiff(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    let end = min(src.size, 8 + u32(try read(src, 4, 4), 0))
    var p = 12
    while p + 8 <= end {
      let h = try read(src, p, 8)
      let id = Array(h[0..<4])
      let n = u32(h, 4)
      if p + 8 + n > end { return }
      if aiffBlank.contains(id) {
        patches.append(Patch(at: p, bytes: l1("JUNK")))
        CubeDocClean.zeroPatches(&patches, p + 8, n)
      }
      p += 8 + n + (n & 1)
    }
  }

  // MARK: - Ogg

  private static let oggCrcTable: [UInt32] = (0..<256).map { i -> UInt32 in
    var r = UInt32(i) << 24
    for _ in 0..<8 { r = r & 0x8000_0000 != 0 ? (r << 1) ^ 0x04C1_1DB7 : r << 1 }
    return r
  }

  private static func oggCrc(_ b: [UInt8]) -> UInt32 {
    var c: UInt32 = 0
    for x in b { c = (c << 8) ^ oggCrcTable[Int((c >> 24) ^ UInt32(x)) & 0xFF] }
    return c
  }

  /// One piece of a packet: where it is in the file and the page it is on.
  private struct Segment { let at: Int; let n: Int; let page: Int }
  private final class OggStream {
    var codec: String
    var packet: Int
    var segs: [Segment] = []
    var done: Bool
    var headers: Int
    init(codec: String, packet: Int, done: Bool, headers: Int) {
      self.codec = codec; self.packet = packet; self.done = done; self.headers = headers
    }
  }

  /// The first `n` bytes of a packet (fewer if it is shorter).
  private static func packetHead(_ src: CubeDocClean.RandomSource, _ segs: [Segment], _ n: Int) throws -> [UInt8] {
    var out: [UInt8] = []
    for s in segs {
      if out.count >= n { break }
      out += try read(src, s.at, min(s.n, n - out.count))
    }
    return out
  }

  /// The cleaned start of a header packet (the rest of the packet becomes zeros), or nil to leave it.
  /// Comment headers keep their magic and get an empty vendor and no comments: Vorbis (with its framing
  /// bit), Opus (zeros after the comment list are padding by RFC 7845), Theora and Speex. Ogg FLAC's
  /// metadata blocks are cleaned as in a FLAC file.
  private static func oggPacket(_ s: OggStream, _ head: [UInt8], _ total: Int) -> [UInt8]? {
    if s.codec == "vorbis" && has(head, 0, "\u{03}vorbis") && total >= 16 {
      var out = [UInt8](repeating: 0, count: 16)
      out.replaceSubrange(0..<7, with: head[0..<7])
      out[15] = 1   // framing bit
      return out
    }
    if s.codec == "opus" && has(head, 0, "OpusTags") && total >= 16 { return Array(head[0..<8]) }
    if s.codec == "theora" && has(head, 0, "\u{81}theora") && total >= 15 { return Array(head[0..<7]) }
    if s.codec == "speex" && total >= 8 { return [] }
    if s.codec == "flac" && head.count >= 4 {
      let type = head[0] & 0x7F
      if type != 2 && type != 4 && type != 6 { return nil }
      return [(head[0] & 0x80) | 1, head[1], head[2], head[3]]
    }
    return nil
  }

  private static func ogg(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    var streams: [Int: OggStream] = [:]
    var own: [Patch] = []
    var touched: [Int] = []   // pages in the order of first touch
    var touchedSet = Set<Int>()
    var pageLength: [Int: Int] = [:]
    var p = 0
    while p + 27 <= src.size {
      let h = try read(src, p, 27)
      if !has(h, 0, "OggS") || h[4] != 0 { break }
      let flags = h[5]
      let serial = u32le(h, 14)
      let lacing = try read(src, p + 27, Int(h[26]))
      var at = p + 27 + lacing.count
      var len = 0
      for l in lacing { len += Int(l) }
      if at + len > src.size { break }
      pageLength[p] = at + len - p
      var s = streams[serial]
      if flags & 2 != 0 {
        s = OggStream(codec: "", packet: 0, done: false, headers: 0)
        streams[serial] = s
      }
      if let s = s, !s.done {
        for l in lacing {
          s.segs.append(Segment(at: at, n: Int(l), page: p))
          at += Int(l)
          if l == 255 { continue }
          try packet(src, s, &own, &touched, &touchedSet)
          s.segs = []
          s.packet += 1
          if s.done { break }
        }
      }
      p += pageLength[p]!
    }
    for page in touched {
      let n = pageLength[page]!
      var b = try read(src, page, n)
      let mine = own.filter { $0.at >= page && $0.at < page + n }
      for x in mine { b.replaceSubrange((x.at - page)..<(x.at - page + x.count), with: x.bytes[0..<x.count]) }
      for i in 22..<26 { b[i] = 0 }
      let crc = oggCrc(b)
      CubeDocClean.wipe(&b)
      patches += mine
      patches.append(Patch(at: page + 22, bytes: [UInt8(crc & 0xFF), UInt8((crc >> 8) & 0xFF), UInt8((crc >> 16) & 0xFF), UInt8(crc >> 24)]))
    }
  }

  /// Handles one whole packet of a stream: identifies the codec, or cleans a header packet.
  private static func packet(_ src: CubeDocClean.RandomSource, _ s: OggStream, _ own: inout [Patch],
                             _ touched: inout [Int], _ touchedSet: inout Set<Int>) throws {
    let total = s.segs.reduce(0) { $0 + $1.n }
    let head = try packetHead(src, s.segs, 16)
    if s.packet == 0 {
      if has(head, 0, "\u{01}vorbis") { s.codec = "vorbis" }
      else if has(head, 0, "OpusHead") { s.codec = "opus" }
      else if has(head, 0, "\u{80}theora") { s.codec = "theora" }
      else if has(head, 0, "Speex   ") { s.codec = "speex" }
      else if has(head, 0, "\u{7F}FLAC") && head.count >= 9 {
        s.codec = "flac"
        let n = u16(head, 7)
        s.headers = n != 0 ? n : Int.max   // header packets after this one (0: not said)
      } else { s.done = true }
      return
    }
    if s.codec == "flac" {
      if !head.isEmpty && head[0] == 0xFF {   // an audio frame: no more metadata
        s.done = true
        return
      }
      if s.headers != Int.max { s.headers -= 1 }
      if (!head.isEmpty && head[0] & 0x80 != 0) || s.headers <= 0 { s.done = true }
    } else { s.done = true }   // the comment header is the second packet
    guard let clean = oggPacket(s, head, total) else { return }
    var q = 0
    for seg in s.segs {
      let k = max(0, min(seg.n, clean.count - q))
      if k > 0 { own.append(Patch(at: seg.at, bytes: Array(clean[q..<(q + k)]))) }
      CubeDocClean.zeroPatches(&own, seg.at + k, seg.n - k)
      q += seg.n
      if touchedSet.insert(seg.page).inserted { touched.append(seg.page) }
    }
  }

  // MARK: - Matroska, WebM

  private enum EBML {
    static let header = 0x1A45_DFA3, docType = 0x4282, segment = 0x1853_8067, seekHead = 0x114D_9B74, seek = 0x4DBB
    static let seekID = 0x53AB, seekPosition = 0x53AC, info = 0x1549_A966, title = 0x7BA9, muxingApp = 0x4D80
    static let writingApp = 0x5741, tags = 0x1254_C367, attachments = 0x1941_A469, attachedFile = 0x61A7
    static let fileMimeType = 0x4660, crc32 = 0xBF, tracks = 0x1654_AE6B, trackEntry = 0xAE, codecID = 0x86
    static let codecPrivate = 0x63A2, name = 0x536E, trackNumber = 0xD7, chapters = 0x1043_A770, editionEntry = 0x45B9
    static let chapterAtom = 0xB6, chapterDisplay = 0x80, chapString = 0x85, cluster = 0x1F43_B675, simpleBlock = 0xA3
    static let blockGroup = 0xA0, block = 0xA1
  }
  /// Elements that can appear inside a cluster, to find where a cluster of unknown size ends.
  private static let clusterChildren: Set<Int> = [0xE7, 0xA7, 0xAB, 0x5854, 0xA3, 0xA0, 0xAF, 0xEC, 0xBF]

  /// An element: where it starts, its ID, where its data starts and ends (end -1: unknown size).
  private struct El { let at: Int; let id: Int; let data: Int; let end: Int }

  private static func element(_ src: CubeDocClean.RandomSource, _ at: Int, _ limit: Int) throws -> El? {
    let h = try read(src, at, min(12, limit - at))
    if h.count < 2 { return nil }
    let idLen = h[0].leadingZeroBitCount + 1   // 1 to 4: the first set bit gives the width
    if idLen < 1 || idLen > 4 || h.count < idLen + 1 { return nil }
    var id = 0
    for i in 0..<idLen { id = id * 256 + Int(h[i]) }
    let sizeLen = h[idLen].leadingZeroBitCount + 1
    if sizeLen < 1 || sizeLen > 8 || h.count < idLen + sizeLen { return nil }
    var size = Int(h[idLen]) & (0xFF >> sizeLen)
    var unknown = size == 0xFF >> sizeLen
    for i in 1..<max(1, sizeLen) {
      size = size * 256 + Int(h[idLen + i])
      if h[idLen + i] != 0xFF { unknown = false }
    }
    let data = at + idLen + sizeLen
    if unknown { return El(at: at, id: id, data: data, end: -1) }
    if size > limit - data { return nil }
    return El(at: at, id: id, data: data, end: data + size)
  }

  private static func children(_ src: CubeDocClean.RandomSource, _ from: Int, _ to: Int) throws -> [El] {
    var list: [El] = []
    var p = from
    while p < to {
      guard let e = try element(src, p, to), e.end >= 0 else { break }
      list.append(e)
      p = e.end
    }
    return list
  }

  /// Turns an element into a Void element of the same length, its contents zeroed.
  private static func voidElement(_ e: El, _ patches: inout [Patch]) {
    let t = e.end - e.at
    if t < 2 { return }
    var head: [UInt8]
    if t - 2 <= 126 { head = [0xEC, UInt8(0x80 | (t - 2))] }
    else {
      head = [UInt8](repeating: 0, count: 9)
      head[0] = 0xEC
      head[1] = 0x01   // an 8-byte size
      var v = t - 9
      for i in stride(from: 8, through: 2, by: -1) { head[i] = UInt8(v % 256); v /= 256 }
    }
    patches.append(Patch(at: e.at, bytes: head))
    CubeDocClean.zeroPatches(&patches, e.at + head.count, t - head.count)
  }

  private static func uint(_ src: CubeDocClean.RandomSource, _ e: El) throws -> Int {
    var v = 0
    for x in try read(src, e.data, min(8, e.end - e.data)) {
      v = v * 256 + Int(x)
      if v >= 1 << 54 { v = 1 << 54 }   // past any real file (where JavaScript's numbers stop being exact)
    }
    return v
  }

  /// Latin-1 text of an element's first `n` bytes, trailing NULs dropped.
  private static func text(_ src: CubeDocClean.RandomSource, _ e: El, _ n: Int) throws -> [UInt8] {
    var b = try read(src, e.data, min(n, e.end - e.data))
    while let last = b.last, last == 0 { b.removeLast() }
    return b
  }

  /// Empties every chapter title (ChapString) under Chapters, nested chapters included.
  private static func chapterTitles(_ src: CubeDocClean.RandomSource, _ e: El, _ depth: Int, _ patches: inout [Patch]) throws {
    if depth > 16 { return }
    for k in try children(src, e.data, e.end) {
      if k.id == EBML.chapString { CubeDocClean.zeroPatches(&patches, k.data, k.end - k.data) }
      else if k.id == EBML.editionEntry || k.id == EBML.chapterAtom || k.id == EBML.chapterDisplay {
        try chapterTitles(src, k, depth + 1, &patches)
      }
    }
  }

  /// Walks every cluster (those of unknown size too: one ends where an element that cannot be in a
  /// cluster starts) and cleans the frames of motion-JPEG tracks. Laced blocks (several frames in one)
  /// are not used for video and are left alone.
  private static func mjpegClusters(_ src: CubeDocClean.RandomSource, _ from: Int, _ to: Int, _ tracks: Set<Int>,
                                    _ patches: inout [Patch]) throws {
    func frame(_ b: El, _ patches: inout [Patch]) throws {
      let h = try read(src, b.data, min(12, b.end - b.data))
      let w = h.count > 0 ? h[0].leadingZeroBitCount + 1 : 0   // the track number's width
      if w < 1 || w > 8 || h.count < w + 3 { return }
      var track = Int(h[0]) & (0xFF >> w)
      for i in 1..<max(1, w) { track = track * 256 + Int(h[i]) }
      if !tracks.contains(track) || h[w + 2] & 0x06 != 0 { return }   // another track, or laced
      if b.data + w + 3 + 4 <= b.end { CubeDocClean.jpegPatches(src, b.data + w + 3, &patches) }
    }
    var p = from
    while p < to {
      guard let e = try element(src, p, to) else { return }
      if e.id != EBML.cluster {
        if e.end < 0 { return }
        p = e.end
        continue
      }
      let end = e.end < 0 ? to : e.end
      var q = e.data
      while q < end {
        guard let k = try element(src, q, end), k.end >= 0, e.end >= 0 || clusterChildren.contains(k.id) else { break }
        if k.id == EBML.simpleBlock { try frame(k, &patches) }
        else if k.id == EBML.blockGroup {
          for b in try children(src, k.data, k.end) where b.id == EBML.block { try frame(b, &patches) }
        }
        q = k.end
      }
      p = e.end < 0 ? q : e.end
      if e.end < 0 && q >= end { return }
    }
  }

  private static func matroska(_ src: CubeDocClean.RandomSource, _ patches: inout [Patch]) throws {
    guard let header = try element(src, 0, src.size), header.id == EBML.header, header.end >= 0 else { return }
    let docType = try children(src, header.data, header.end).first { $0.id == EBML.docType }
    let type = try docType.map { try text(src, $0, 16) } ?? []
    if type != l1("matroska") && type != l1("webm") { return }
    guard let seg = try element(src, header.end, src.size), seg.id == EBML.segment else { return }
    let segEnd = seg.end < 0 ? src.size : seg.end
    var seen = Set<Int>()
    var queue: [Int] = []
    var head = 0
    var mjpeg = Set<Int>()   // track numbers of motion-JPEG video
    // the segment's children one after another, as far as their sizes are known (a live recording's
    // clusters may not say), then whatever the seek heads point to
    var p = seg.data
    while p < segEnd {
      guard let e = try element(src, p, segEnd), e.end >= 0 else { break }
      queue.append(e.at)
      p = e.end
    }
    while head < queue.count {
      let at = queue[head]
      head += 1
      if !seen.insert(at).inserted { continue }
      guard let e = try element(src, at, segEnd), e.end >= 0 else { continue }
      if e.id == EBML.seekHead {
        for seek in try children(src, e.data, e.end) where seek.id == EBML.seek {
          let kids = try children(src, seek.data, seek.end)
          guard let sid = kids.first(where: { $0.id == EBML.seekID }),
                let pos = kids.first(where: { $0.id == EBML.seekPosition }) else { continue }
          let target = try uint(src, sid)
          if target == EBML.info || target == EBML.tags || target == EBML.attachments || target == EBML.seekHead || target == EBML.tracks ||
             target == EBML.chapters {
            queue.append(seg.data + (try uint(src, pos)))
          }
        }
      } else if e.id == EBML.info {
        for k in try children(src, e.data, e.end) {
          if k.id == EBML.title || k.id == EBML.muxingApp || k.id == EBML.writingApp {
            CubeDocClean.zeroPatches(&patches, k.data, k.end - k.data)   // an empty string
          } else if k.id == EBML.crc32 { voidElement(k, &patches) }
        }
      } else if e.id == EBML.tracks {
        for t in try children(src, e.data, e.end) where t.id == EBML.trackEntry {
          try codecPrivate(src, t, &patches)
          let kids = try children(src, t.data, t.end)
          for k in kids where k.id == EBML.name { CubeDocClean.zeroPatches(&patches, k.data, k.end - k.data) }   // an empty name
          if let idEl = kids.first(where: { $0.id == EBML.codecID }), let num = kids.first(where: { $0.id == EBML.trackNumber }),
             try text(src, idEl, 64) == l1("V_MJPEG") { mjpeg.insert(try uint(src, num)) }
        }
      } else if e.id == EBML.chapters {
        try chapterTitles(src, e, 0, &patches)
      } else if e.id == EBML.tags {
        voidElement(e, &patches)
      } else if e.id == EBML.attachments {
        let kids = try children(src, e.data, e.end)
        let files = kids.filter { $0.id == EBML.attachedFile }
        var images: [El] = []
        for f in files {
          if let mime = try children(src, f.data, f.end).first(where: { $0.id == EBML.fileMimeType }),
             has(try read(src, mime.data, min(6, mime.end - mime.data)), 0, "image/") { images.append(f) }
        }
        if !images.isEmpty && images.count == files.count { voidElement(e, &patches) }
        else if !images.isEmpty {
          for f in images { voidElement(f, &patches) }
          for k in kids where k.id == EBML.crc32 { voidElement(k, &patches) }
        }
      }
    }
    if !mjpeg.isEmpty { try mjpegClusters(src, seg.data, segEnd, mjpeg, &patches) }
  }

  /// A track's codec setup, where Matroska keeps what Ogg and FLAC files keep in their headers: the
  /// Vorbis or Theora comment header (the second of three Xiph-laced packets) is emptied, and FLAC's
  /// metadata blocks are cleaned as in a FLAC file.
  private static func codecPrivate(_ src: CubeDocClean.RandomSource, _ track: El, _ patches: inout [Patch]) throws {
    let kids = try children(src, track.data, track.end)
    guard let idEl = kids.first(where: { $0.id == EBML.codecID }),
          let cp = kids.first(where: { $0.id == EBML.codecPrivate }) else { return }
    let codec = try text(src, idEl, 32)
    let n = cp.end - cp.data
    if codec == l1("A_FLAC") {
      if n >= 4, has(try read(src, cp.data, 4), 0, "fLaC") { try flac(src, cp.data + 4, &patches, cp.end) }
      return
    }
    if codec != l1("A_VORBIS") && codec != l1("V_THEORA") { return }
    let head = try read(src, cp.data, min(n, 64))
    if head.first != 2 { return }   // three packets
    var sizes: [Int] = []
    var q = 1
    for _ in 0..<2 {
      var size = 0
      while true {
        if q >= head.count { return }
        size += Int(head[q])
        q += 1
        if head[q - 1] != 255 { break }
      }
      sizes.append(size)
    }
    let at = cp.data + q + sizes[0]
    if at + sizes[1] > cp.end { return }
    let s = OggStream(codec: codec == l1("A_VORBIS") ? "vorbis" : "theora", packet: 1, done: true, headers: 0)
    guard let clean = oggPacket(s, try read(src, at, min(16, sizes[1])), sizes[1]) else { return }
    patches.append(Patch(at: at, bytes: clean))
    CubeDocClean.zeroPatches(&patches, at + clean.count, sizes[1] - clean.count)
  }
}
