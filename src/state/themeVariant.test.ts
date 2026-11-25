import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "./atoms";

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

test.each(["light", 1, null, "dimmed"])(
    "repairs invalid stored theme variant %j to default during real atom hydration",
    async (storedValue) => {
        localStorage.setItem("theme-variant", JSON.stringify(storedValue));
        const { themeVariantAtom } = await import("./atoms");
        const store = createStore();
        const unsubscribe = store.sub(themeVariantAtom, () => {});
        try {
            expect(store.get(themeVariantAtom)).toBe("default");
            expect(localStorage.getItem("theme-variant")).toBe('"default"');
        } finally {
            unsubscribe();
        }
    },
);

test("preserves stored dim variant during real atom hydration", async () => {
    localStorage.setItem("theme-variant", JSON.stringify("dim"));
    const { themeVariantAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(themeVariantAtom, () => {});
    try {
        expect(store.get(themeVariantAtom)).toBe("dim");
        expect(localStorage.getItem("theme-variant")).toBe('"dim"');
    } finally {
        unsubscribe();
    }
});
