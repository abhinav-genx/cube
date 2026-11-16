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
    print(failures == 0 ? "all \(cases.count) vectors pass" : "\(failures) FAILED")
    exit(failures == 0 ? 0 : 1)
  }
}
