import CryptoKit
import Foundation

/// Opens the blobs lib/vault.ts writes. Foundation and CryptoKit only (no Expo), so it compiles on
/// its own and is checked against vectors from the JavaScript implementation (tests/native/).
///
/// v1: nonce(24) || XChaCha20-Poly1305(key, padded plaintext) — files added before per-file keys.
/// v2: prefix(16) || chunk_0 … chunk_{n-1}; chunk_i = XChaCha20-Poly1305(fileKey,
///     nonce = prefix || u64be(i, top bit set on the last chunk)) of 64 KiB, padded at the end.
/// Padding (both): 0x80 then zeros.
///
/// XChaCha20-Poly1305-IETF is HChaCha20(key, nonce[0..<16]) as the key for ChaCha20-Poly1305-IETF
/// with nonce 00000000 || nonce[16..<24].
enum CubeCrypto {
  static let chunk = 64 * 1024
  static let tag = 16
  static let prefix = 16
  static let chunkCipher = chunk + tag

  struct Corrupt: Error {}

  static func open(format: Int, key: Data, blob: Data) throws -> Data {
    format == 2 ? try openV2(key: key, blob: blob) : try openV1(key: key, blob: blob)
  }

  static func openV1(key: Data, blob: Data) throws -> Data {
    guard key.count == 32, blob.count >= 24 + tag else { throw Corrupt() }
    let b = [UInt8](blob)
    var sub = hchacha20(key: [UInt8](key), nonce: Array(b[0..<16]))
    defer { for i in sub.indices { sub[i] = 0 } }
    var padded = try aead(sub: sub, nonce: Data([0, 0, 0, 0] + b[16..<24]), sealed: b[24...])
    defer { padded.resetBytes(in: 0..<padded.count) }
    let length = try unpad(&padded)
    return Data(padded.prefix(length))
  }

  static func chunkCount(_ blobBytes: Int) -> Int {
    let body = blobBytes - prefix
    return body > 0 && body % chunkCipher == 0 ? body / chunkCipher : 0
  }

  static func openV2(key: Data, blob: Data) throws -> Data {
    let n = chunkCount(blob.count)
    guard key.count == 32, n > 0 else { throw Corrupt() }
    let b = [UInt8](blob)
    var sub = hchacha20(key: [UInt8](key), nonce: Array(b[0..<prefix]))
    defer { for i in sub.indices { sub[i] = 0 } }
    var out = Data(capacity: n * chunk)
    do {
      for i in 0..<n {
        let at = prefix + i * chunkCipher
        var plain = try aead(sub: sub, nonce: chunkNonce(i, last: i == n - 1), sealed: b[at..<(at + chunkCipher)])
        defer { plain.resetBytes(in: 0..<plain.count) }
        let length = i == n - 1 ? try unpad(&plain) : plain.count
        out.append(plain.prefix(length))
      }
    } catch {
      out.resetBytes(in: 0..<out.count)
      throw error
    }
    return out
  }

  /// Decrypts a v2 blob file into `dest`, one chunk at a time (constant memory).
  static func streamV2(key: Data, from src: URL, to dest: URL) throws {
    let size = (try FileManager.default.attributesOfItem(atPath: src.path)[.size] as? NSNumber)?.intValue ?? 0
    let n = chunkCount(size)
    guard key.count == 32, n > 0 else { throw Corrupt() }
    let input = try FileHandle(forReadingFrom: src)
    defer { try? input.close() }
    guard FileManager.default.createFile(atPath: dest.path, contents: nil) else { throw Corrupt() }
    let output = try FileHandle(forWritingTo: dest)
    defer { try? output.close() }
    let head = try readExactly(input, prefix)
    var sub = hchacha20(key: [UInt8](key), nonce: [UInt8](head))
    defer { for i in sub.indices { sub[i] = 0 } }
    for i in 0..<n {
      let sealed = [UInt8](try readExactly(input, chunkCipher))
      var plain = try aead(sub: sub, nonce: chunkNonce(i, last: i == n - 1), sealed: sealed[...])
      defer { plain.resetBytes(in: 0..<plain.count) }
      let length = i == n - 1 ? try unpad(&plain) : plain.count
      try output.write(contentsOf: plain.prefix(length))
    }
  }

  private static func readExactly(_ h: FileHandle, _ n: Int) throws -> Data {
    var out = Data()
    while out.count < n {
      guard let part = try h.read(upToCount: n - out.count), !part.isEmpty else { throw Corrupt() }
      out.append(part)
    }
    return out
  }

  private static func chunkNonce(_ index: Int, last: Bool) -> Data {
    var n = [UInt8](repeating: 0, count: 12)
    if last { n[4] = 0x80 }
    let i = UInt32(index)
    n[8] = UInt8(i >> 24); n[9] = UInt8((i >> 16) & 0xFF); n[10] = UInt8((i >> 8) & 0xFF); n[11] = UInt8(i & 0xFF)
    return Data(n)
  }

  private static func aead(sub: [UInt8], nonce: Data, sealed: ArraySlice<UInt8>) throws -> Data {
    guard sealed.count >= tag else { throw Corrupt() }
    do {
      let box = try ChaChaPoly.SealedBox(
        nonce: ChaChaPoly.Nonce(data: nonce),
        ciphertext: Data(sealed.dropLast(tag)),
        tag: Data(sealed.suffix(tag))
      )
      return try ChaChaPoly.open(box, using: SymmetricKey(data: Data(sub)))
    } catch {
      throw Corrupt()
    }
  }

  /// Length before the 0x80-then-zeros padding; wipes `padded` and throws if it is malformed.
  private static func unpad(_ padded: inout Data) throws -> Int {
    var end = padded.count - 1
    while end >= 0 && padded[padded.startIndex + end] == 0 { end -= 1 }
    guard end >= 0, padded[padded.startIndex + end] == 0x80 else {
      padded.resetBytes(in: 0..<padded.count)
      throw Corrupt()
    }
    return end
  }

  static func hchacha20(key: [UInt8], nonce: [UInt8]) -> [UInt8] {
    func le(_ b: [UInt8], _ i: Int) -> UInt32 {
      UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
    var x = [UInt32](repeating: 0, count: 16)
    x[0] = 0x6170_7865; x[1] = 0x3320_646E; x[2] = 0x7962_2D32; x[3] = 0x6B20_6574
    for i in 0..<8 { x[4 + i] = le(key, i * 4) }
    for i in 0..<4 { x[12 + i] = le(nonce, i * 4) }
    func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }
    func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
      x[a] = x[a] &+ x[b]; x[d] = rotl(x[d] ^ x[a], 16)
      x[c] = x[c] &+ x[d]; x[b] = rotl(x[b] ^ x[c], 12)
      x[a] = x[a] &+ x[b]; x[d] = rotl(x[d] ^ x[a], 8)
      x[c] = x[c] &+ x[d]; x[b] = rotl(x[b] ^ x[c], 7)
    }
    for _ in 0..<10 {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
    }
    var out = [UInt8](repeating: 0, count: 32)
    let words = [x[0], x[1], x[2], x[3], x[12], x[13], x[14], x[15]]
    for i in 0..<8 { for j in 0..<4 { out[i * 4 + j] = UInt8((words[i] >> (8 * UInt32(j))) & 0xFF) } }
    for i in x.indices { x[i] = 0 }
    return out
  }
}
