import CryptoKit
import ExpoModulesCore
import LocalAuthentication
import PDFKit
import PhotosUI
import Security
import UIKit
import UniformTypeIdentifiers

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
  /// Files picked with pickDocument (opened in place) or pickPhoto (held in memory), by token.
  private var picks: [String: PickSource] = [:]
  /// Keeps the picker's delegate alive while it is on screen.
  private var pickerDelegate: NSObject?

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

    /// Decrypts a PDF into memory (never to storage) and opens it with PDFKit for CubeImageView.
    /// Throws if it cannot be shown (damaged, or locked with a password). The decrypted bytes stay
    /// in a buffer Cube owns, read in place by PDFKit, and are zeroed by closeImage.
    Function("openPdf") { (uri: String, key: Uint8Array, format: Int) throws -> Int in
      var plain = try Self.decrypt(uri, key: key, format: format)
      defer { plain.resetBytes(in: 0..<plain.count) }
      guard let pdf = CubePdf(plain) else {
        throw Exception(name: "Pdf", description: "Not a PDF this phone can show (damaged or password-protected)", code: "E_PDF")
      }
      return CubeImageStore.shared.put(pdf)
    }

    /// Releases an image, text or PDF (a PDF's decrypted bytes are zeroed).
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

    /// Import in two steps, like export: prepare copies the new file's key; runImport reads the picked
    /// file, cleans it by kind (photos: CubeStrip; PDF, Office/OpenDocument/EPUB, RTF and SVG:
    /// CubeDocClean; video and audio: CubeMediaClean) and writes it encrypted to destUri, streaming
    /// where it can, all natively: the file never enters JavaScript.
    Function("prepareImport") { (key: Uint8Array) -> Int in
      let k = Data(bytes: key.rawPointer, count: key.byteLength)
      self.exportsLock.lock(); defer { self.exportsLock.unlock() }
      let id = self.nextExport
      self.nextExport += 1
      self.imports[id] = k
      return id
    }

    AsyncFunction("runImport") { (id: Int, srcUri: String, destUri: String, kind: String?) throws -> [String: Int] in
      self.exportsLock.lock()
      let key = self.imports.removeValue(forKey: id)
      let pick = srcUri.hasPrefix("cube-pick:") ? self.picks[srcUri] : nil
      self.exportsLock.unlock()
      guard var key = key else {
        throw Exception(name: "Import", description: "No such import", code: "E_IMPORT")
      }
      defer { key.resetBytes(in: 0..<key.count) }
      let source: PickSource
      if let pick = pick {
        source = pick
      } else if srcUri.hasPrefix("cube-pick:") {
        throw Exception(name: "Import", description: "The picked file is gone", code: "E_IMPORT")
      } else {
        source = .url(Self.url(srcUri), scoped: false)
      }
      let dest = Self.url(destUri)
      do {
        let r = try source.withAccess {
          try source.coordinatedRead { try Self.importFile(source, kind: kind ?? "image", key: key, dest: dest) }
        }
        return ["size": r.size, "blobBytes": r.blobBytes]
      } catch let e as PickUnavailable {
        try? FileManager.default.removeItem(at: dest)
        throw Exception(name: "Unavailable", description: "The picked file cannot be read right now: \(e.reason)", code: "E_UNAVAILABLE")
      } catch {
        try? FileManager.default.removeItem(at: dest)
        throw Exception(name: "Import", description: "Could not add the file: \(error)", code: "E_IMPORT")
      }
    }

    /// Cube's document picker: the file is opened where it is (no copy in the app's folder) and
    /// read during runImport through its security scope.
    AsyncFunction("pickDocument") { (promise: Promise) in
      guard let vc = self.appContext?.utilities?.currentViewController() else {
        promise.reject(Exception(name: "Pick", description: "Nothing to present from", code: "E_PICK"))
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
      picker.allowsMultipleSelection = false
      let delegate = DocumentPickerDelegate { [weak self] url in
        self?.pickerDelegate = nil
        guard let self = self, let url = url else { promise.resolve(nil); return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let token = self.keep(.url(url, scoped: true))
        promise.resolve(["uri": token, "name": url.lastPathComponent, "mime": mime, "size": size])
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      vc.present(picker, animated: true)
    }.runOnQueue(.main)

    /// Cube's photo picker: no Photos permission (the system picker runs outside the app), and the
    /// photo is handed over in memory in its current format, never transcoded or written to a file.
    AsyncFunction("pickPhoto") { (promise: Promise) in
      guard let vc = self.appContext?.utilities?.currentViewController() else {
        promise.reject(Exception(name: "Pick", description: "Nothing to present from", code: "E_PICK"))
        return
      }
      var config = PHPickerConfiguration()
      config.filter = .images
      config.selectionLimit = 1
      config.preferredAssetRepresentationMode = .current
      let picker = PHPickerViewController(configuration: config)
      let delegate = PhotoPickerDelegate { [weak self] result in
        self?.pickerDelegate = nil
        guard let self = self, let provider = result?.itemProvider else { promise.resolve(nil); return }
        let typeId = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true } ?? UTType.image.identifier
        provider.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in
          guard let data = data else {
            promise.reject(Exception(name: "Pick", description: "The photo could not be read", code: "E_PICK"))
            return
          }
          let type = UTType(typeId)
          let ext = type?.preferredFilenameExtension ?? "jpg"
          var name = provider.suggestedName ?? "photo"
          if (name as NSString).pathExtension.isEmpty { name += ".\(ext)" }
          let token = self.keep(.data(data))
          promise.resolve(["uri": token, "name": name, "mime": type?.preferredMIMEType ?? "image/jpeg", "size": data.count])
        }
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      vc.present(picker, animated: true)
    }.runOnQueue(.main)

    /// Forgets a pick (and wipes a photo held in memory).
    Function("releasePick") { (uri: String) in
      self.exportsLock.lock()
      let pick = self.picks.removeValue(forKey: uri)
      self.exportsLock.unlock()
      if case .data(var d)? = pick { d.resetBytes(in: 0..<d.count) }
    }

    /// Shares a prepared export from memory: decrypted into memory, never into a file in the app's
    /// folder, and offered under its name. Resolves when the share sheet closes; the copy is wiped.
    AsyncFunction("shareFromMemory") { (id: Int, name: String, mime: String, promise: Promise) in
      self.exportsLock.lock()
      let job = self.exports.removeValue(forKey: id)
      self.exportsLock.unlock()
      guard var job = job else {
        promise.reject(Exception(name: "Export", description: "No such export", code: "E_EXPORT"))
        return
      }
      let held: SharedBytes
      do {
        defer { job.key.resetBytes(in: 0..<job.key.count) }
        held = SharedBytes(try CubeCrypto.open(format: job.format, key: job.key, blob: try Data(contentsOf: job.path)))
      } catch {
        promise.reject(Exception(name: "Corrupt", description: "Could not decrypt", code: "E_CORRUPT"))
        return
      }
      DispatchQueue.main.async {
        guard let vc = self.appContext?.utilities?.currentViewController() else {
          held.wipe()
          promise.reject(Exception(name: "Export", description: "Nothing to present from", code: "E_EXPORT"))
          return
        }
        let provider = NSItemProvider()
        let typeId = UTType(mimeType: mime)?.identifier ?? UTType.data.identifier
        provider.registerDataRepresentation(forTypeIdentifier: typeId, visibility: .all) { completion in
          completion(held.data, nil)
          return nil
        }
        provider.suggestedName = name
        let items = UIActivityItemsConfiguration(itemProviders: [provider])
        items.metadataProvider = { key in key == .title ? name : nil }   // the sheet's header shows the name
        let sheet = UIActivityViewController(activityItemsConfiguration: items)
        sheet.completionWithItemsHandler = { _, _, _, _ in
          held.wipe()
          promise.resolve(nil)
        }
        sheet.popoverPresentationController?.sourceView = vc.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
        vc.present(sheet, animated: true)
      }
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

  private func keep(_ source: PickSource) -> String {
    exportsLock.lock(); defer { exportsLock.unlock() }
    let token = "cube-pick:\(nextExport)"
    nextExport += 1
    picks[token] = source
    return token
  }

  /// Reads, cleans and encrypts one picked file into dest (a v2 blob) by kind; see index.ts runImport.
  private static func importFile(_ source: PickSource, kind: String, key: Data, dest: URL) throws -> (size: Int, blobBytes: Int) {
    guard FileManager.default.createFile(atPath: dest.path, contents: nil) else { throw CubeCrypto.Corrupt() }
    let out = try FileHandle(forWritingTo: dest)
    defer { try? out.close() }
    let writer = try CubeCrypto.V2Writer(key: key) { try out.write(contentsOf: $0) }

    switch kind {
    case "image":
      // Photos are cleaned whole (their metadata can sit anywhere); CubeStrip gives lib/strip.ts's bytes.
      var raw = [UInt8](try source.wholeData())
      var clean = CubeStrip.strip(raw)
      CubeDocClean.wipe(&raw)
      defer { CubeDocClean.wipe(&clean) }
      try writer.write(clean)
    case "office":
      let src = try source.randomSource()
      if CubeDocClean.isCfb(src) {
        // Office 97–2003 (OLE compound files): same-length patches found reading in place, laid over
        // as it streams.
        let patches = CubeDocClean.cfbPatches(src)
        try streamPatched(source, patches) { try writer.write($0) }
      } else {
        // Office, OpenDocument and EPUB zips: rewritten one entry at a time, read in place.
        let cleaned = try CubeDocClean.cleanOffice(src) { try writer.write($0) }
        if !cleaned { try stream(source) { try writer.write($0) } }
      }
    case "pdf":
      // Compressed object and XMP streams and JPEG photos first (same-length patches, found reading
      // in place), then everything through the streaming cleaner.
      let patches = (try? source.randomSource()).map { CubeDocClean.pdfStreamPatches($0) } ?? []
      var cleaner = CubeDocClean.PdfCleaner()
      try streamPatched(source, patches) { piece in
        var done = cleaner.push(piece)
        try writer.write(done)
        CubeDocClean.wipe(&done)
      }
      var tail = cleaner.finish()
      try writer.write(tail)
      CubeDocClean.wipe(&tail)
    case "media":
      // Video and audio: same-length patches found reading headers in place, laid over as it streams.
      let patches = (try? source.randomSource()).map { CubeMediaClean.patches($0) } ?? []
      try streamPatched(source, patches) { try writer.write($0) }
    case "rtf":
      var cleaner = CubeDocClean.RtfCleaner()
      try stream(source) { chunk in
        var piece = [UInt8](chunk)
        var done = cleaner.push(piece)
        CubeDocClean.wipe(&piece)
        try writer.write(done)
        CubeDocClean.wipe(&done)
      }
      var tail = cleaner.finish()
      try writer.write(tail)
      CubeDocClean.wipe(&tail)
    case "svg":
      // Cleaned whole, in memory, up to svgMax; larger ones stream through XmlCleaner (the same bytes).
      if try source.randomSource().size <= CubeDocClean.svgMax {
        var raw = [UInt8](try source.wholeData())
        var clean = CubeDocClean.cleanXml(raw, CubeDocClean.svgRules)
        CubeDocClean.wipe(&raw)
        defer { CubeDocClean.wipe(&clean) }
        try writer.write(clean)
      } else {
        var cleaner = CubeDocClean.XmlCleaner(CubeDocClean.svgRules)
        try stream(source) { chunk in
          var piece = [UInt8](chunk)
          var done = cleaner.push(piece)
          CubeDocClean.wipe(&piece)
          try writer.write(done)
          CubeDocClean.wipe(&done)
        }
        var tail = cleaner.finish()
        try writer.write(tail)
        CubeDocClean.wipe(&tail)
      }
    default:
      try stream(source) { try writer.write($0) }
    }
    let r = try writer.finish()
    try out.synchronize()
    return r
  }

  /// Hands the source to `body` 1 MiB at a time.
  private static func stream(_ source: PickSource, _ body: (Data) throws -> Void) throws {
    switch source {
    case .data(let d):
      var at = 0
      while at < d.count {
        let n = min(1 << 20, d.count - at)
        try body(d.subdata(in: (d.startIndex + at)..<(d.startIndex + at + n)))
        at += n
      }
    case .url(let url, _):
      let h = try FileHandle(forReadingFrom: url)
      defer { try? h.close() }
      while let part = try h.read(upToCount: 1 << 20), !part.isEmpty {
        var p = part
        try body(p)
        p.resetBytes(in: 0..<p.count)
      }
    }
  }

  /// Hands the source to `body` 1 MiB at a time with same-length patches laid over it; each piece
  /// is wiped once `body` has used it.
  private static func streamPatched(_ source: PickSource, _ patches: [CubeDocClean.Patch], _ body: ([UInt8]) throws -> Void) throws {
    var offset = 0
    try stream(source) { chunk in
      var piece = [UInt8](chunk)
      defer { CubeDocClean.wipe(&piece) }
      CubeDocClean.overlay(patches, on: &piece, at: offset)
      offset += piece.count
      try body(piece)
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

// MARK: - Picking and sharing helpers

/// A picked file: opened in place (a security-scoped URL from the document picker) or a photo in memory.
enum PickSource {
  case url(URL, scoped: Bool)
  case data(Data)

  /// Runs body with the file readable (inside its security scope, for picked documents).
  func withAccess<T>(_ body: () throws -> T) throws -> T {
    if case .url(let url, true) = self {
      let ok = url.startAccessingSecurityScopedResource()
      defer { if ok { url.stopAccessingSecurityScopedResource() } }
      return try body()
    }
    return try body()
  }

  /// Runs body inside a coordinated read of a picked document, which first downloads a file that is
  /// only a placeholder (iCloud Drive and other file providers). A file that cannot be had now (offline,
  /// gone, access lost) throws PickUnavailable.
  func coordinatedRead<T>(_ body: () throws -> T) throws -> T {
    guard case .url(let url, true) = self else { return try body() }
    var coordinationError: NSError?
    var result: Result<T, Error>?
    try withoutActuallyEscaping(body) { run in
      NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { _ in
        result = Result { try run() }
      }
      if let e = coordinationError { throw PickUnavailable(reason: e.localizedDescription) }
    }
    guard let r = result else { throw PickUnavailable(reason: "the file could not be opened") }
    switch r {
    case .success(let v): return v
    case .failure(let e):
      if PickUnavailable.isMissing(e) { throw PickUnavailable(reason: (e as NSError).localizedDescription) }
      throw e
    }
  }

  func wholeData() throws -> Data {
    switch self {
    case .data(let d): return d
    case .url(let url, _): return try Data(contentsOf: url)
    }
  }

  func randomSource() throws -> CubeDocClean.RandomSource {
    switch self {
    case .data(let d): return CubeDocClean.DataSource(data: d)
    case .url(let url, _): return try CubeDocClean.FileSource(url)
    }
  }
}

/// A picked document that cannot be read now (runImport rejects with E_UNAVAILABLE).
struct PickUnavailable: Error {
  let reason: String

  /// A file-not-found error, as reading a document that is no longer there (or not downloaded) gives.
  static func isMissing(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError) { return true }
    if ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOENT) { return true }
    if let under = ns.userInfo[NSUnderlyingErrorKey] as? Error { return isMissing(under) }
    return false
  }
}

final class DocumentPickerDelegate: NSObject, UIDocumentPickerDelegate {
  private let done: (URL?) -> Void
  init(_ done: @escaping (URL?) -> Void) { self.done = done }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(urls.first) }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done(nil) }
}

final class PhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate {
  private let done: (PHPickerResult?) -> Void
  init(_ done: @escaping (PHPickerResult?) -> Void) { self.done = done }
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    done(results.first)
  }
}

