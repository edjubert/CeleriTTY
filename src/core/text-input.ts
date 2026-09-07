/** Native text surface for IME, dead keys, mobile keyboards, and paste. */

export interface NativeTextInputCallbacks {
  onText(text: string): void;
  onPaste(text: string): void;
}

export interface NativeTextInput {
  readonly element: HTMLTextAreaElement;
  focus(): void;
  blur(): void;
  suppressInputForCurrentTask(): void;
  dispose(): void;
}

/**
 * Add the browser-editable surface that a canvas cannot provide by itself.
 *
 * The host remains the sole tab stop for API compatibility. When it receives
 * focus, focus moves to this textarea with `preventScroll`; pointer and
 * programmatic focus use the same path. Nothing focuses automatically merely
 * because a terminal was mounted or became visible.
 */
export function createNativeTextInput(
  host: HTMLElement,
  callbacks: NativeTextInputCallbacks,
): NativeTextInput {
  const originalPosition = host.style.getPropertyValue("position");
  const originalPriority = host.style.getPropertyPriority("position");
  const position = host.ownerDocument.defaultView?.getComputedStyle(host).position;
  const positionHost = !position || position === "static";
  if (positionHost) host.style.setProperty("position", "relative");

  const input = host.ownerDocument.createElement("textarea");
  input.dataset.celerittyInput = "";
  input.setAttribute("aria-label", "Terminal input");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  input.tabIndex = -1;
  Object.assign(input.style, {
    position: "absolute",
    bottom: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    padding: "0",
    border: "0",
    overflow: "hidden",
    resize: "none",
  });
  host.appendChild(input);

  let composing = false;
  let suppressInput = false;
  let disposed = false;

  const focus = (): void => {
    if (!disposed) input.focus({ preventScroll: true });
  };
  const blur = (): void => {
    if (!disposed) input.blur();
  };
  const suppressInputForCurrentTask = (): void => {
    suppressInput = true;
    queueMicrotask(() => {
      suppressInput = false;
    });
  };
  const onHostFocus = (event: FocusEvent): void => {
    if (event.target === host) focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isCompositionKey(event)) return;
    // Composition keystrokes are private to the browser editor. Do not let a
    // terminal encoder or an embedding application's shortcut handler send a
    // partial key to the PTY.
    event.stopImmediatePropagation();
  };
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (event: CompositionEvent): void => {
    composing = false;
    callbacks.onText(event.data);
    input.value = "";
    // Chromium and WebKit emit the committed value again as an `input` event.
    suppressInputForCurrentTask();
  };
  const onInput = (rawEvent: Event): void => {
    const event = rawEvent as InputEvent;
    if (composing || event.isComposing) return;
    if (suppressInput) {
      input.value = "";
      return;
    }

    if (event.inputType === "deleteContentBackward") callbacks.onText("\x7f");
    else if (event.inputType === "insertLineBreak") callbacks.onText("\r");
    else callbacks.onText(event.data ?? input.value);
    input.value = "";
  };
  const onPaste = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    callbacks.onPaste(text);
    input.value = "";
    suppressInputForCurrentTask();
  };

  host.addEventListener("focus", onHostFocus, true);
  host.addEventListener("keydown", onKeyDown, true);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("input", onInput);
  input.addEventListener("paste", onPaste);

  if (host.ownerDocument.activeElement === host) focus();

  return {
    element: input,
    focus,
    blur,
    suppressInputForCurrentTask,
    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener("focus", onHostFocus, true);
      host.removeEventListener("keydown", onKeyDown, true);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("input", onInput);
      input.removeEventListener("paste", onPaste);
      input.remove();
      // Restore only the style we own; preserve later host-side changes.
      if (
        positionHost &&
        host.style.position === "relative" &&
        !host.style.getPropertyPriority("position")
      ) {
        if (originalPosition)
          host.style.setProperty("position", originalPosition, originalPriority);
        else host.style.removeProperty("position");
      }
    },
  };
}

/** Browser sentinel values used while an IME owns the keystroke stream. */
export function isCompositionKey(event: KeyboardEvent): boolean {
  return (
    event.isComposing || event.key === "Process" || event.key === "Dead" || event.keyCode === 229
  );
}
