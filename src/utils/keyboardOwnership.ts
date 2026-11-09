import type { HotkeyItem } from "@mantine/hooks";

/**
 * The event target decides keyboard ownership: a target inside an aria-modal dialog
 * belongs to that dialog, while a focused element outside every dialog keeps its keyboard.
 * A document/body/html target (focus outside every surface) belongs to the topmost open dialog.
 * Shortcuts outside the owner are suspended, while a surface inside it keeps working.
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

/** react-hotkeys-hook options for a surface that is never rendered inside a dialog: keys owned by an open dialog are ignored (not fired, not prevented, not stopped). */
export const backgroundHotkeyOptions = {
    ignoreEventWhen: (event: KeyboardEvent) => isKeyboardOwnedElsewhere(event, null),
};

export function withKeyboardOwnership(hotkeys: HotkeyItem[]): HotkeyItem[] {
    return hotkeys.map(([keys, handler, options]) => {
        const resolvedOptions = options ?? { preventDefault: true, usePhysicalKeys: false };
        return [
            keys,
            (event) => {
                if (isKeyboardOwnedElsewhere(event, null)) return;
                if (resolvedOptions.preventDefault) event.preventDefault();
                return handler(event);
            },
            { ...resolvedOptions, preventDefault: false },
        ];
    });
}
