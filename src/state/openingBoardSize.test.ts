import { expect, test, vi } from "vitest";
import type { SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import {
    clampOpeningBoardSizeRem,
    DEFAULT_OPENING_BOARD_SIZE_REM,
    maxOpeningBoardSizeRem,
    MIN_OPENING_BOARD_SIZE_REM,
    OPENING_BOARD_SIZE_KEY,
} from "./openingBoardSize";
import { createPositiveRemStorage } from "./remPreference";

vi.mock("@/platform/native", () => ({
    warn: vi.fn(() => Promise.resolve()),
}));

function memoryStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    const storage: SyncStringStorage = {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
    return { map, storage };
}

test("an out-of-range size is read unchanged and only clamped when applied", () => {
    const { map, storage } = memoryStorage({ [OPENING_BOARD_SIZE_KEY]: "80" });
    const stored = createPositiveRemStorage(storage).getItem(
        OPENING_BOARD_SIZE_KEY,
        DEFAULT_OPENING_BOARD_SIZE_REM,
    );
    expect(stored).toBe(80);
    expect(clampOpeningBoardSizeRem(stored, maxOpeningBoardSizeRem(60, true))).toBe(35.25);
    expect(clampOpeningBoardSizeRem(5, maxOpeningBoardSizeRem(60, true))).toBe(
        MIN_OPENING_BOARD_SIZE_REM,
    );
    expect(map.get(OPENING_BOARD_SIZE_KEY)).toBe("80");
});

test("beside the table the board leaves the table its width and the gap; stacked it may fill the body", () => {
    expect(maxOpeningBoardSizeRem(50, true)).toBe(25.25);
    expect(maxOpeningBoardSizeRem(30, false)).toBe(30);
    expect(maxOpeningBoardSizeRem(25, true)).toBe(MIN_OPENING_BOARD_SIZE_REM);
    expect(maxOpeningBoardSizeRem(0, false)).toBe(Number.POSITIVE_INFINITY);
});
