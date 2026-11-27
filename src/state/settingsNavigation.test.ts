import { createStore, getDefaultStore } from "jotai";
import { afterEach, expect, test } from "vitest";
import {
    clearSettingsScroll,
    clearSettingsScrollKey,
    getSettingsScrollGeneration,
    readSettingsScroll,
    recordSettingsScroll,
    requestSettingsNavigation,
    settingsNavigationRequestAtom,
} from "./settingsNavigation";

afterEach(() => {
    getDefaultStore().set(settingsNavigationRequestAtom, null);
    clearSettingsScroll();
    localStorage.clear();
    sessionStorage.clear();
});

test("requestSettingsNavigation stores an in-memory request without touching web storage", () => {
    const store = createStore();
    expect(store.get(settingsNavigationRequestAtom)).toBeNull();

    const request = requestSettingsNavigation({ kind: "setting", settingId: "volume" }, store);
    expect(store.get(settingsNavigationRequestAtom)).toEqual(request);
    expect(request.target).toEqual({ kind: "setting", settingId: "volume" });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
});

test("a newer request replaces an unconsumed one with a distinct id", () => {
    const store = createStore();
    const first = requestSettingsNavigation({ kind: "category", category: "sound" }, store);
    const second = requestSettingsNavigation({ kind: "setting", settingId: "font-size" }, store);

    expect(second.id).toBeGreaterThan(first.id);
    expect(store.get(settingsNavigationRequestAtom)).toEqual(second);
});

test("requestSettingsNavigation defaults to the default Jotai store", () => {
    const request = requestSettingsNavigation({ kind: "category", category: "advanced" });
    expect(getDefaultStore().get(settingsNavigationRequestAtom)).toEqual(request);
});

test("scroll offsets are stored in memory per key, cleared on close with generation bump, and never touch web storage", () => {
    const gen = getSettingsScrollGeneration();
    recordSettingsScroll({ mode: "category", category: "board" }, 240, gen);
    recordSettingsScroll({ mode: "search", q: "font" }, 120, gen);

    expect(readSettingsScroll({ mode: "category", category: "board" })).toBe(240);
    expect(readSettingsScroll({ mode: "search", q: "font" })).toBe(120);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    clearSettingsScrollKey({ mode: "category", category: "board" });
    expect(readSettingsScroll({ mode: "category", category: "board" })).toBeUndefined();
    expect(readSettingsScroll({ mode: "search", q: "font" })).toBe(120);

    clearSettingsScroll();
    expect(getSettingsScrollGeneration()).toBeGreaterThan(gen);
    expect(readSettingsScroll({ mode: "search", q: "font" })).toBeUndefined();

    // A write carrying the pre-close generation is ignored.
    recordSettingsScroll({ mode: "category", category: "board" }, 300, gen);
    expect(readSettingsScroll({ mode: "category", category: "board" })).toBeUndefined();

    // A write carrying the new generation is accepted.
    const nextGen = getSettingsScrollGeneration();
    recordSettingsScroll({ mode: "category", category: "sound" }, 80, nextGen);
    expect(readSettingsScroll({ mode: "category", category: "sound" })).toBe(80);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
});
