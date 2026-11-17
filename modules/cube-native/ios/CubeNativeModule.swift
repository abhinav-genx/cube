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

  /// Exports prepared on the JS thread (key copied out of JavaScript) and run in the background.
  private var exports: [Int: (path: URL, key: Data, format: Int)] = [:]
  /// Photo imports prepared on the JS thread (file key copied out of JavaScript), run in the background.
  private var imports: [Int: Data] = [:]
  private var nextExport = 1
  private let exportsLock = NSLock()

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

    // ---- native preview and export: decrypted bytes never enter JavaScript ----------------
    Function("nativePreviewAvailable") { () -> Bool in
      true
    }

    /// Decrypts a vault blob (format 1: vault key; 2: chunked, per-file key) and decodes it as an
    /// image in native memory; returns a handle for CubeImageView. The plaintext is zeroed once decoded.
    Function("openImage") { (uri: String, key: Uint8Array, format: Int) throws -> Int in
      var plain = try Self.decrypt(uri, key: key, format: format)
      defer { plain.resetBytes(in: 0..<plain.count) }
      // Decode now (not lazily) so the plaintext can be wiped right after.
      guard let source = UIImage(data: plain), let image = Self.decoded(source) else {
        throw Exception(name: "Image", description: "Not an image this phone can show", code: "E_IMAGE")
      }
      return CubeImageStore.shared.put(image)
    }

    /// Decrypts a text file natively and keeps it for CubeImageView (up to maxBytes; longer files
    /// are cut, with a note). Swift strings cannot be wiped either, but they stay out of the JS heap.
    Function("openText") { (uri: String, key: Uint8Array, format: Int, maxBytes: Int) throws -> Int in
      var plain = try Self.decrypt(uri, key: key, format: format)
      defer { plain.resetBytes(in: 0..<plain.count) }
      var text = String(decoding: plain.prefix(maxBytes), as: UTF8.self)
      if plain.count > maxBytes { text += "\n\n…" }
      return CubeImageStore.shared.put(text)
    }

    Function("closeImage") { (handle: Int) in
      CubeImageStore.shared.remove(handle)
    }

    /// Export in two steps: prepare (on the JS thread, where the key's typed array can be read)
    /// copies the key; runExport decrypts into the destination in the background, streaming
    /// chunked files 64 KiB at a time.
    Function("prepareExport") { (uri: String, key: Uint8Array, format: Int) -> Int in
      let k = Data(bytes: key.rawPointer, count: key.byteLength)
      self.exportsLock.lock(); defer { self.exportsLock.unlock() }
      let id = self.nextExport
      self.nextExport += 1
      self.exports[id] = (Self.url(uri), k, format)
      return id
    }

    AsyncFunction("runExport") { (id: Int, destUri: String) throws in
      self.exportsLock.lock()
      let job = self.exports.removeValue(forKey: id)
      self.exportsLock.unlock()
      guard var job = job else {
        throw Exception(name: "Export", description: "No such export", code: "E_EXPORT")
      }
      defer { job.key.resetBytes(in: 0..<job.key.count) }
      let dest = Self.url(destUri)
      do {
        if job.format == 2 {
          try CubeCrypto.streamV2(key: job.key, from: job.path, to: dest)
        } else {
          var plain = try CubeCrypto.openV1(key: job.key, blob: try Data(contentsOf: job.path))
          defer { plain.resetBytes(in: 0..<plain.count) }
          try plain.write(to: dest)
        }
      } catch {
        try? FileManager.default.removeItem(at: dest)
        throw Exception(name: "Corrupt", description: "Could not export", code: "E_CORRUPT")
      }
    }

    /// Photo import in two steps, like export: prepare copies the new file's key; runImport reads the
    /// picked photo, removes its location and camera details (CubeStrip, the same bytes as
    /// lib/strip.ts) and writes it encrypted to destUri, all natively: the photo never enters JavaScript.
    Function("prepareImport") { (key: Uint8Array) -> Int in
      let k = Data(bytes: key.rawPointer, count: key.byteLength)
      self.exportsLock.lock(); defer { self.exportsLock.unlock() }
      let id = self.nextExport
      self.nextExport += 1
      self.imports[id] = k
      return id
    }

    AsyncFunction("runImport") { (id: Int, srcUri: String, destUri: String) throws -> [String: Int] in
      self.exportsLock.lock()
      let key = self.imports.removeValue(forKey: id)
      self.exportsLock.unlock()
      guard var key = key else {
        throw Exception(name: "Import", description: "No such import", code: "E_IMPORT")
      }
      defer { key.resetBytes(in: 0..<key.count) }
      var raw = [UInt8](try Data(contentsOf: Self.url(srcUri)))
      var clean = CubeStrip.strip(raw)
      for i in raw.indices { raw[i] = 0 }
      defer { for i in clean.indices { clean[i] = 0 } }
      var plain = Data(clean)
      defer { plain.resetBytes(in: 0..<plain.count) }
      let blob = try CubeCrypto.encryptV2(key: key, plain: plain)
      try blob.write(to: Self.url(destUri))
      return ["size": plain.count, "blobBytes": blob.count]
    }

    /// iOS always uses the system keyboard for secure text fields, so there is nothing to report.
    Function("keyboardInfo") { () -> String? in
      nil
    }

    View(CubeImageView.self) {
      Prop("handle") { (view: CubeImageView, handle: Int) in
        view.show(CubeImageStore.shared.get(handle))
      }
      Prop("textColor") { (view: CubeImageView, color: String?) in
        view.setTextColor(color)
      }
      Prop("fontSize") { (view: CubeImageView, size: Double?) in
        view.setFontSize(size)
      }
    }
  }

  private static func url(_ uri: String) -> URL {
    uri.hasPrefix("file://") ? URL(string: uri)! : URL(fileURLWithPath: uri)
  }

  private static func decrypt(_ uri: String, key: Uint8Array, format: Int) throws -> Data {
    var k = Data(bytes: key.rawPointer, count: key.byteLength)
    defer { k.resetBytes(in: 0..<k.count) }
    do {
      return try CubeCrypto.open(format: format, key: k, blob: try Data(contentsOf: url(uri)))
    } catch {
      throw Exception(name: "Corrupt", description: "Could not decrypt", code: "E_CORRUPT")
    }
  }

  /// Forces a full decode into a bitmap, so the compressed plaintext is no longer needed.
  private static func decoded(_ image: UIImage) -> UIImage? {
    let renderer = UIGraphicsImageRenderer(size: image.size, format: {
      let f = UIGraphicsImageRendererFormat()
      f.scale = image.scale
      return f
    }())
    return renderer.image { _ in image.draw(at: .zero) }
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
        return
      }
      let code: String
      switch (error as? LAError)?.code {
      case .userCancel?, .appCancel?, .systemCancel?, .userFallback?: code = "E_AUTH_CANCELLED"
      case .biometryLockout?: code = "E_AUTH_LOCKOUT"
      case .passcodeNotSet?: code = "E_NO_LOCK_SCREEN"
      default: code = "E_AUTH_FAILED"
      }
      promise.reject(Exception(name: "Auth", description: error?.localizedDescription ?? "Cancelled", code: code))
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

