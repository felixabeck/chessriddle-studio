import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BOARD_IMAGES, DEFAULT_BOARD_IMAGE, DEFAULT_PIECE_SET, PIECE_SETS } from "./artworkCatalog";
import "./atoms";

vi.mock("@/platform/native", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/platform/native")>()),
    warn: vi.fn().mockResolvedValue(undefined),
}));

const pieceStylesheets = new Set(
    Object.keys(import.meta.glob("../../public/pieces/*.css")).map((path) =>
        path.split("/").at(-1),
    ),
);
const boardAssets = new Set(
    Object.keys(import.meta.glob("../../public/board/*")).map((path) => path.split("/").at(-1)),
);

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
});

test.each(["retired-or-invalid-set"] as const)(
    "unknown stored piece set %j hydrates to the default and repairs storage",
    async (storedValue) => {
        localStorage.setItem("piece-set", JSON.stringify(storedValue));
        const { pieceSetAtom } = await import("./atoms");
        const store = createStore();
        const unsubscribe = store.sub(pieceSetAtom, () => {});
        try {
            expect(store.get(pieceSetAtom)).toBe(DEFAULT_PIECE_SET);
            expect(localStorage.getItem("piece-set")).toBe(JSON.stringify(DEFAULT_PIECE_SET));
        } finally {
            unsubscribe();
        }
    },
);

test.each(["unsupported-board.svg", "blue.svg"] as const)(
    "unknown stored board image %j hydrates to the default and repairs storage",
    async (storedValue) => {
        localStorage.setItem("board-image", JSON.stringify(storedValue));
        const { boardImageAtom } = await import("./atoms");
        const store = createStore();
        const unsubscribe = store.sub(boardImageAtom, () => {});
        try {
            expect(store.get(boardImageAtom)).toBe(DEFAULT_BOARD_IMAGE);
            expect(localStorage.getItem("board-image")).toBe(JSON.stringify(DEFAULT_BOARD_IMAGE));
        } finally {
            unsubscribe();
        }
    },
);

test("supported non-default piece set cburnett round-trips unchanged", async () => {
    localStorage.setItem("piece-set", JSON.stringify("cburnett"));
    const { pieceSetAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(pieceSetAtom, () => {});
    try {
        expect(store.get(pieceSetAtom)).toBe("cburnett");
        expect(localStorage.getItem("piece-set")).toBe(JSON.stringify("cburnett"));
    } finally {
        unsubscribe();
    }
});

test("supported non-default board image gray.svg round-trips unchanged", async () => {
    localStorage.setItem("board-image", JSON.stringify("gray.svg"));
    const { boardImageAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(boardImageAtom, () => {});
    try {
        expect(store.get(boardImageAtom)).toBe("gray.svg");
        expect(localStorage.getItem("board-image")).toBe(JSON.stringify("gray.svg"));
    } finally {
        unsubscribe();
    }
});

test("absent piece set hydrates to the default without writing", async () => {
    const { pieceSetAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(pieceSetAtom, () => {});
    try {
        expect(store.get(pieceSetAtom)).toBe(DEFAULT_PIECE_SET);
        expect(localStorage.getItem("piece-set")).toBe(null);
    } finally {
        unsubscribe();
    }
});

test("absent board image hydrates to the default without writing", async () => {
    const { boardImageAtom } = await import("./atoms");
    const store = createStore();
    const unsubscribe = store.sub(boardImageAtom, () => {});
    try {
        expect(store.get(boardImageAtom)).toBe(DEFAULT_BOARD_IMAGE);
        expect(localStorage.getItem("board-image")).toBe(null);
    } finally {
        unsubscribe();
    }
});

test("every catalog piece set has a stylesheet and every board has its image and thumbnail", () => {
    expect(
        PIECE_SETS.map((pieceSet) => `${pieceSet.value}.css`).filter(
            (file) => !pieceStylesheets.has(file),
        ),
    ).toEqual([]);
    expect([...BOARD_IMAGES].filter((board) => !boardAssets.has(board))).toEqual([]);
    expect(
        BOARD_IMAGES.filter((board) => !board.endsWith(".svg"))
            .map((board) => board.replace(".", ".thumbnail."))
            .filter((thumbnail) => !boardAssets.has(thumbnail)),
    ).toEqual([]);
});
