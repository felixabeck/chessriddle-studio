import { useHotkeys, type HotkeyItem } from "@mantine/hooks";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { press } from "@/tests/keyboard";
import {
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

function dialog() {
    const element = document.createElement("section");
    element.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    element.append(button);
    host.append(element);
    return { element, button };
}

function keyAt(target: EventTarget) {
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true });
    target.dispatchEvent(event);
    return event;
}

test("a target inside a blocking dialog belongs to that dialog", () => {
    const { element, button } = dialog();
    dialog();
    button.focus();

    expect(keyboardOwner(keyAt(button))).toBe(element);
});

test("an unrelated focused element keeps its own keyboard even with an open dialog", () => {
    dialog();
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
    dialog();
    const topmost = dialog();

    expect(keyboardOwner(keyAt(target()))).toBe(topmost.element);
});

test("an event without a target falls back to the last blocking dialog", () => {
    dialog();
    const topmost = dialog();

    expect(keyboardOwner(new KeyboardEvent("keydown"))).toBe(topmost.element);
});

test("without a blocking dialog there is no keyboard owner", () => {
    expect(keyboardOwner(keyAt(document))).toBeNull();
    expect(keyboardOwner(keyAt(document.body))).toBeNull();
    expect(isKeyboardOwnedElsewhere(keyAt(document), null)).toBe(false);
});

test("only surfaces inside the owner keep their shortcuts", () => {
    const { element, button } = dialog();
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
    const { button } = dialog();
    button.focus();
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
    dialog();
    const button = document.createElement("button");
    host.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const event = press("k", { target: button });

    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.defaultPrevented).toBe(prevented);
});
