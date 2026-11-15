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

const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
/** Focused widgets that act on these keys themselves, so a document hotkey must not act on the same press. */
const KEY_HANDLING_WIDGETS: { selector: string; keys: readonly string[] }[] = [
    // Mantine Slider / RangeSlider thumbs
    { selector: '[role="slider"]', keys: [...ARROW_KEYS, "Home", "End"] },
    // the board's keyboard move grid (Board.tsx keyboardMove)
    { selector: '[role="grid"]', keys: [...ARROW_KEYS] },
];

export function isKeyHandledByFocusedWidget(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    return KEY_HANDLING_WIDGETS.some(
        (widget) => target.closest(widget.selector) !== null && widget.keys.includes(event.key),
    );
}

export function isHotkeySuppressed(event: KeyboardEvent, surface: Element | null): boolean {
    return isKeyboardOwnedElsewhere(event, surface) || isKeyHandledByFocusedWidget(event);
}

/** react-hotkeys-hook options for a surface that is never rendered inside a dialog: keys owned by an open dialog are ignored (not fired, not prevented, not stopped). */
export const backgroundHotkeyOptions = {
    ignoreEventWhen: (event: KeyboardEvent) => isHotkeySuppressed(event, null),
};

export function withKeyboardOwnership(hotkeys: HotkeyItem[]): HotkeyItem[] {
    return hotkeys.map(([keys, handler, options]) => {
        const resolvedOptions = options ?? { preventDefault: true, usePhysicalKeys: false };
        return [
            keys,
            (event) => {
                if (isHotkeySuppressed(event, null)) return;
                if (resolvedOptions.preventDefault) event.preventDefault();
                return handler(event);
            },
            { ...resolvedOptions, preventDefault: false },
        ];
    });
}
