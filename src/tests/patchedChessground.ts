import { afterEach, beforeEach, vi } from "vitest";

// Harness for tests that drive the real, patched chessground
// (patches/@lichess-org__chessground@10.1.1.patch) in jsdom: an 8×8 board of SQUARE-pixel
// squares, and animation frames that run only when the test flushes them.
export const SQUARE = 50;

/** Registers the mocks for the calling test file. Returns the frame flush. */
export function installPatchedChessgroundHarness(): () => void {
    let frames: FrameRequestCallback[] = [];

    beforeEach(() => {
        frames = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
            DOMRect.fromRect({ x: 0, y: 0, width: 8 * SQUARE, height: 8 * SQUARE }),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    return () => {
        const pending = frames;
        frames = [];
        for (const callback of pending) callback(0);
    };
}
