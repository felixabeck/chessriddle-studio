import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { AnalysisLineMemory, ENGINE_LINE_MEMORY_CAPACITY } from "./analysisLineMemory";

const lines = (depth: number): BestMoves[] => [{ depth } as BestMoves];

test("capacity-bound LRU refreshes display reads and writes, including across immutable copies", () => {
    const memory = new AnalysisLineMemory();
    expect(memory.get("missing-before-writes")).toBeUndefined();
    for (let i = 0; i < ENGINE_LINE_MEMORY_CAPACITY; i++) memory.set(String(i), lines(i));
    expect(memory.size).toBe(ENGINE_LINE_MEMORY_CAPACITY);
    expect(memory.has("0")).toBe(true);
    expect(memory.get("missing")).toBeUndefined();
    expect(memory.get("0")).toEqual(lines(0));
    memory.set("1", lines(10));
    const copy = new AnalysisLineMemory(memory);
    copy.set(String(ENGINE_LINE_MEMORY_CAPACITY), lines(ENGINE_LINE_MEMORY_CAPACITY));
    expect(copy.size).toBe(ENGINE_LINE_MEMORY_CAPACITY);
    expect(copy.has("2")).toBe(false);
    expect(copy.has("0")).toBe(true);
    expect(copy.get("1")).toEqual(lines(10));
    expect(memory.has("2")).toBe(true);
    expect(memory.has(String(ENGINE_LINE_MEMORY_CAPACITY))).toBe(false);
    copy.set(String(ENGINE_LINE_MEMORY_CAPACITY + 1), lines(ENGINE_LINE_MEMORY_CAPACITY + 1));
    expect(copy.has("3")).toBe(false);
});

test("depth replacement admits absent, equal, deeper, and current-search revisions only", () => {
    const oldSearch = {};
    const newSearch = {};
    const memory = new AnalysisLineMemory();
    expect(memory.remember("a", lines(20), oldSearch)).toBe(true);
    memory.context = "settings and executable";
    const copy = new AnalysisLineMemory(memory);
    expect(copy.context).toBe(memory.context);
    expect(copy.remember("a", lines(19), newSearch)).toBe(false);
    expect(copy.get("a")).toEqual(lines(20));
    expect(copy.remember("a", lines(20), newSearch)).toBe(true);
    expect(copy.remember("a", lines(3), newSearch)).toBe(true);
    expect(copy.get("a")).toEqual(lines(3));
    expect(copy.remember("a", lines(4), oldSearch)).toBe(true);
    expect(copy.get("a")).toEqual(lines(4));
    expect(copy.remember("a", lines(2), newSearch)).toBe(false);
    expect(memory.get("a")).toEqual(lines(20));
});

test("a plain map copy preserves default context and eviction order", () => {
    const plain = new Map<string, BestMoves[]>();
    for (let i = 0; i < ENGINE_LINE_MEMORY_CAPACITY; i++) plain.set(String(i), lines(i));
    const memory = new AnalysisLineMemory(plain);
    expect(memory.context).toBeNull();
    memory.set("new", lines(300));
    expect(memory.size).toBe(ENGINE_LINE_MEMORY_CAPACITY);
    expect(memory.has("0")).toBe(false);
    expect(memory.has("new")).toBe(true);
});

test("deletion, clear, eviction and direct writes retire remembered search ownership", () => {
    const search = {};
    const memory = new AnalysisLineMemory();
    memory.remember("a", lines(20), search);
    memory.set("a", lines(21));
    expect(memory.remember("a", lines(1), search)).toBe(false);
    expect(memory.delete("a")).toBe(true);
    expect(memory.delete("a")).toBe(false);
    expect(memory.remember("a", lines(1), search)).toBe(true);
    memory.clear();
    expect(memory.size).toBe(0);
    for (let i = 0; i < ENGINE_LINE_MEMORY_CAPACITY + 1; i++) memory.set(String(i), lines(i));
    expect(memory.size).toBe(ENGINE_LINE_MEMORY_CAPACITY);
    expect(memory.has("0")).toBe(false);
    expect(memory.has("1")).toBe(true);
    expect(memory.has(String(ENGINE_LINE_MEMORY_CAPACITY))).toBe(true);
});
