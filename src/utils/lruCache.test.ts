import { expect, test } from "vitest";
import { LruCache } from "./lruCache";

function filled(capacity: number) {
    const cache = new LruCache<string, number>(capacity);
    for (let n = 0; n < capacity; n++) cache.set(`k${n}`, n);
    return cache;
}

test("evicts the least recently inserted entry above capacity when nothing was read", () => {
    const cache = filled(3);
    cache.set("k3", 3);
    expect(cache.size).toBe(3);
    expect(cache.has("k0")).toBe(false);
    expect(["k1", "k2", "k3"].map((key) => cache.get(key))).toEqual([1, 2, 3]);
});

test("a read promotes the oldest entry, so the second oldest is evicted instead", () => {
    const cache = filled(3);
    expect(cache.get("k0")).toBe(0);
    cache.set("k3", 3);
    expect(cache.has("k0")).toBe(true);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("k2")).toBe(true);
    expect(cache.has("k3")).toBe(true);
});

test("has does not promote", () => {
    const cache = filled(3);
    expect(cache.has("k0")).toBe(true);
    cache.set("k3", 3);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k1")).toBe(true);
});

test("overwriting a key keeps the size, replaces the value and promotes it", () => {
    const cache = filled(3);
    cache.set("k0", 10);
    expect(cache.size).toBe(3);
    cache.set("k3", 3);
    expect(cache.size).toBe(3);
    expect(cache.get("k0")).toBe(10);
    expect(cache.has("k1")).toBe(false);
});

test("a missing key reads as undefined, and a stored undefined value is still an entry", () => {
    const cache = new LruCache<string, number | undefined>(2);
    expect(cache.get("absent")).toBeUndefined();
    cache.set("a", undefined);
    cache.set("b", 1);
    expect(cache.get("a")).toBeUndefined();
    cache.set("c", 2);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
});

test("clear removes every entry", () => {
    const cache = filled(3);
    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("k0")).toBeUndefined();
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "capacity %s is rejected",
    (capacity) => {
        expect(() => new LruCache(capacity)).toThrow(RangeError);
    },
);

test("capacity one keeps only the latest entry", () => {
    const cache = new LruCache<string, number>(1);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.has("a")).toBe(false);
});