/// Decoded images and decrypted texts by handle.
final class CubeImageStore {
  static let shared = CubeImageStore()
  private var images: [Int: Any] = [:]
  private var next = 1
  private let lock = NSLock()

  func put(_ image: Any) -> Int {
    lock.lock(); defer { lock.unlock() }
    let h = next
    next += 1
    images[h] = image
    return h
  }

  func get(_ h: Int) -> Any? {
    lock.lock(); defer { lock.unlock() }
    return images[h]
  }

  func remove(_ h: Int) {
    lock.lock(); defer { lock.unlock() }
    images[h] = nil
  }
}

/// Shows what a handle refers to: an image (fit to the view) or text (scrolling, not selectable).
class CubeImageView: ExpoView {
  private let imageView = UIImageView()
  private let textView = UITextView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit
    // Under the new architecture layoutSubviews is not reliably called on this view, so the
    // subviews follow the view's size through autoresizing instead.
    for v in [imageView, textView] as [UIView] {
      v.frame = bounds
      v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      addSubview(v)
    }
    textView.isEditable = false
    textView.isSelectable = false
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20)
    textView.font = .systemFont(ofSize: 16)
    textView.isHidden = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    textView.frame = bounds
  }

  func show(_ item: Any?) {
    imageView.frame = bounds
    textView.frame = bounds
    if let image = item as? UIImage {
      imageView.image = image
      imageView.isHidden = false
      textView.isHidden = true
    } else if let text = item as? String {
      textView.text = text
      textView.isHidden = false
      imageView.isHidden = true
    } else {
      imageView.image = nil
      textView.text = ""
    }
  }

  func setTextColor(_ hex: String?) {
    guard let hex = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), hex.count == 6,
          let v = UInt32(hex, radix: 16) else { return }
    textView.textColor = UIColor(
      red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
      blue: CGFloat(v & 0xFF) / 255, alpha: 1
    )
  }

  func setFontSize(_ size: Double?) {
    if let size = size { textView.font = .systemFont(ofSize: CGFloat(size)) }
  }
}
