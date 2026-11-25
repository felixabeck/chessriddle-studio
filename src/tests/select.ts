import { act } from "react";

function listboxOf(select: HTMLElement): HTMLElement | null {
    const listId = select.getAttribute("aria-controls");
    return listId ? document.getElementById(listId) : null;
}

/** Open a Mantine Select and choose an option by its value, or by its visible label. */
export async function chooseSelectOption(select: HTMLElement, valueOrLabel: string) {
    if (!listboxOf(select)?.querySelector('[role="option"]')) {
        await act(async () => select.click());
    }
    const list = listboxOf(select);
    if (!list) throw new Error("select listbox is not rendered");
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const option =
        options.find((item) => item.getAttribute("value") === valueOrLabel) ??
        options.find((item) => item.textContent?.trim() === valueOrLabel);
    if (!option) throw new Error(`option ${valueOrLabel} is not rendered`);
    await act(async () => option.click());
}

/**
 * Hover an open Select option by its exact visible label, as the pointer does before a choice.
 * SettingsSelect's preview listens with onPointerEnter on the element it renders inside the
 * option row (the row's first child), so the event goes there.
 */
export async function hoverSelectOption(label: string) {
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === label,
    );
    if (!row) throw new Error(`option ${label} is not rendered`);
    const hit = row.firstElementChild ?? row;
    await act(async () => {
        // React synthesizes onPointerEnter from pointerover (not pointerenter).
        hit.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
}
