import { createStore, type Atom } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "./atoms";

vi.mock("@/platform/native", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/platform/native")>()),
    warn: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
});

type PreferenceCase = {
    key: string;
    atomName:
        | "soundCollectionAtom"
        | "soundVolumeAtom"
        | "gameOpeningBookMaxPlyAtom"
        | "puzzleRatingRangeAtom"
        | "coverageMinGamesAtom";
    defaultValue: unknown;
    invalidValues: unknown[];
    validValues: unknown[];
};

const preferences: PreferenceCase[] = [
    {
        key: "sound-collection",
        atomName: "soundCollectionAtom",
        defaultValue: "standard",
        invalidValues: ["../../etc", "", "Standard"],
        validValues: ["futuristic", "lisp", "nes", "piano", "robot", "sfx", "standard", "woodland"],
    },
    {
        key: "sound-volume",
        atomName: "soundVolumeAtom",
        defaultValue: 0.8,
        invalidValues: [2, -1, 1e308],
        validValues: [0, 1, 0.35],
    },
    {
        key: "game-opening-book-max-ply",
        atomName: "gameOpeningBookMaxPlyAtom",
        defaultValue: 40,
        invalidValues: [0, -3, 1.5, 1e16],
        validValues: [1, 40, 500, Number.MAX_SAFE_INTEGER],
    },
    {
        key: "puzzle-ratings",
        atomName: "puzzleRatingRangeAtom",
        defaultValue: [1000, 1500],
        invalidValues: [
            [null, null],
            ["1000", "1500"],
            [1000],
            [1500, 1000],
            [1000, 1500, 2000],
            Array(10000).fill(1000),
            [-1, 1500],
            [1000, 65536],
            [1000.5, 1500],
        ],
        validValues: [
            [1000, 1500],
            [2850, 2900],
            [0, 0],
            [0, 65535],
            [65535, 65535],
        ],
    },
    {
        key: "coverage-min-games",
        atomName: "coverageMinGamesAtom",
        defaultValue: 50,
        invalidValues: [0, -3, 1.5, 1e16],
        validValues: [1, 40, 500, Number.MAX_SAFE_INTEGER],
    },
];

describe.each(preferences)(
    "$key real atom hydration",
    ({ key, atomName, defaultValue, invalidValues, validValues }) => {
        async function hydrate(storedValue: unknown, expectedValue: unknown, repairs: boolean) {
            const encoded = JSON.stringify(storedValue);
            localStorage.setItem(key, encoded);
            const write = vi.spyOn(Storage.prototype, "setItem");
            const atoms = await import("./atoms");
            const preference: Atom<unknown> = atoms[atomName];
            const store = createStore();
            const unsubscribe = store.sub(preference, () => {});
            try {
                expect(store.get(preference)).toEqual(expectedValue);
                expect(localStorage.getItem(key)).toBe(JSON.stringify(expectedValue));
                expect(write.mock.calls.filter(([writtenKey]) => writtenKey === key)).toEqual(
                    repairs ? [[key, JSON.stringify(expectedValue)]] : [],
                );
            } finally {
                unsubscribe();
            }
        }

        test.each(
            invalidValues.map((value) => ({
                value,
                label:
                    Array.isArray(value) && value.length > 10
                        ? `${value.length}-element array`
                        : JSON.stringify(value),
            })),
        )("repairs $label to the default and rewrites storage", async ({ value }) => {
            expect.assertions(3);
            await hydrate(value, defaultValue, true);
        });

        test.each(validValues.map((value) => ({ value, label: JSON.stringify(value) })))(
            "preserves $label without rewriting storage",
            async ({ value }) => {
                expect.assertions(3);
                await hydrate(value, value, false);
            },
        );
    },
);