/// Decrypted bytes offered to the share sheet, wiped when it closes.
final class SharedBytes {
  private(set) var data: Data
  private let lock = NSLock()
  init(_ data: Data) { self.data = data }
  func wipe() {
    lock.lock(); defer { lock.unlock() }
    data.resetBytes(in: 0..<data.count)
    data = Data()
  }
}

// MARK: - Native preview helpers

/// Decoded images, decrypted texts and PDFs (CubePdf) by handle.
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
    lock.lock()
    let item = images.removeValue(forKey: h)
    lock.unlock()
    (item as? CubePdf)?.close()
  }
}

/// A decrypted PDF, held only in memory. The bytes sit in a buffer Cube allocated and wraps without
/// copying, so PDFKit reads them in place; close() detaches the document from the view and zeroes
/// the buffer. The buffer is freed (zeroed once more) when PDFKit lets go of its last reference.
final class CubePdf {
  private let bytes: UnsafeMutableRawPointer
  private let count: Int
  private var data: Data?
  private(set) var document: PDFDocument?
  /// The view showing this document, detached on close.
  weak var view: PDFView?

  init?(_ plain: Data) {
    let n = plain.count
    guard n > 0 else { return nil }
    let p = UnsafeMutableRawPointer.allocate(byteCount: n, alignment: 16)
    plain.copyBytes(to: p.assumingMemoryBound(to: UInt8.self), count: n)
    bytes = p
    count = n
    let wrapped = Data(bytesNoCopy: p, count: n, deallocator: .custom { ptr, size in
      _ = memset_s(ptr, size, 0, size)
      ptr.deallocate()
    })
    data = wrapped
    guard let doc = PDFDocument(data: wrapped), !doc.isLocked, doc.pageCount > 0 else {
      _ = memset_s(p, n, 0, n)
      data = nil
      return nil
    }
    document = doc
  }

