import { createStore, getDefaultStore } from "jotai";
import { afterEach, expect, test } from "vitest";
import { requestSettingsNavigation, settingsNavigationRequestAtom } from "./settingsNavigation";

afterEach(() => {
    getDefaultStore().set(settingsNavigationRequestAtom, null);
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
