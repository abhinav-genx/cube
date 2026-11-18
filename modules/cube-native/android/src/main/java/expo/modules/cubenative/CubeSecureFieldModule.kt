package expo.modules.cubenative

import android.content.Context
import android.graphics.Color
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.text.Normalizer

/**
 * A passphrase field whose text never reaches JavaScript as a string. JavaScript only learns the
 * length (to enable the button) and, on submit, calls take(): the field hands over the passphrase
 * as UTF-8 byte values (NFC, so the same words typed on any keyboard give the same bytes) and
 * clears itself. React Native's TextInput would put every keystroke into an unwipeable JS string.
 */
class CubeSecureFieldModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CubeSecureField")

    View(CubeSecureField::class) {
      Events("onLengthChange", "onSubmit", "onFocusChange")

      Prop("placeholder") { view: CubeSecureField, text: String? -> view.field.hint = text }
      Prop("textColor") { view: CubeSecureField, hex: String? ->
        hex?.let { runCatching { view.field.setTextColor(Color.parseColor(it)) } }
      }
      Prop("placeholderColor") { view: CubeSecureField, hex: String? ->
        hex?.let { runCatching { view.field.setHintTextColor(Color.parseColor(it)) } }
      }
      Prop("fontSize") { view: CubeSecureField, size: Double? ->
        size?.let { view.field.setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
      }
      Prop("editable") { view: CubeSecureField, editable: Boolean? -> view.field.isEnabled = editable ?: true }
      Prop("autoFocus") { view: CubeSecureField, autoFocus: Boolean? -> view.autoFocus = autoFocus ?: false }

      // The passphrase as UTF-8 byte values, then the field is emptied.
      AsyncFunction("take") { view: CubeSecureField -> view.take() }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("focus") { view: CubeSecureField -> view.focusField() }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    }
  }
}

class CubeSecureField(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onLengthChange by EventDispatcher()
  private val onSubmit by EventDispatcher()
  private val onFocusChange by EventDispatcher()
  var autoFocus = false

  val field = EditText(context).apply {
    // A password field: no suggestions, no learning, no autofill, no clipboard history of its text.
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    isLongClickable = false
    setTextIsSelectable(false)
    background = null
    contentDescription = "Passphrase"
    val pad = (16 * resources.displayMetrics.density).toInt()
    setPadding(pad, 0, pad, 0)
    layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  init {
    addView(field)
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { onLengthChange(mapOf("length" to (s?.length ?: 0))) }
    })
    field.setOnEditorActionListener { _, action, _ ->
      if (action == EditorInfo.IME_ACTION_DONE) { onSubmit(mapOf<String, Any>()); true } else false
    }
    field.setOnFocusChangeListener { _, focused -> onFocusChange(mapOf("focused" to focused)) }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (autoFocus) post { focusField() }
  }

  fun focusField() {
    field.requestFocus()
    context.getSystemService(InputMethodManager::class.java)?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
  }

  fun take(): List<Int> {
    val editable = field.text
    val chars = CharArray(editable.length).also { android.text.TextUtils.getChars(editable, 0, editable.length, it, 0) }
    val bytes = Normalizer.normalize(java.nio.CharBuffer.wrap(chars), Normalizer.Form.NFC).toByteArray(Charsets.UTF_8)
    chars.fill('\u0000')
    editable.clear()
    val out = bytes.map { it.toInt() and 0xFF }
    bytes.fill(0)
    return out
  }
}
