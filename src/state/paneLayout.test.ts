import { expect, test } from "vitest";
import { needsTwoPaneStack, rootFontPx } from "./paneLayout";

test("two pane floors keep the database boundary and scale with the root font", () => {
    expect(needsTwoPaneStack(645, 16)).toBe(true);
    expect(needsTwoPaneStack(646, 16)).toBe(false);
    expect(needsTwoPaneStack(1285, 32)).toBe(true);
    expect(needsTwoPaneStack(1286, 32)).toBe(false);
});

test("root font uses computed pixels and the existing percentage fallback", () => {
    expect(rootFontPx("24px", 200)).toBe(24);
    expect(rootFontPx("", 200)).toBe(32);
    expect(rootFontPx("0px", 100)).toBe(16);
});
