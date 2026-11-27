import { createStore } from "jotai";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    coachAvailable: vi.fn(),
    coachConnections: vi.fn(),
    coachModels: vi.fn(),
    coachOpenUsage: vi.fn(),
    warn: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({ warn: mocks.warn, error: vi.fn() }));

// Seed storage before ./coach is first evaluated so getOnInit reads these values on module init.
localStorage.setItem("coach-notice-accepted", JSON.stringify(["conn-1"]));
localStorage.setItem(
    "coach-selection",
    JSON.stringify({ connection: "conn-1", model: "plain", effort: null }),
);
localStorage.setItem("coach-engine", JSON.stringify("engine-1"));

const { coachEngineAtom, coachNoticeAcceptedAtom, coachSelectionAtom } = await import("./coach");

test("persisted coach atoms hydrate from localStorage on init without mounting a subscription", () => {
    const store = createStore();
    expect(store.get(coachNoticeAcceptedAtom)).toEqual(["conn-1"]);
    expect(store.get(coachSelectionAtom)).toEqual({
        connection: "conn-1",
        model: "plain",
        effort: null,
    });
    expect(store.get(coachEngineAtom)).toBe("engine-1");
});
