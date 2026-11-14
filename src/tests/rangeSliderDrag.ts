import { act } from "react";
import { vi } from "vitest";

const SLIDER_RECT: DOMRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 20,
    width: 300,
    height: 20,
    toJSON: () => ({}),
};

async function flushMoveFrame() {
    if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(20);
        return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function flushScrubEnd() {
    if (vi.isFakeTimers()) {
        await vi.runAllTimersAsync();
        return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function rangeSliderThumbs(sliderRoot: ParentNode): NodeListOf<HTMLElement> {
    return sliderRoot.querySelectorAll<HTMLElement>('[role="slider"]');
}

/**
 * Drags a Mantine RangeSlider across a mocked 300px-wide track from `from` to `to`,
 * running `beforeRelease` while the pointer is still down.
 */
export async function dragRangeSlider(
    sliderRoot: ParentNode,
    { from, to }: { from: number; to: number },
    { beforeRelease }: { beforeRelease?: () => void | Promise<void> } = {},
) {
    const rectSpy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue(SLIDER_RECT);
    try {
        // Mantine RangeSlider attaches useMove + capture handlers to .mantine-RangeSlider-trackContainer.
        const track = sliderRoot.querySelector<HTMLElement>(".mantine-RangeSlider-trackContainer");
        if (!track) {
            throw new Error("Expected .mantine-RangeSlider-trackContainer inside slider root");
        }

        await act(async () => {
            track.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, clientX: from, clientY: 10 }),
            );
            document.dispatchEvent(
                new MouseEvent("mousemove", { bubbles: true, clientX: to, clientY: 10 }),
            );
            await flushMoveFrame();
        });

        await beforeRelease?.();

        await act(async () => {
            document.dispatchEvent(
                new MouseEvent("mouseup", { bubbles: true, clientX: to, clientY: 10 }),
            );
            await flushScrubEnd();
        });
    } finally {
        rectSpy.mockRestore();
    }
}
