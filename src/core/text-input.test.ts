// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createNativeTextInput } from "./text-input";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["", "static"])("positions a %s host and restores its original style", (position) => {
  const host = document.createElement("div");
  host.style.position = position;
  document.body.append(host);
  const native = createNativeTextInput(host, { onText: vi.fn(), onPaste: vi.fn() });
  expect(host.style.position).toBe("relative");
  expect(native.element.parentElement).toBe(host);
  native.dispose();
  expect(host.style.position).toBe(position);
});

it("preserves existing positioning and later host changes", () => {
  const host = document.createElement("div");
  host.style.position = "absolute";
  document.body.append(host);
  const callbacks = { onText: vi.fn(), onPaste: vi.fn() };
  const first = createNativeTextInput(host, callbacks);
  expect(host.style.position).toBe("absolute");
  first.dispose();
  host.style.position = "static";
  const second = createNativeTextInput(host, callbacks);
  host.style.position = "fixed";
  second.dispose();
  expect(host.style.position).toBe("fixed");
});

it("removes all six listeners and the textarea, and makes disposal idempotent", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const hostAdd = vi.spyOn(host, "addEventListener");
  const hostRemove = vi.spyOn(host, "removeEventListener");
  const callbacks = { onText: vi.fn(), onPaste: vi.fn() };
  const native = createNativeTextInput(host, callbacks);
  const inputRemove = vi.spyOn(native.element, "removeEventListener");
  const focus = vi.spyOn(native.element, "focus");
  native.focus();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  native.dispose();
  native.dispose();
  native.focus();
  expect(focus).toHaveBeenCalledOnce();
  expect(native.element.isConnected).toBe(false);
  expect(hostRemove.mock.calls).toEqual(hostAdd.mock.calls);
  expect(inputRemove.mock.calls.map(([type]) => type)).toEqual([
    "compositionstart",
    "compositionend",
    "input",
    "paste",
  ]);
  native.element.dispatchEvent(new CompositionEvent("compositionend", { data: "text" }));
  native.element.dispatchEvent(new InputEvent("input", { data: "text" }));
  const paste = new Event("paste", { cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "text" } });
  native.element.dispatchEvent(paste);
  expect(callbacks.onText).not.toHaveBeenCalled();
  expect(callbacks.onPaste).not.toHaveBeenCalled();
});
