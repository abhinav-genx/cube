import CryptoKit
import ExpoModulesCore
import LocalAuthentication
import Security
import UIKit

/// iOS side of Cube's native module.
///
/// The PIN step: the Secure Enclave has no HMAC keys, so Cube uses ECDH instead. A P-256 private
/// key is generated inside the Secure Enclave and can never leave it. For each PIN guess,
/// Argon2id(PIN) is turned into a P-256 point P (Argon2id output as a scalar d, P = d·G), and the
/// enclave computes ECDH(enclave key, P). The result, hashed, is the slot key. Without the enclave
/// key nobody can compute it, so every guess has to run on this iPhone, behind Face ID / Touch ID
/// or the passcode. With user presence required, each prompt authorises exactly one operation.
///
/// Also: backup exclusion for the vault folder.
public class CubeNativeModule: Module {
  /// A context the user has just authenticated, used for exactly one key operation.
  private var authorized: LAContext?

  public func definition() -> ModuleDefinition {
    Name("CubeNative")

    Function("hardwareKeysAvailable") { () -> Bool in
      true
    }

    Function("hasKey") { (alias: String) -> Bool in
      Self.findKey(alias, context: nil) != nil
    }

    Function("deleteKey") { (alias: String) in
      self.authorized = nil
      SecItemDelete(Self.keyQuery(alias) as CFDictionary)
    }

    Function("createKey") { (alias: String, requireAuth: Bool, requireHardware: Bool) throws in
      try self.createKey(alias, requireAuth: requireAuth, requireHardware: requireHardware)
    }

    AsyncFunction("authenticate") { (alias: String, title: String, promise: Promise) in
      self.authenticate(alias, title: title, promise: promise)
    }

    Function("mac") { (alias: String, data: Uint8Array, out: Uint8Array) throws in
      try self.keyedStep(alias, data: data, out: out)
    }

    /// Marks a file or folder (and, for a folder, everything in it) as excluded from iCloud and
    /// computer backups, so the vault's ciphertext never leaves the phone.
    Function("excludeFromBackup") { (uri: String) throws in
      var url = uri.hasPrefix("file://") ? URL(string: uri)! : URL(fileURLWithPath: uri)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }

    // ---- native image preview (A8): decrypted pixels never enter JavaScript ----------------
    Function("nativePreviewAvailable") { () -> Bool in
      true
    }

    /// Decrypts a vault blob and decodes it as an image in native memory; returns a handle for
    /// CubeImageView. The plaintext bytes are zeroed once the image is decoded.
    Function("openImage") { (uri: String, key: Uint8Array) throws -> Int in
      var k = Data(bytes: key.rawPointer, count: key.byteLength)
      defer { k.resetBytes(in: 0..<k.count) }
      let url = uri.hasPrefix("file://") ? URL(string: uri)! : URL(fileURLWithPath: uri)
      var plain = try CubeBlob.open(key: k, blob: try Data(contentsOf: url))
      defer { plain.resetBytes(in: 0..<plain.count) }
      // Decode now (not lazily) so the plaintext can be wiped right after.
      guard let source = UIImage(data: plain), let image = CubeBlob.decoded(source) else {
        throw Exception(name: "Image", description: "Not an image this phone can show", code: "E_IMAGE")
      }
      return CubeImageStore.shared.put(image)
    }

    Function("closeImage") { (handle: Int) in
      CubeImageStore.shared.remove(handle)
    }

    View(CubeImageView.self) {
      Prop("handle") { (view: CubeImageView, handle: Int) in
        view.show(CubeImageStore.shared.get(handle))
      }
    }
  }

  // MARK: - Keys

  private static func tag(_ alias: String) -> Data { Data(alias.utf8) }