  /// Detaches and drops the document, then zeroes the bytes (on the main thread, where the view lives;
  /// the buffer stays allocated until PDFKit's last reference goes, so nothing reads freed memory).
  func close() {
    DispatchQueue.main.async { [self] in
      if let doc = document, let view = view, view.document === doc { view.document = nil }
      document = nil
      if data != nil { _ = memset_s(bytes, count, 0, count) }
      data = nil
    }
  }
}

/// PDFKit's view, locked down: no text selection, copy, share, look-up or drag, and links are not
/// followed (a link would leave Cube for a browser or another app).
final class CubePdfView: PDFView, PDFViewDelegate {
  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    backgroundColor = .clear   // the app's light or dark background shows around the pages
    displayMode = .singlePageContinuous
    displayDirection = .vertical
    autoScales = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(selectionChanged), name: .PDFViewSelectionChanged, object: self)
    center.addObserver(self, selector: #selector(pagesChanged), name: .PDFViewVisiblePagesChanged, object: self)
    center.addObserver(self, selector: #selector(pagesChanged), name: .PDFViewDocumentChanged, object: self)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  // Links: ignore the tap (the default would open the URL).
  func pdfViewWillClick(onLink sender: PDFView, with url: URL) {}

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }

  override func buildMenu(with builder: UIMenuBuilder) {
    super.buildMenu(with: builder)
    for menu: UIMenu.Identifier in [.standardEdit, .share, .lookup, .learn, .speech, .replace] {
      builder.remove(menu: menu)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    lockDown(self)
  }

  /// Any selection that slips through is cleared at once, so there is nothing to copy.
  @objc private func selectionChanged() {
    if currentSelection != nil { clearSelection() }
  }

  /// PDFKit adds page views as they scroll into sight; lock each one down.
  @objc private func pagesChanged() {
    lockDown(self)
  }

  /// Turns off long-press (text selection, link menus) and removes drag, context-menu, edit-menu and
  /// text-selection interactions in this view and everything inside it. Scrolling, pinch zoom and
  /// taps are left alone.
  private func lockDown(_ v: UIView) {
    for g in v.gestureRecognizers ?? [] where g is UILongPressGestureRecognizer {
      g.isEnabled = false
    }
    for i in v.interactions
    where i is UIDragInteraction || i is UIContextMenuInteraction || i is UIEditMenuInteraction || i is UITextInteraction {
      v.removeInteraction(i)
    }
    for sub in v.subviews { lockDown(sub) }
  }
}

/// Shows what a handle refers to: an image (fit to the view), text (scrolling, not selectable) or a
/// PDF (pages scrolling vertically, zoomable, nothing selectable or copyable).
class CubeImageView: ExpoView {
  private let imageView = UIImageView()
  private let textView = UITextView()
  private let pdfView = CubePdfView(frame: .zero)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit
    // Under the new architecture layoutSubviews is not reliably called on this view, so the
    // subviews follow the view's size through autoresizing instead.
    for v in [imageView, textView, pdfView] as [UIView] {
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
    pdfView.isHidden = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    textView.frame = bounds
    pdfView.frame = bounds
  }

  func show(_ item: Any?) {
    imageView.frame = bounds
    textView.frame = bounds
    pdfView.frame = bounds
    if let pdf = item as? CubePdf, let doc = pdf.document {
      pdf.view = pdfView
      pdfView.document = doc
      pdfView.autoScales = true
      pdfView.isHidden = false
      imageView.isHidden = true
      textView.isHidden = true
      imageView.image = nil
      textView.text = ""
      return
    }
    pdfView.document = nil
    pdfView.isHidden = true
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
