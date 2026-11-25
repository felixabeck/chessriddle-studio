import { act } from "react";
import { expect, vi } from "vitest";

/** Hovers `element`, waits for a Mantine tooltip with `expected` text, and moves the pointer off. */
export async function expectHoverTooltip(element: Element, expected: string) {
    await act(async () => {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
        const tooltips = Array.from(
            document.querySelectorAll('[role="tooltip"]'),
            (node) => node.textContent,
        );
        expect(tooltips).toContain(expected);
    });
    await act(async () => {
        element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
}