  private static func keyQuery(_ alias: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    ]
  }

  private static func findKey(_ alias: String, context: LAContext?) -> SecKey? {
    var query = keyQuery(alias)
    query[kSecReturnRef as String] = true
    if let context = context { query[kSecUseAuthenticationContext as String] = context }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item = item else { return nil }
    return (item as! SecKey)
  }

  /// The key's label records whether it needs the user ("auth") or not ("noauth", testing builds).
  private static func needsAuth(_ alias: String) -> Bool {
    var query = keyQuery(alias)
    query[kSecReturnAttributes as String] = true
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let attrs = item as? [String: Any] else { return true }
    return (attrs[kSecAttrLabel as String] as? String) != "noauth"
  }

  private func createKey(_ alias: String, requireAuth: Bool, requireHardware: Bool) throws {
    authorized = nil
    SecItemDelete(Self.keyQuery(alias) as CFDictionary)

    if requireHardware && !SecureEnclave.isAvailable {
      throw Exception(name: "NoSecureHardware", description: "This device cannot keep keys in secure hardware", code: "E_NO_SECURE_HARDWARE")
    }

    var flags: SecAccessControlCreateFlags = []
    if requireHardware { flags.insert(.privateKeyUsage) }
    if requireAuth { flags.insert(.userPresence) }   // Face ID / Touch ID, or the passcode
    var cfError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &cfError
    ) else {
      throw Exception(name: "KeyCreation", description: "Could not create the key's access policy", code: "E_KEY_CREATE")
    }

    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrLabel as String: requireAuth ? "auth" : "noauth",
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: Self.tag(alias),
        kSecAttrAccessControl as String: access,
      ],
    ]
    if requireHardware { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }

    guard SecKeyCreateRandomKey(attributes as CFDictionary, &cfError) != nil else {
      let reason = (cfError?.takeRetainedValue()).map { "\($0)" } ?? "unknown"
      // Most often: no passcode set, so a user-presence key cannot exist.
      throw Exception(name: "NoLockScreen", description: "Set a device passcode first (\(reason))", code: "E_NO_LOCK_SCREEN")
    }
  }

  // MARK: - Authentication

  private func authenticate(_ alias: String, title: String, promise: Promise) {
    authorized = nil
    guard Self.findKey(alias, context: nil) != nil else {   // a key reference needs no prompt
      promise.reject(Exception(name: "NoKey", description: "No hardware key", code: "E_NO_KEY"))
      return
    }
    if !Self.needsAuth(alias) {
      promise.resolve(nil)                       // testing builds: no prompt
      return
    }
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: title) { ok, error in
      if ok {
        self.authorized = context
        promise.resolve(nil)
      } else {
        promise.reject(Exception(
          name: "AuthCancelled",
          description: error?.localizedDescription ?? "Cancelled",
          code: "E_AUTH_CANCELLED"
        ))
      }
    }
  }

  // MARK: - The keyed step

  private func keyedStep(_ alias: String, data: Uint8Array, out: Uint8Array) throws {
    let context = authorized
    authorized = nil
    defer { context?.invalidate() }               // one operation per prompt

    guard let key = Self.findKey(alias, context: context) else {
      throw Exception(name: "NoKey", description: "No hardware key", code: "E_NO_KEY")
    }

    var input = Data(bytes: data.rawPointer, count: data.byteLength)
    defer { input.resetBytes(in: 0..<input.count) }

    // Argon2id output → a valid P-256 scalar d (re-hash in the ~2^-32 case it is out of range),
    // then the public point P = d·G.
    var scalar = input
    var point: P256.KeyAgreement.PublicKey?
    for counter in 0..<8 {
      if let d = try? P256.KeyAgreement.PrivateKey(rawRepresentation: scalar) {
        point = d.publicKey
        break
      }
      scalar = Data(SHA256.hash(data: input + Data([UInt8(counter)])))
    }
    guard let point = point,
          let peer = SecKeyCreateWithData(
            point.x963Representation as CFData,
            [
              kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
              kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
              kSecAttrKeySizeInBits as String: 256,
            ] as CFDictionary,
            nil
          )
    else {
      throw Exception(name: "KeyUse", description: "Could not derive the PIN point", code: "E_KEY_USE")
    }

    var cfError: Unmanaged<CFError>?
    guard let shared = SecKeyCopyKeyExchangeResult(
      key, .ecdhKeyExchangeStandard, peer, [:] as CFDictionary, &cfError
    ) as Data? else {
      let reason = (cfError?.takeRetainedValue()).map { "\($0)" } ?? "unknown"
      throw Exception(name: "KeyUse", description: "The hardware key refused the operation: \(reason)", code: "E_KEY_USE")
    }

    // Domain-separated hash of the shared secret is the 32-byte result.
    var digest = Data(SHA256.hash(data: Data("cube-se-v1".utf8) + shared))
    defer { digest.resetBytes(in: 0..<digest.count) }
    digest.withUnsafeBytes { buf in
      out.rawPointer.copyMemory(from: buf.baseAddress!, byteCount: min(buf.count, out.byteLength))
    }
  }
}

