import { afterEach, beforeEach, expect, test } from "vitest";
import { isKeyboardOwnedElsewhere, keyboardOwner } from "./keyboardOwnership";

let host: HTMLDivElement;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
});

afterEach(() => host.remove());

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
