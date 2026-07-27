/** Clipboard write with execCommand fallback for sandboxed iframes.
 *
 *  The Electron `zelos-app://` iframe's sandbox sometimes blocks
 *  `navigator.clipboard.writeText` (Permissions Policy isn't part of
 *  `<iframe sandbox>` so it can't be opted in from the inner document).
 *  The legacy `document.execCommand("copy")` path works as long as we have
 *  a focusable element with a selection — a hidden textarea handles that. */

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
