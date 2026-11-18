// Checks modules/cube-native/ios/CubeCrypto.swift against vectors from tests/native/make-vectors.mjs.
//   swiftc -parse-as-library modules/cube-native/ios/CubeCrypto.swift tests/native/crypto-check.swift -o /tmp/cc
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
    print(failures == 0 ? "all \(cases.count) crypto vectors, \(ins.count) strip vectors and encryption pass" : "\(failures) FAILED")
    exit(failures == 0 ? 0 : 1)
  }
}
