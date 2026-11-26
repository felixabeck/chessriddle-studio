import { useHotkeys, type HotkeyItem } from "@mantine/hooks";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { focusedDialogButton, press } from "@/tests/keyboard";
import {
    isKeyHandledByFocusedWidget,
    isKeyboardOwnedElsewhere,
    keyboardOwner,
    withKeyboardOwnership,
} from "./keyboardOwnership";

let host: HTMLDivElement;
let root: Root | undefined;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
});

afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
});

function keyAt(target: EventTarget) {
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true });
    target.dispatchEvent(event);
    return event;
}

test("a target inside a blocking dialog belongs to that dialog", () => {
    const { dialog, button } = focusedDialogButton(host);
    focusedDialogButton(host);

    expect(keyboardOwner(keyAt(button))).toBe(dialog);
});

test("an unrelated focused element keeps its own keyboard even with an open dialog", () => {
    focusedDialogButton(host);
    const button = document.createElement("button");
    host.append(button);
    button.focus();

    expect(document.activeElement).toBe(button);
    expect(keyboardOwner(keyAt(button))).toBeNull();
});

test.each([
    ["document", () => document],
    ["body", () => document.body],
    ["html", () => document.documentElement],
    ["non-element", () => host.appendChild(document.createTextNode("text"))],
] as const)("a %s target falls back to the last blocking dialog", (_name, target) => {
    focusedDialogButton(host);
    const { dialog: topmost } = focusedDialogButton(host);

    expect(keyboardOwner(keyAt(target()))).toBe(topmost);
});

test("an event without a target falls back to the last blocking dialog", () => {
    focusedDialogButton(host);
    const { dialog: topmost } = focusedDialogButton(host);

    expect(keyboardOwner(new KeyboardEvent("keydown"))).toBe(topmost);
});

test("without a blocking dialog there is no keyboard owner", () => {
    expect(keyboardOwner(keyAt(document))).toBeNull();
    expect(keyboardOwner(keyAt(document.body))).toBeNull();
    expect(isKeyboardOwnedElsewhere(keyAt(document), null)).toBe(false);
});

test("only surfaces inside the owner keep their shortcuts", () => {
    const { dialog: element, button } = focusedDialogButton(host);
    const event = keyAt(button);

    expect(isKeyboardOwnedElsewhere(event, host)).toBe(true);
    expect(isKeyboardOwnedElsewhere(event, null)).toBe(true);
    expect(isKeyboardOwnedElsewhere(event, button)).toBe(false);
    expect(isKeyboardOwnedElsewhere(event, element)).toBe(false);
});

function Shortcuts({ hotkeys }: { hotkeys: HotkeyItem[] }) {
    useHotkeys(withKeyboardOwnership(hotkeys));
    return null;
}

function renderShortcut(options?: HotkeyItem[2]) {
    const handler = vi.fn();
    root = createRoot(host);
    act(() => root!.render(createElement(Shortcuts, { hotkeys: [["k", handler, options]] })));
    return handler;
}

test("real Mantine hotkeys leave a focused dialog button's key and default untouched", () => {
    const handler = renderShortcut();
    const { button } = focusedDialogButton(host);
    expect(document.activeElement).toBe(button);

    const event = press("k", { target: button });

    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
});

test.each([
    { options: undefined, prevented: true },
    { options: { preventDefault: true }, prevented: true },
    { options: { preventDefault: false }, prevented: false },
    { options: {}, prevented: false },
    { options: { usePhysicalKeys: false }, prevented: false },
])("real Mantine hotkeys preserve outside-key options $options", ({ options, prevented }) => {
    const handler = renderShortcut(options);
    focusedDialogButton(host);
    const button = document.createElement("button");
    host.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const event = press("k", { target: button });

    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.defaultPrevented).toBe(prevented);
});

test.each([
    { role: "slider", key: "ArrowLeft", nested: true, handled: true },
    { role: "slider", key: "Home", nested: true, handled: true },
    { role: "grid", key: "ArrowLeft", nested: false, handled: true },
    { role: "grid", key: "Home", nested: false, handled: false },
    { role: "slider", key: "Delete", nested: true, handled: false },
    { role: "separator", key: "ArrowLeft", nested: false, handled: true },
    { role: "separator", key: "ArrowRight", nested: false, handled: true },
    { role: "separator", key: "ArrowUp", nested: false, handled: false },
    { role: "separator", key: "ArrowDown", nested: false, handled: false },
    { role: "separator", key: "Delete", nested: false, handled: false },
    { role: "button", key: "ArrowLeft", nested: false, handled: false },
    // VariationChooserCard's focusable listbox is driven by MoveControls' arrow hotkeys.
    { role: "listbox", key: "ArrowDown", nested: false, handled: false },
])("$key on $role is handled=$handled", ({ role, key, nested, handled }) => {
    const widget = document.createElement(role === "button" ? "button" : "div");
    if (role !== "button") widget.setAttribute("role", role);
    const target = nested ? document.createElement("span") : widget;
    if (nested) widget.append(target);
    host.append(widget);
    const event = new KeyboardEvent("keydown", { key, bubbles: true });
    target.dispatchEvent(event);

    expect(isKeyHandledByFocusedWidget(event)).toBe(handled);
});

test("withKeyboardOwnership does not call the handler for ArrowLeft on a slider", () => {
    const handler = vi.fn();
    root = createRoot(host);
    act(() => root!.render(createElement(Shortcuts, { hotkeys: [["arrowleft", handler]] })));
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    slider.tabIndex = 0;
    host.append(slider);
    act(() => slider.focus());

    press("ArrowLeft", { target: slider });

    expect(handler).not.toHaveBeenCalled();
});
