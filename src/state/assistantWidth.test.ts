import { expect, test, vi } from "vitest";
import type { SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import {
    ASSISTANT_DOCK_WIDTH_KEY,
    clampAssistantDockWidthRem,
    createAssistantDockWidthStorage,
    DEFAULT_ASSISTANT_DOCK_WIDTH_REM,
    maxAssistantDockWidthRem,
    MIN_ASSISTANT_DOCK_WIDTH_REM,
} from "./assistantWidth";

vi.mock("@/platform/native", () => ({
    warn: vi.fn(() => Promise.resolve()),
}));

function memoryStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    const setItem = vi.fn((key: string, value: string) => {
        map.set(key, value);
    });
    const storage: SyncStringStorage = {
        getItem: (key) => map.get(key) ?? null,
        setItem,
        removeItem: (key) => {
            map.delete(key);
        },
    };
    return { map, setItem, storage };
}

test("absent key returns the 24rem default without writing", () => {
    const { map, setItem, storage } = memoryStorage();
    const store = createAssistantDockWidthStorage(storage);

    expect(store.getItem(ASSISTANT_DOCK_WIDTH_KEY, DEFAULT_ASSISTANT_DOCK_WIDTH_REM)).toBe(24);
    expect(setItem).not.toHaveBeenCalled();
    expect(map.has(ASSISTANT_DOCK_WIDTH_KEY)).toBe(false);
});

test.each(['"wide"', "null", "0", "-5", "{}", "not-json"])(
    "invalid stored value %s falls back to 24rem",
    (raw) => {
        const { storage } = memoryStorage({ [ASSISTANT_DOCK_WIDTH_KEY]: raw });
        const store = createAssistantDockWidthStorage(storage);

        expect(store.getItem(ASSISTANT_DOCK_WIDTH_KEY, DEFAULT_ASSISTANT_DOCK_WIDTH_REM)).toBe(24);
    },
);

test("stored values below 20rem or above 42vw remain valid in storage without rewriting", () => {
    for (const stored of ["12", "80"]) {
        const { map, setItem, storage } = memoryStorage({ [ASSISTANT_DOCK_WIDTH_KEY]: stored });
        const store = createAssistantDockWidthStorage(storage);

        expect(store.getItem(ASSISTANT_DOCK_WIDTH_KEY, DEFAULT_ASSISTANT_DOCK_WIDTH_REM)).toBe(
            Number(stored),
        );
        expect(setItem).not.toHaveBeenCalled();
        expect(map.get(ASSISTANT_DOCK_WIDTH_KEY)).toBe(stored);
    }
});

test("clampAssistantDockWidthRem enforces the 20rem floor and 42vw cap", () => {
    // 1440px * 0.42 / 16px = 37.8rem
    expect(maxAssistantDockWidthRem(1440, 16)).toBeCloseTo(37.8, 5);
    expect(clampAssistantDockWidthRem(12, 1440, 16)).toBe(MIN_ASSISTANT_DOCK_WIDTH_REM);
    expect(clampAssistantDockWidthRem(28, 1440, 16)).toBe(28);
    expect(clampAssistantDockWidthRem(80, 1440, 16)).toBeCloseTo(37.8, 5);
    // When 42vw is below 20rem (e.g. narrow or 200% font scale), the floor stays 20rem.
    expect(clampAssistantDockWidthRem(10, 600, 16)).toBe(MIN_ASSISTANT_DOCK_WIDTH_REM);
    expect(clampAssistantDockWidthRem(30, 600, 16)).toBe(MIN_ASSISTANT_DOCK_WIDTH_REM);
});

test("maxAssistantDockWidthRem falls back to default when viewport or root font is non-positive", () => {
    expect(maxAssistantDockWidthRem(0, 16)).toBe(DEFAULT_ASSISTANT_DOCK_WIDTH_REM);
    expect(maxAssistantDockWidthRem(-100, 16)).toBe(DEFAULT_ASSISTANT_DOCK_WIDTH_REM);
    expect(maxAssistantDockWidthRem(1440, 0)).toBe(DEFAULT_ASSISTANT_DOCK_WIDTH_REM);
    expect(maxAssistantDockWidthRem(1440, -16)).toBe(DEFAULT_ASSISTANT_DOCK_WIDTH_REM);
});
