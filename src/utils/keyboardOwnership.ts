/**
 * A blocking dialog owns the keyboard. Shortcuts outside it are suspended,
 * while shortcuts on a surface inside it keep working.
 */
export function keyboardOwner(event: KeyboardEvent): Element | null {
    const target = event.target;
    if (target instanceof Element) {
        const dialog = target.closest('[aria-modal="true"]');
        if (dialog) return dialog;
        if (target !== document.body && target !== document.documentElement) return null;
    }

    const dialogs = document.querySelectorAll('[aria-modal="true"]');
    return dialogs.item(dialogs.length - 1);
}

export function isKeyboardOwnedElsewhere(event: KeyboardEvent, surface: Element | null): boolean {
    const owner = keyboardOwner(event);
    return owner !== null && (surface === null || !owner.contains(surface));
}
