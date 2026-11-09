import { act } from "react";

export function focusedDialogButton(host: Element = document.body): {
    dialog: HTMLElement;
    button: HTMLButtonElement;
} {
    const dialog = document.createElement("section");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    dialog.append(button);
    host.append(dialog);
    act(() => button.focus());
    return { dialog, button };
}

export function press(
    key: string,
    {
        shiftKey = false,
        ctrlKey = false,
        target = document,
    }: { shiftKey?: boolean; ctrlKey?: boolean; target?: EventTarget } = {},
) {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keydown = new KeyboardEvent("keydown", {
        key,
        code,
        shiftKey,
        ctrlKey,
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        target.dispatchEvent(keydown);
        target.dispatchEvent(
            new KeyboardEvent("keyup", { key, code, shiftKey, ctrlKey, bubbles: true }),
        );
    });
    return keydown;
}
