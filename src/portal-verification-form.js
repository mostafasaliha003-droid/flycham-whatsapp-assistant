'use strict';

// Executed only inside a previously origin-checked supplier frame. Uses the
// supplier's observed form controls and ordinary input/change/click events.
// No validation, device-registration or OTP requirement is bypassed.
function verificationFormAction({ operation = 'inspect', code } = {}) {
  const origin = 'https://agents.airarabia.com';
  if (location.origin !== origin) return { ready: false, reason: 'AMBIGUOUS_OR_MISSING_CONTROLS' };
  const inputs = document.querySelectorAll('[id="userOtp"]');
  const buttons = document.querySelectorAll('[id="btnSubmit"]');
  if (inputs.length !== 1 || buttons.length !== 1) return { ready: false };
  const input = inputs[0], button = buttons[0];
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  let frameVisible = true;
  try {
    for (let view = window; view !== view.top; view = view.parent) {
      if (view.parent.location.origin !== origin || !visible(view.frameElement)) { frameVisible = false; break; }
    }
  } catch { frameVisible = false; }
  const ready = input.tagName === 'INPUT' && input.type === 'text' && !input.disabled && !input.readOnly
    && button.type === 'submit' && !button.disabled && input.form && input.form === button.form
    && visible(input) && visible(button) && frameVisible;
  if (!ready || operation === 'inspect') return { ready: Boolean(ready), frameVisible, inputVisible: visible(input), buttonVisible: visible(button) };
  if (operation !== 'submit' || !/^[A-Za-z0-9]{4,12}$/.test(code || '')) return { ready: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return { ready: false };
  input.focus();
  setter.call(input, code);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (input.checkValidity && !input.checkValidity()) return { ready: false };
  button.click();
  return { submitted: true };
}

// The supplier's VerifyUserOTP28102018.js calls parent.reloadMain() when
// verifiedUser or otpVerified is true. Reuse that normal navigation only
// after a supplier-confirmed boolean; never change flags or bypass OTP.
function verificationResultAction({ operation = 'inspect' } = {}) {
  const origin = 'https://agents.airarabia.com';
  if (location.origin !== origin || !/\/(?:sendOTP|verifyOTP)(?:\.action)?$/.test(location.pathname)) return { status: 'UNCONFIRMED' };
  const confirmed = window.verifiedUser === true || window.otpVerified === true;
  let status = confirmed ? 'CONFIRMED' : 'UNCONFIRMED';
  if (!confirmed && /\/verifyOTP(?:\.action)?$/.test(location.pathname)) {
    const error = document.getElementById('spnError');
    const shown = error && error.getClientRects().length && getComputedStyle(error).visibility !== 'hidden';
    const message = shown ? error.textContent : '';
    if (/expir|منتهي|انتهت صلاح/i.test(message)) status = 'EXPIRED';
    else if (/invalid|incorrect|wrong|غير صحيح/i.test(message)) status = 'INVALID_CODE';
    else if (/attempt|locked|محاول|حظر/i.test(message)) status = 'ATTEMPT_LIMIT';
    else if (message?.trim()) status = 'SUPPLIER_MESSAGE';
  }
  if (operation !== 'resume' || !confirmed) return { status };
  try {
    if (window.parent.location.origin !== origin || typeof window.parent.reloadMain !== 'function') return { status, resumed: false };
    window.parent.reloadMain();
    return { status, resumed: true };
  } catch { return { status, resumed: false }; }
}

module.exports = { verificationFormAction, verificationResultAction };
