import { afterEach, expect, test } from "vitest";
import {
    installNativeContextMenuSuppression,
    shouldSuppressNativeContextMenu,
} from "./nativeContextMenu";

afterEach(() => document.body.replaceChildren());

test.each([
    ["<input>", false],
    ['<input type="search">', false],
    ['<input type="email">', false],
    ['<input type="url">', false],
    ['<input type="tel">', false],
    ['<input type="password">', false],
    ['<input type="number">', false],
    ["<textarea></textarea>", false],
    ['<div contenteditable="true"><span data-target>edit</span></div>', false],
    ['<div contenteditable=""><span data-target>edit</span></div>', false],
    ['<div contenteditable="plaintext-only">edit</div>', false],
    [
        '<div contenteditable="true"><span contenteditable="inherit" data-target>edit</span></div>',
        false,
    ],
    [
        '<div contenteditable="true"><span contenteditable="false" data-target>fixed</span></div>',
        true,
    ],
    ['<input type="checkbox">', true],
    ['<input type="button">', true],
    ["<input readonly>", true],
    ["<input disabled>", true],
    ["<textarea readonly></textarea>", true],
    ["<div>plain</div>", true],
] as const)("native context menu suppression for %s is %s", (html, expected) => {
    document.body.innerHTML = html;
    const target = document.querySelector("[data-target]") ?? document.body.firstElementChild;
    expect(shouldSuppressNativeContextMenu(target)).toBe(expected);
});

test("handles text nodes, absent targets and non-element targets", () => {
    document.body.innerHTML = '<div contenteditable="true">edit</div>';
    expect(shouldSuppressNativeContextMenu(document.body.firstElementChild!.firstChild)).toBe(
        false,
    );
    expect(shouldSuppressNativeContextMenu(null)).toBe(true);
    expect(shouldSuppressNativeContextMenu(window)).toBe(true);
});

test("suppresses after component handlers without stopping propagation and removes its listener", () => {
    const remove = installNativeContextMenuSuppression();
    const input = document.createElement("input");
    const plain = document.createElement("div");
    document.body.append(input, plain);
    const observed: boolean[] = [];
    const observe = (event: MouseEvent) => observed.push(event.defaultPrevented);
    window.addEventListener("contextmenu", observe);
    const dispatch = (element: Element) => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    };
    try {
        expect(dispatch(plain)).toBe(true);
        expect(dispatch(input)).toBe(false);
        input.addEventListener("contextmenu", (event) => event.preventDefault());
        expect(dispatch(input)).toBe(true);
        remove();
        expect(dispatch(plain)).toBe(false);
        expect(observed).toEqual([true, false, true, false]);
    } finally {
        remove();
        window.removeEventListener("contextmenu", observe);
    }
});
