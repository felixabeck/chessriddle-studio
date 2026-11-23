import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    lastMoveHighlightBackground,
    lastMoveHighlightColorSchema,
    lastMoveHighlightOpacitySchema,
    parseLastMoveHighlightColor,
} from "./lastMoveHighlight";

vi.mock("@/platform/native", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/platform/native")>()),
    warn: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
});

test.each([
    ["#ffff00", "#ffff00"],
    ["#FF9500", "#ff9500"],
    ["  #0095ff ", "#0095ff"],
    ["#3A7F5C", "#3a7f5c"],
    ["#ff9", null],
    ["#ff95", null],
    ["ff9500", null],
    ["#gg9500", null],
    ["", null],
])("parses typed colour %j as %j", (typed, expected) => {
    expect(parseLastMoveHighlightColor(typed)).toBe(expected);
});

test.each([
    ["#ffff00", 40, "rgba(255, 255, 0, 0.4)"],
    ["#0095ff", 100, "rgba(0, 149, 255, 1)"],
    ["#ff9500", 10, "rgba(255, 149, 0, 0.1)"],
    ["#3a7f5c", 55, "rgba(58, 127, 92, 0.55)"],
])("paints %s at %i%% as %s", (color, opacity, expected) => {
    expect(lastMoveHighlightBackground(color, opacity)).toBe(expected);
});

test("schemas accept only the stored shape", () => {
    expect(lastMoveHighlightColorSchema.safeParse(42).success).toBe(false);
    expect(lastMoveHighlightOpacitySchema.safeParse(5).success).toBe(false);
    expect(lastMoveHighlightOpacitySchema.safeParse(105).success).toBe(false);
    expect(lastMoveHighlightOpacitySchema.safeParse(42).success).toBe(false);
    expect(lastMoveHighlightOpacitySchema.safeParse(45).success).toBe(true);
    expect(lastMoveHighlightColorSchema.safeParse("#3a7f5c").success).toBe(true);
});

test("defaults to yellow at 40 percent when nothing is stored", async () => {
    const { lastMoveHighlightColorAtom, lastMoveHighlightOpacityAtom } = await import("./atoms");
    const store = createStore();
    expect(store.get(lastMoveHighlightColorAtom)).toBe("#ffff00");
    expect(store.get(lastMoveHighlightOpacityAtom)).toBe(40);
});

test.each([[null], ["#ff9"], [42], ["red"]])(
    "repairs invalid stored colour %j to the default during hydration",
    async (storedValue) => {
        localStorage.setItem("last-move-highlight-color", JSON.stringify(storedValue));
        const { lastMoveHighlightColorAtom } = await import("./atoms");
        const store = createStore();
        const unsubscribe = store.sub(lastMoveHighlightColorAtom, () => {});
        try {
            expect(store.get(lastMoveHighlightColorAtom)).toBe("#ffff00");
            expect(localStorage.getItem("last-move-highlight-color")).toBe('"#ffff00"');
        } finally {
            unsubscribe();
        }
    },
);

test("normalises a stored upper-case colour to lower case", async () => {
    localStorage.setItem("last-move-highlight-color", JSON.stringify("#0095FF"));
    const { lastMoveHighlightColorAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(lastMoveHighlightColorAtom, () => {});
    try {
        expect(store.get(lastMoveHighlightColorAtom)).toBe("#0095ff");
        expect(localStorage.getItem("last-move-highlight-color")).toBe('"#0095ff"');
    } finally {
        unsubscribe();
    }
});

test.each([[7], [42], [110], ["40"], [null]])(
    "repairs invalid stored opacity %j to 40 during hydration",
    async (storedValue) => {
        localStorage.setItem("last-move-highlight-opacity", JSON.stringify(storedValue));
        const { lastMoveHighlightOpacityAtom } = await import("./atoms");
        const store = createStore();
        const unsubscribe = store.sub(lastMoveHighlightOpacityAtom, () => {});
        try {
            expect(store.get(lastMoveHighlightOpacityAtom)).toBe(40);
            expect(localStorage.getItem("last-move-highlight-opacity")).toBe("40");
        } finally {
            unsubscribe();
        }
    },
);
