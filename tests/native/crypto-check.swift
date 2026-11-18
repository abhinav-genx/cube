// Checks modules/cube-native/ios/CubeCrypto.swift against vectors from tests/native/make-vectors.mjs.
//   swiftc -parse-as-library modules/cube-native/ios/CubeCrypto.swift modules/cube-native/ios/CubeStrip.swift \
//     modules/cube-native/ios/CubeDocClean.swift tests/native/crypto-check.swift -o /tmp/cc
//   /tmp/cc <vectors-dir>
import Foundation

struct Case: Decodable { let name: String; let format: Int; let ok: Bool }

@main
struct CryptoCheck {
  static func main() throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: dir.appendingPathComponent("manifest.json")))
    var failures = 0
    for c in cases {
      let read = { (ext: String) in try! Data(contentsOf: dir.appendingPathComponent("\(c.name).\(ext)")) }
      let key = read("key"), plain = read("plain"), blobURL = dir.appendingPathComponent("\(c.name).blob")
      var whole = "", streamed = "-"
      do {
        let out = try CubeCrypto.open(format: c.format, key: key, blob: read("blob"))
        whole = out == plain ? "ok" : "WRONG BYTES"
      } catch { whole = "threw" }
      if c.format == 2 {
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent("cc-\(c.name)")
        do {
          try CubeCrypto.streamV2(key: key, from: blobURL, to: dest)
          streamed = (try Data(contentsOf: dest)) == plain ? "ok" : "WRONG BYTES"
        } catch { streamed = "threw" }
        try? FileManager.default.removeItem(at: dest)
      }
      let pass = c.ok ? (whole == "ok" && (streamed == "ok" || streamed == "-")) : (whole == "threw" && (streamed == "threw" || streamed == "-"))
      if !pass { failures += 1 }
      print("\(pass ? "PASS" : "FAIL") \(c.name): whole=\(whole) stream=\(streamed)")
    }
    // Metadata removal: CubeStrip must give exactly the JavaScript output for every input.
    let stripDir = dir.appendingPathComponent("strip")
    let ins = (try? FileManager.default.contentsOfDirectory(atPath: stripDir.path))?.filter { $0.hasSuffix(".in") }.sorted() ?? []
    for name in ins {
      let input = [UInt8](try Data(contentsOf: stripDir.appendingPathComponent(name)))
      let expect = [UInt8](try Data(contentsOf: stripDir.appendingPathComponent(String(name.dropLast(3)) + ".out")))
      let ok = CubeStrip.strip(input) == expect
      if !ok { failures += 1 }
      print("\(ok ? "PASS" : "FAIL") strip \(name.dropLast(3))")
    }
    // Encryption: blobs for tests/native/check-native-out.mjs to decrypt in JavaScript.
    let outDir = dir.appendingPathComponent("out")
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let key = Data((0..<32).map { UInt8(($0 * 7 + 3) & 0xFF) })
    for n in [0, 1, 65_535, 65_536, 200_000] {
      let plain = Data((0..<n).map { UInt8((($0 * 31) ^ ($0 >> 9)) & 0xFF) })
      let blob = try CubeCrypto.encryptV2(key: key, plain: plain)
      let back = try CubeCrypto.openV2(key: key, blob: blob)
      if back != plain { failures += 1; print("FAIL swift encrypt round trip \(n)") }
      try blob.write(to: outDir.appendingPathComponent("swift-\(n).blob"))
      try plain.write(to: outDir.appendingPathComponent("swift-\(n).plain"))
      try key.write(to: outDir.appendingPathComponent("swift-\(n).key"))
    }
    // Streaming encryption: V2Writer fed in uneven pieces must give a blob JavaScript reads back.
    for n in [0, 1, 65_535, 65_536, 65_537, 300_001] {
      let plain = [UInt8]((0..<n).map { UInt8((($0 * 13) ^ ($0 >> 7)) & 0xFF) })
      var blob = Data()
      let w = try CubeCrypto.V2Writer(key: key) { blob.append($0) }
      var at = 0, step = 1
      while at < n { let k = min(step, n - at); try w.write(Array(plain[at..<(at + k)])); at += k; step = step * 3 + 7 }
      let r = try w.finish()
      let back = try CubeCrypto.openV2(key: key, blob: blob)
      if r.size != n || r.blobBytes != blob.count || back != Data(plain) {
        failures += 1; print("FAIL swift writer \(n)")
      }
      try blob.write(to: outDir.appendingPathComponent("swift-writer-\(n).blob"))
      try Data(plain).write(to: outDir.appendingPathComponent("swift-writer-\(n).plain"))
      try key.write(to: outDir.appendingPathComponent("swift-writer-\(n).key"))
    }
    // PDFs: byte for byte the JavaScript output, in pieces of several sizes.
    let docDir = dir.appendingPathComponent("doc")
    let docs = (try? FileManager.default.contentsOfDirectory(atPath: docDir.path)) ?? []
    for name in docs.filter({ $0.hasSuffix(".in") }).sorted() {
      let input = [UInt8](try Data(contentsOf: docDir.appendingPathComponent(name)))
      let expect = [UInt8](try Data(contentsOf: docDir.appendingPathComponent(String(name.dropLast(3)) + ".out")))
      for piece in [1 << 20, 65_536, 4_093, 1] where piece >= 64 || input.count < 300_000 {
        var c = CubeDocClean.PdfCleaner()
        var got = [UInt8]()
        var at = 0
        while at < input.count { let k = min(piece, input.count - at); got += c.push(Array(input[at..<(at + k)])); at += k }
        got += c.finish()
        let ok = got == expect
        if !ok { failures += 1 }
        print("\(ok ? "PASS" : "FAIL") pdf \(name.dropLast(3)) in pieces of \(piece)")
      }
    }
    // Office: cleaned output for check-native-out.mjs, from a file and from memory (must agree).
    for name in docs.filter({ $0.hasSuffix(".office") }).sorted() {
      let url = docDir.appendingPathComponent(name)
      var fromFile = [UInt8](), fromMemory = [UInt8]()
      let changed = try CubeDocClean.cleanOffice(try CubeDocClean.FileSource(url)) { fromFile += $0 }
      _ = try CubeDocClean.cleanOffice(CubeDocClean.DataSource(data: try Data(contentsOf: url))) { fromMemory += $0 }
      if fromFile != fromMemory { failures += 1; print("FAIL office \(name): file and memory differ") }
      try Data(changed ? fromFile : [UInt8](try Data(contentsOf: url))).write(to: outDir.appendingPathComponent("swift-\(name)"))
      print("office \(name): \(changed ? "rewritten" : "unchanged")")
    }
    print(failures == 0 ? "all \(cases.count) crypto vectors, \(ins.count) strip vectors, documents and encryption pass" : "\(failures) FAILED")
    exit(failures == 0 ? 0 : 1)
  }
}
