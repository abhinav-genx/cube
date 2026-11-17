import ExpoModulesCore
import UIKit

/// A passphrase field whose text never reaches JavaScript as a string. JavaScript only learns the
/// length (to enable the button) and, on submit, calls take(): the field hands over the passphrase
/// as UTF-8 byte values (NFC, so the same words typed on any keyboard give the same bytes) and
/// clears itself. React Native's TextInput would put every keystroke into an unwipeable JS string.
public class CubeSecureFieldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CubeSecureField")

    View(CubeSecureField.self) {
      Events("onLengthChange", "onSubmit", "onFocusChange")

      Prop("placeholder") { (view: CubeSecureField, text: String?) in
        view.field.placeholder = text
      }
      Prop("textColor") { (view: CubeSecureField, hex: String?) in
        if let c = CubeSecureField.color(hex) { view.field.textColor = c; view.field.tintColor = c }
      }
      Prop("placeholderColor") { (view: CubeSecureField, hex: String?) in
        view.placeholderColor = CubeSecureField.color(hex)
      }
      Prop("fontSize") { (view: CubeSecureField, size: Double?) in
        if let size = size { view.field.font = .systemFont(ofSize: CGFloat(size)) }
      }
      Prop("editable") { (view: CubeSecureField, editable: Bool?) in
        view.field.isEnabled = editable ?? true
      }
      Prop("autoFocus") { (view: CubeSecureField, autoFocus: Bool?) in
        view.autoFocus = autoFocus ?? false
      }

      /// The passphrase as UTF-8 byte values, then the field is emptied.
      AsyncFunction("take") { (view: CubeSecureField) -> [Int] in
        view.take()
      }.runOnQueue(.main)

      AsyncFunction("focus") { (view: CubeSecureField) in
        view.field.becomeFirstResponder()
      }.runOnQueue(.main)
    }
  }
}

class CubeSecureField: ExpoView, UITextFieldDelegate {
  let field = UITextField()
  let onLengthChange = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onFocusChange = EventDispatcher()
  var autoFocus = false
  var placeholderColor: UIColor? { didSet { applyPlaceholder() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    field.isSecureTextEntry = true
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartDashesType = .no
    field.smartQuotesType = .no
    field.smartInsertDeleteType = .no
    field.returnKeyType = .done
    field.borderStyle = .none
    field.accessibilityLabel = "Passphrase"
    field.delegate = self
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    field.frame = bounds
    field.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(field)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    field.frame = bounds.insetBy(dx: 16, dy: 0)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && autoFocus {
      DispatchQueue.main.async { [weak self] in self?.field.becomeFirstResponder() }
    }
  }

  private func applyPlaceholder() {
    guard let text = field.placeholder, let color = placeholderColor else { return }
    field.attributedPlaceholder = NSAttributedString(string: text, attributes: [.foregroundColor: color])
  }

  @objc private func changed() {
    onLengthChange(["length": field.text?.count ?? 0])
  }

  func take() -> [Int] {
    let text = field.text ?? ""
    let bytes = Array(text.precomposedStringWithCanonicalMapping.utf8).map { Int($0) }
    field.text = ""
    onLengthChange(["length": 0])
    return bytes
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    onSubmit([:])
    return false
  }

  func textFieldDidBeginEditing(_ textField: UITextField) { onFocusChange(["focused": true]) }
  func textFieldDidEndEditing(_ textField: UITextField) { onFocusChange(["focused": false]) }

  static func color(_ hex: String?) -> UIColor? {
    guard let hex = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), hex.count == 6,
          let v = UInt32(hex, radix: 16) else { return nil }
    return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
  }
}