// MARK: - Native preview helpers

final class CubeImageStore {
  static let shared = CubeImageStore()
  private var images: [Int: UIImage] = [:]
  private var next = 1
  private let lock = NSLock()

  func put(_ image: UIImage) -> Int {
    lock.lock(); defer { lock.unlock() }
    let h = next
    next += 1
    images[h] = image
    return h
  }

  func get(_ h: Int) -> UIImage? {
    lock.lock(); defer { lock.unlock() }
    return images[h]
  }

  func remove(_ h: Int) {
    lock.lock(); defer { lock.unlock() }
    images[h] = nil
  }
}

class CubeImageView: ExpoView {
  private let imageView = UIImageView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit
    // Under the new architecture layoutSubviews is not reliably called on this view, so the
    // image view follows the view's size through autoresizing instead.
    imageView.frame = bounds
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(imageView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
  }

  func show(_ image: UIImage?) {
    imageView.frame = bounds
    imageView.image = image
  }
}

enum CubeBlob {
  /// Opens a blob written by lib/vault.ts encryptBlob: nonce(24) || ciphertext || tag(16),
  /// plaintext padded with 0x80 then zeros. XChaCha20-Poly1305-IETF = HChaCha20 on the first 16
  /// nonce bytes, then ChaCha20-Poly1305-IETF with nonce 00000000 || the last 8 bytes.
  static func open(key: Data, blob: Data) throws -> Data {
    guard key.count == 32, blob.count >= 24 + 16 else {
      throw Exception(name: "Corrupt", description: "corrupt", code: "E_CORRUPT")
    }
    let b = [UInt8](blob)
    var sub = hchacha20(key: [UInt8](key), nonce: Array(b[0..<16]))
    defer { for i in sub.indices { sub[i] = 0 } }
    let nonce = Data([0, 0, 0, 0] + b[16..<24])
    var padded: Data
    do {
      let box = try ChaChaPoly.SealedBox(
        nonce: ChaChaPoly.Nonce(data: nonce),
        ciphertext: Data(b[24..<(b.count - 16)]),
        tag: Data(b[(b.count - 16)...])
      )
      padded = try ChaChaPoly.open(box, using: SymmetricKey(data: Data(sub)))
    } catch {
      throw Exception(name: "Corrupt", description: "Could not decrypt", code: "E_CORRUPT")
    }
    var end = padded.count - 1
    while end >= 0 && padded[padded.startIndex + end] == 0 { end -= 1 }
    guard end >= 0, padded[padded.startIndex + end] == 0x80 else {
      padded.resetBytes(in: 0..<padded.count)
      throw Exception(name: "Corrupt", description: "corrupt", code: "E_CORRUPT")
    }
    let out = padded.prefix(end)
    let result = Data(out)
    padded.resetBytes(in: 0..<padded.count)
    return result
  }

  /// Forces a full decode into a bitmap, so the compressed plaintext is no longer needed.
  static func decoded(_ image: UIImage) -> UIImage? {
    let renderer = UIGraphicsImageRenderer(size: image.size, format: {
      let f = UIGraphicsImageRendererFormat()
      f.scale = image.scale
      return f
    }())
    return renderer.image { _ in image.draw(at: .zero) }
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
    return out
  }
}
