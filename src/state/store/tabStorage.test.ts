import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { defaultTree, MAX_GAME_END_TERMINATION_LENGTH } from "@/utils/treeReducer";
import { emptyPuzzleSession } from "@/state/puzzleSession";
import { deserializeStorageValue, serializeStorageValue } from "./debouncedStorage";
import {
    canRehydrate,
    decodeLegacyOrCompressed,
    isBoundedTreeForStorage,
    migrateTreeForStorage,
    persistStorageWriteError,
    prepareTreeForStorage,
    PGN_TEXT_MAX,
    TabStorageRepository,
    TREE_STORAGE_VERSION,
} from "./tabStorage";

const native = vi.hoisted(() => ({ warn: vi.fn().mockResolvedValue(undefined) }));
const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
const CANONICAL_GLYPH_NAGS = [
    1, 3, 2, 4, 5, 6, 18, 16, 14, 10, 13, 15, 17, 19, 146, 32, 36, 40, 132, 44, 138, 140, 7, 22, 9,
];
vi.mock("@/platform/native", () => native);
vi.mock("@/state/persistError", () => persistError);

let storage: TabStorageRepository;

beforeEach(() => {
    sessionStorage.clear();
    storage = new TabStorageRepository();
    vi.useFakeTimers();
    native.warn.mockClear();
    persistError.reportPersistError.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function treeWith(value: (tree: ReturnType<typeof defaultTree>) => void) {
    const tree = structuredClone(defaultTree());
    value(tree);
    return tree;
}

type StoredTreeForTest = ReturnType<typeof defaultTree> & { practicePath?: number[] | null };

function treeWithPaths(paths: {
    position?: number[];
    start?: number[];
    practicePath?: number[] | null;
}): StoredTreeForTest {
    const tree: StoredTreeForTest = defaultTree();
    const e4: typeof tree.root = {
        ...tree.root,
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        san: "e4",
        halfMoves: 1,
        children: [],
    };
    e4.children.push({
        ...e4,
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        san: "e5",
        halfMoves: 2,
        children: [],
    });
    const d4: typeof tree.root = {
        ...tree.root,
        fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1",
        san: "d4",
        halfMoves: 1,
        children: [],
    };
    tree.root.children.push(e4, d4);

    if (paths.position !== undefined) tree.position = paths.position;
    if (paths.start !== undefined) tree.headers.start = paths.start;
    if ("practicePath" in paths) tree.practicePath = paths.practicePath;
    return tree;
}

function persistTree(tabId: string, state: unknown) {
    sessionStorage.setItem(tabId, serializeStorageValue({ version: TREE_STORAGE_VERSION, state }));
}

test("persisted game-end termination accepts bounded text and rejects invalid shapes", () => {
    const tree = treeWithPaths({});
    for (const gameEnd of [{}, { termination: "x".repeat(MAX_GAME_END_TERMINATION_LENGTH) }]) {
        tree.root.children[0].gameEnd = gameEnd;
        expect(canRehydrate(tree)).toBe(true);
        expect(prepareTreeForStorage(tree).root.children[0].gameEnd).toEqual(gameEnd);
    }
    for (const gameEnd of [
        null,
        true,
        "Abandoned",
        { termination: 5 },
        { termination: "x".repeat(MAX_GAME_END_TERMINATION_LENGTH + 1) },
    ]) {
        const candidate = { ...tree, root: { ...tree.root, gameEnd } };
        expect(canRehydrate(candidate)).toBe(false);
    }
});

test("durable seed supersedes only its own stale pending frame and survives unload", () => {
    persistTree("session", defaultTree());
    const old = treeWith((tree) => {
        tree.root.comment = "old queued frame";
    });
    storage.write("session", { version: TREE_STORAGE_VERSION, state: old });
    storage.write("other", { version: TREE_STORAGE_VERSION, state: old });
    const candidate = treeWith((tree) => {
        tree.puzzleSession = emptyPuzzleSession();
        tree.root.comment = "admitted session";
    });
    storage.seed("session", candidate);
    expect(storage.pendingCount()).toBe(1);
    expect(storage.read("session")?.state).toMatchObject(candidate);
    window.dispatchEvent(new Event("pagehide"));
    expect(storage.read("session")?.state).toMatchObject(candidate);
    expect(storage.read("other")?.state).toMatchObject(old);
});

test("refused seed retains durable bytes and pending edits for retry", () => {
    storage.seed("session", defaultTree());
    const before = sessionStorage.getItem("session");
    const pending = treeWith((tree) => {
        tree.root.comment = "latest played tree";
    });
    storage.write("session", { version: TREE_STORAGE_VERSION, state: pending });
    const candidate = { ...pending, puzzleSession: emptyPuzzleSession() };
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => storage.seed("session", candidate)).toThrow("session storage is full");
    expect(sessionStorage.getItem("session")).toBe(before);
    expect(storage.pendingCount()).toBe(1);
    expect(storage.read("session")?.state).toMatchObject(pending);
    setItem.mockRestore();
    storage.seed("session", candidate);
    expect(storage.pendingCount()).toBe(0);
    expect(storage.read("session")?.state).toMatchObject(candidate);
});

test.each([false, true])("session survives %s durable cloning independently", (durable) => {
    const source = treeWith((tree) => {
        tree.puzzleSession = emptyPuzzleSession();
    });
    storage.seed("source-session", source);
    const result = durable
        ? storage.cloneDurable("source-session", "copy-session")
        : storage.clone("source-session", "copy-session");
    expect(result).toEqual(durable ? undefined : { kind: "copied" });
    storage.flush();
    const copy = storage.read<ReturnType<typeof defaultTree>>("copy-session")!.state;
    expect(copy.puzzleSession).toEqual(source.puzzleSession);
    expect(copy.puzzleSession).not.toBe(source.puzzleSession);
    copy.puzzleSession!.selectedAttemptId = "unresolved";
    expect(
        storage.read<ReturnType<typeof defaultTree>>("source-session")!.state.puzzleSession!
            .selectedAttemptId,
    ).toBeNull();
});

function treeWithCircleAndArrow() {
    const tree = treeWithPaths({ position: [0] });
    tree.puzzleSession = emptyPuzzleSession();
    tree.root.shapes = [
        { orig: "a1", brush: "green" },
        { orig: "b2", dest: "h8", brush: "red", modifiers: { lineWidth: 2 } },
    ] satisfies DrawShape[];
    tree.root.children[0].shapes = [{ orig: "e4", dest: undefined, brush: "blue" }];
    return tree;
}

test.each(["admission", "ordinary flush"] as const)(
    "circles and arrows survive %s and a fresh storage reader without losing annotations",
    (route) => {
        const tree = treeWithCircleAndArrow();
        expect(prepareTreeForStorage(tree).root.shapes).toEqual(tree.root.shapes);
        if (route === "admission") storage.seed("drawings", tree);
        else storage.write("drawings", { version: TREE_STORAGE_VERSION, state: tree });
        expect(storage.flush()).toEqual([]);
        const durable = deserializeStorageValue<{ state: StoredTreeForTest }>(
            sessionStorage.getItem("drawings")!,
        )!.state;
        expect(durable.root.shapes).toEqual(tree.root.shapes);
        expect(durable.root.children[0].shapes).toEqual([{ orig: "e4", brush: "blue" }]);
        const restored = new TabStorageRepository().read<StoredTreeForTest>("drawings")!.state;
        expect(restored.root.shapes).toEqual(tree.root.shapes);
        expect(restored.root.children[0].shapes).toEqual([{ orig: "e4", brush: "blue" }]);
        expect(restored.position).toEqual([0]);
        expect(restored.puzzleSession).toEqual(tree.puzzleSession);
    },
);

test.each([false, true])(
    "circle and arrow annotations survive durable clone %s independently",
    (durable) => {
        const tree = treeWithCircleAndArrow();
        storage.seed("drawn-source", tree);
        const result = durable
            ? storage.cloneDurable("drawn-source", "drawn-copy")
            : storage.clone("drawn-source", "drawn-copy");
        expect(result).toEqual(durable ? undefined : { kind: "copied" });
        expect(storage.flush()).toEqual([]);
        const reader = new TabStorageRepository();
        const copy = reader.read<StoredTreeForTest>("drawn-copy")!.state;
        expect(copy.root.shapes).toEqual(tree.root.shapes);
        expect(copy.root.children[0].shapes).toEqual(tree.root.children[0].shapes);
        copy.root.shapes[0].brush = "yellow";
        expect(reader.read<StoredTreeForTest>("drawn-source")!.state.root.shapes).toEqual(
            tree.root.shapes,
        );
    },
);

test.each([null, 42, "", "e9", "xa1", "h8x"])(
    "a present malformed drawing destination %j still refuses admission, flush and reload",
    (dest) => {
        const original = treeWithCircleAndArrow();
        storage.seed("drawing-owner", original);
        const bytes = sessionStorage.getItem("drawing-owner");
        const invalid = structuredClone(original);
        invalid.root.shapes = [{ orig: "a1", dest, brush: "green" }] as never;
        expect(() => prepareTreeForStorage(invalid)).toThrow(
            "Cannot persist an invalid game tree.",
        );
        expect(() => storage.seed("drawing-owner", invalid)).toThrow(
            "Cannot persist an invalid game tree.",
        );
        storage.write("drawing-owner", { version: TREE_STORAGE_VERSION, state: invalid });
        expect(storage.flush({ notify: true })).toEqual(["drawing-owner"]);
        expect(sessionStorage.getItem("drawing-owner")).toBe(bytes);
        const raw = serializeStorageValue({ version: TREE_STORAGE_VERSION, state: invalid });
        sessionStorage.setItem("corrupt-drawings", raw);
        expect(new TabStorageRepository().readTree("corrupt-drawings")).toEqual({
            kind: "unreadable",
            rawValue: raw,
        });
        expect(sessionStorage.getItem("corrupt-drawings")).toBe(raw);
    },
);

test.each([
    { version: 2, attempts: [], selectedAttemptId: null },
    { version: 1, attempts: "broken", selectedAttemptId: null },
    null,
])(
    "present invalid session preserves the complete original record through reads and writes: %j",
    (puzzleSession) => {
        const raw = serializeStorageValue({
            version: TREE_STORAGE_VERSION,
            state: { ...defaultTree(), puzzleSession },
        });
        sessionStorage.setItem("invalid-session", raw);
        expect(storage.readTree("invalid-session")).toEqual({ kind: "unreadable", rawValue: raw });
        storage.write("invalid-session", { state: defaultTree() });
        expect(() => storage.seed("invalid-session", defaultTree())).toThrow(
            "unreadable or unavailable",
        );
        expect(storage.clone("invalid-session", "copy")).toEqual({
            kind: "unreadable",
            rawValue: raw,
        });
        expect(storage.flush()).toEqual([]);
        expect(sessionStorage.getItem("invalid-session")).toBe(raw);
    },
);

function storeLegacyTree(tabId: string, state: unknown) {
    sessionStorage.setItem(tabId, JSON.stringify({ version: 0, state }));
}

function expectSeedRejected(value: ReturnType<typeof defaultTree>) {
    expect(() => storage.seed("invalid", value)).toThrow("Cannot persist an invalid game tree.");
    expect(sessionStorage.getItem("invalid")).toBeNull();
}

test("middleware distinguishes an empty legacy owner from a missing durable reference", () => {
    const legacy = crypto.randomUUID();
    const reference = crypto.randomUUID();
    expect(storage.read(legacy)).toBeNull();
    expect(storage.getStatus(legacy)).toEqual({ kind: "absent" });
    const legacyStorage = storage.storageFor<ReturnType<typeof defaultTree>>();
    expect(legacyStorage.getItem(legacy)).toBeNull();
    expect(storage.getStatus(legacy)).toEqual({ kind: "absent" });
    legacyStorage.setItem(legacy, { version: TREE_STORAGE_VERSION, state: defaultTree() });
    expect(storage.flush()).toEqual([]);
    expect(sessionStorage.getItem(legacy)).not.toBeNull();
    const referencedStorage = storage.storageFor<ReturnType<typeof defaultTree>>(true);
    expect(referencedStorage.getItem(reference)).toBeNull();
    expect(storage.getStatus(reference)).toEqual({
        kind: "unavailable",
        error: new Error("The referenced game tree is missing."),
    });
    referencedStorage.setItem(reference, { version: TREE_STORAGE_VERSION, state: defaultTree() });
    expect(storage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem(reference)).toBeNull();
});

test.each([
    { scenario: "decodable non-UUID", uuid: false, raw: "tree", expected: true },
    { scenario: "undecodable UUID", uuid: true, raw: "not a tree", expected: true },
    { scenario: "undecodable non-UUID", uuid: false, raw: "not a tree", expected: false },
    { scenario: "absent UUID", uuid: true, raw: null, expected: false },
    { scenario: "empty UUID", uuid: true, raw: "", expected: true },
])(
    "pending-removal target accepts $scenario according to intent authority",
    ({ uuid, raw, expected }) => {
        const tabId = uuid ? crypto.randomUUID() : "legacy-tree";
        if (raw === "tree") persistTree(tabId, defaultTree());
        else if (raw !== null) sessionStorage.setItem(tabId, raw);
        const getItem = vi.spyOn(Storage.prototype, "getItem");

        try {
            expect(storage.hasPendingRemovalTarget(tabId)).toBe(expected);
            expect(getItem).toHaveBeenCalledExactlyOnceWith(tabId);
        } finally {
            getItem.mockRestore();
        }
    },
);

test("legacy NAG migration preserves order, duplicates and children and writes back", () => {
    const tree = defaultTree();
    const { nags: _rootNags, ...root } = tree.root;
    const legacy = {
        ...tree,
        root: {
            ...root,
            annotations: ["", "!", "□"],
            children: [{ ...root, annotations: ["□", "□"], children: [] }],
        },
    };
    persistTree("legacy-nags", legacy);
    const expected = {
        ...tree,
        root: {
            ...tree.root,
            nags: [1, 7],
            children: [{ ...tree.root, nags: [7, 7], children: [] }],
        },
    };
    expect(storage.readTree("legacy-nags")).toEqual({
        kind: "available",
        value: { version: TREE_STORAGE_VERSION, state: expected },
    });
    expect(deserializeStorageValue(sessionStorage.getItem("legacy-nags")!)).toEqual({
        version: TREE_STORAGE_VERSION,
        state: expected,
    });
    expect(storage.read("legacy-nags")?.state).toEqual(expected);
    expect(migrateTreeForStorage(expected)).toEqual(expected);
});

test("legacy NAG migration accepts every value of the old glyph schema", () => {
    const tree = defaultTree();
    const { nags: _rootNags, ...root } = tree.root;
    persistTree("all-legacy-nags", {
        ...tree,
        root: {
            ...root,
            annotations: [
                "",
                "!",
                "!!",
                "?",
                "??",
                "!?",
                "?!",
                "+-",
                "±",
                "⩲",
                "=",
                "∞",
                "⩱",
                "∓",
                "-+",
                "N",
                "↑↑",
                "↑",
                "→",
                "⇆",
                "=∞",
                "⊕",
                "∆",
                "□",
                "⨀",
                "⊗",
            ],
        },
    });
    expect(storage.readTree("all-legacy-nags")).toEqual({
        kind: "available",
        value: {
            version: TREE_STORAGE_VERSION,
            state: { ...tree, root: { ...tree.root, nags: CANONICAL_GLYPH_NAGS } },
        },
    });
});

test("legacy NAG migration refuses invalid glyphs and keeps unreadable bytes gated", () => {
    const tree = defaultTree();
    const { nags: _nags, ...root } = tree.root;
    persistTree("invalid-legacy-nags", { ...tree, root: { ...root, annotations: ["bogus"] } });
    const raw = sessionStorage.getItem("invalid-legacy-nags")!;
    expect(storage.readTree("invalid-legacy-nags")).toEqual({ kind: "unreadable", rawValue: raw });
    expect(storage.getStatus("invalid-legacy-nags")).toEqual({ kind: "unreadable", rawValue: raw });
    expect(() => storage.seed("invalid-legacy-nags", tree)).toThrow(
        "Cannot replace a tab tree while its storage is unreadable or unavailable.",
    );
    expect(sessionStorage.getItem("invalid-legacy-nags")).toBe(raw);
});

test("legacy NAG migration refuses oversized annotations and keeps unreadable bytes gated", () => {
    const tree = defaultTree();
    const { nags: _nags, ...root } = tree.root;
    persistTree("oversized-legacy-nags", {
        ...tree,
        root: { ...root, annotations: Array(1_025).fill("") },
    });
    const raw = sessionStorage.getItem("oversized-legacy-nags")!;
    expect(storage.readTree("oversized-legacy-nags")).toEqual({
        kind: "unreadable",
        rawValue: raw,
    });
    expect(storage.getStatus("oversized-legacy-nags")).toEqual({
        kind: "unreadable",
        rawValue: raw,
    });
    expect(() => storage.seed("oversized-legacy-nags", tree)).toThrow(
        "Cannot replace a tab tree while its storage is unreadable or unavailable.",
    );
    expect(sessionStorage.getItem("oversized-legacy-nags")).toBe(raw);
});

test("legacy NAG migration accepts the annotations length boundary", () => {
    const tree = defaultTree();
    const { nags: _nags, ...root } = tree.root;
    persistTree("boundary-legacy-nags", {
        ...tree,
        root: { ...root, annotations: [...Array(1_023).fill(""), "!"] },
    });
    const expected = { ...tree, root: { ...tree.root, nags: [1] } };
    expect(storage.readTree("boundary-legacy-nags")).toEqual({
        kind: "available",
        value: { version: TREE_STORAGE_VERSION, state: expected },
    });
    expect(deserializeStorageValue(sessionStorage.getItem("boundary-legacy-nags")!)).toEqual({
        version: TREE_STORAGE_VERSION,
        state: expected,
    });
});

test.each([[256], [1.5], [-1]])("stored NAGs reject invalid codes %j", (code) => {
    persistTree(
        "invalid-nags",
        treeWith((tree) => {
            tree.root.nags = [code];
        }),
    );
    const raw = sessionStorage.getItem("invalid-nags")!;
    expect(storage.readTree("invalid-nags")).toEqual({ kind: "unreadable", rawValue: raw });
    expectSeedRejected(
        treeWith((tree) => {
            tree.root.nags = [code];
        }),
    );
});

test("stored NAG boundaries remain unchanged", () => {
    const tree = treeWith((tree) => {
        tree.root.nags = [0, 255];
    });
    storage.seed("boundary-nags", tree);
    expect(storage.read("boundary-nags")?.state).toEqual(tree);
    expect(migrateTreeForStorage(tree)).toEqual(tree);
});

test("legacy annotations never replace an existing NAG array", () => {
    const tree = treeWith((tree) => {
        tree.root.nags = [8, 8, 220];
    });
    const mixed = { ...tree, root: { ...tree.root, annotations: ["?"] } };
    expect(migrateTreeForStorage(mixed)).toEqual(mixed);
    persistTree("mixed-nags", mixed);
    expect(storage.readTree("mixed-nags")).toEqual({
        kind: "available",
        value: { version: TREE_STORAGE_VERSION, state: tree },
    });
});

test.each(["x", null])("legacy annotations never repair corrupt own nags %j", (nags) => {
    const tree = defaultTree();
    persistTree("corrupt-own-nags", { ...tree, root: { ...tree.root, nags, annotations: ["!"] } });
    const raw = sessionStorage.getItem("corrupt-own-nags")!;
    expect(storage.readTree("corrupt-own-nags")).toEqual({ kind: "unreadable", rawValue: raw });
    expect(storage.getStatus("corrupt-own-nags")).toEqual({ kind: "unreadable", rawValue: raw });
    expect(() => storage.seed("corrupt-own-nags", tree)).toThrow(
        "Cannot replace a tab tree while its storage is unreadable or unavailable.",
    );
    expect(sessionStorage.getItem("corrupt-own-nags")).toBe(raw);
});

test("failed legacy NAG write-back returns the migrated tree and retries on the next read", () => {
    const tree = defaultTree();
    const { nags: _nags, ...root } = tree.root;
    persistTree("quota-legacy-nags", { ...tree, root: { ...root, annotations: ["□"] } });
    const raw = sessionStorage.getItem("quota-legacy-nags")!;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new Error("quota");
    });
    expect(storage.readTree("quota-legacy-nags")).toMatchObject({
        kind: "available",
        value: { state: { root: { nags: [7] } } },
    });
    expect(sessionStorage.getItem("quota-legacy-nags")).toBe(raw);
    expect(native.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not migrate tree storage"),
    );
    setItem.mockRestore();
    expect(storage.readTree("quota-legacy-nags")).toMatchObject({
        kind: "available",
        value: { state: { root: { nags: [7] } } },
    });
    expect(sessionStorage.getItem("quota-legacy-nags")).not.toBe(raw);
});

test("preserves every supported tree schema field and enum boundary", () => {
    const tree = treeWith((state) => {
        state.root = {
            ...state.root,
            fen: "root-fen",
            move: { from: 0, to: 63, promotion: "queen" },
            san: "Qa8",
            children: [
                {
                    ...state.root,
                    fen: "child-fen",
                    move: { role: "pawn", to: 63 },
                    score: { value: { type: "mate", value: -3 }, wdl: [1, 0, 0] },
                    depth: 0,
                    halfMoves: 2,
                    shapes: [
                        {
                            orig: "a1",
                            dest: "h8",
                            brush: "",
                            modifiers: { lineWidth: 0 },
                        },
                    ],
                    nags: CANONICAL_GLYPH_NAGS,
                    comment: "child",
                    clock: 0,
                },
            ],
            score: { value: { type: "cp", value: 0 }, wdl: null },
            depth: null,
            shapes: [],
            nags: [],
            comment: "root",
        };
        state.headers = {
            id: 0,
            fen: "header-fen",
            event: "event",
            site: "site",
            date: "2026.08.09",
            time: "12:00",
            round: "1",
            white: "White",
            white_elo: 0,
            black: "Black",
            black_elo: 0,
            result: "1/2-1/2",
            time_control: "600+0",
            white_time_control: "600+0",
            black_time_control: "600+0",
            eco: "A00",
            variant: "standard",
            other: { custom: "value" },
            start: [0, 1],
            orientation: "black",
        };
        state.position = [0, 1];
        (state as typeof state & { practicePath?: number[] }).practicePath = [0];
    });

    storage.seed("rich", tree);
    expect(storage.getStatus("rich")).toEqual({ kind: "available" });

    expect(storage.read("rich")?.state).toMatchObject({
        root: {
            move: { from: 0, to: 63, promotion: "queen" },
            score: { value: { type: "cp", value: 0 }, wdl: null },
            children: [
                {
                    move: { role: "pawn", to: 63 },
                    score: { value: { type: "mate", value: -3 }, wdl: [1, 0, 0] },
                    shapes: [{ orig: "a1", dest: "h8", brush: "" }],
                },
            ],
        },
        headers: { result: "1/2-1/2", orientation: "black", other: { custom: "value" } },
        practicePath: [0],
    });
});

test("accepts both coordinate move boundaries and both header orientations", () => {
    const boundary = treeWith((tree) => {
        tree.root.move = { from: 63, to: 0 };
        tree.headers.orientation = "black";
    });
    storage.seed("coordinate-boundary", boundary);
    expect(storage.read("coordinate-boundary")?.state).toMatchObject({
        root: { move: { from: 63, to: 0 } },
        headers: { orientation: "black" },
    });

    const drop = treeWith((tree) => (tree.root.move = { role: "king", to: 63 }));
    storage.seed("drop-boundary", drop);
    expect(storage.read("drop-boundary")?.state).toMatchObject({
        root: { move: { role: "king", to: 63 } },
    });

    expectSeedRejected(treeWith((tree) => (tree.headers.orientation = "green" as never)));
});

test("tree seed and read operations validate the complete schema boundaries", () => {
    const fresh = storage;
    const tree = treeWith((state) => {
        state.root.move = { from: 0, to: 63, promotion: "queen" };
        state.root.score = { value: { type: "cp", value: 0 }, wdl: [0, 1, 0] };
        state.root.score = { value: { type: "cp", value: 0 }, wdl: [0, 1, 0] };
        state.root.children = [
            {
                ...state.root,
                move: { role: "king", to: 0 },
                score: { value: { type: "mate", value: 1 }, wdl: null },
                children: [],
            },
        ];
        state.root.shapes = [{ orig: "a1", dest: "h8", brush: "", modifiers: { lineWidth: 0 } }];
        state.root.nags = CANONICAL_GLYPH_NAGS;
        state.headers = {
            ...state.headers,
            result: "0-1",
            orientation: "white",
            other: { custom: "value" },
        };
    });

    fresh.seed("fresh-schema", tree);
    expect(fresh.read("fresh-schema")?.state).toMatchObject({
        root: {
            move: { from: 0, to: 63, promotion: "queen" },
            score: { value: { type: "cp", value: 0 }, wdl: [0, 1, 0] },
            shapes: [{ orig: "a1", dest: "h8", brush: "", modifiers: { lineWidth: 0 } }],
            nags: tree.root.nags,
        },
        headers: { result: "0-1", orientation: "white", other: { custom: "value" } },
    });

    for (const result of ["1-0", "0-1", "1/2-1/2", "*"] as const) {
        const withResult = structuredClone(tree);
        withResult.headers.result = result;
        fresh.seed(`result-${result}`, withResult);
        expect(fresh.read(`result-${result}`)?.state).toMatchObject({ headers: { result } });
    }

    for (const role of ["pawn", "knight", "bishop", "rook", "queen", "king"] as const) {
        const withRole = structuredClone(tree);
        withRole.root.move = { role, to: 0 };
        fresh.seed(`role-${role}`, withRole);
        expect(fresh.read(`role-${role}`)?.state).toMatchObject({
            root: { move: { role, to: 0 } },
        });
    }

    for (const invalidShape of ["xa1", "a1x"] as const) {
        const invalid = structuredClone(tree);
        invalid.root.shapes = [{ orig: invalidShape, dest: "h8", brush: "" }] as never;
        expect(() => fresh.seed(`invalid-shape-${invalidShape}`, invalid)).toThrow(
            "Cannot persist an invalid game tree.",
        );
    }
    for (const invalidDestination of ["xh8", "h8x"] as const) {
        const invalid = structuredClone(tree);
        invalid.root.shapes = [{ orig: "a1", dest: invalidDestination, brush: "" }] as never;
        expect(() => fresh.seed(`invalid-destination-${invalidDestination}`, invalid)).toThrow(
            "Cannot persist an invalid game tree.",
        );
    }
});

type TextField = (tree: ReturnType<typeof defaultTree>, text: string) => void;
const PGN_TEXT_FIELDS: [string, TextField][] = [
    ["comment", (tree, text) => (tree.root.comment = text)],
    ["commands", (tree, text) => (tree.root.commands = text)],
    ["startingComment", (tree, text) => (tree.root.startingComment = text)],
    ["a header", (tree, text) => (tree.headers.event = text)],
    ["an unknown header", (tree, text) => (tree.headers.other = { custom: text })],
];

// The gate, not a stored round trip: compressing 10 MiB per field costs ~17 s, and `seed`, `flush`
// and every read all go through this same predicate.
test.each(PGN_TEXT_FIELDS)(
    "%s rehydrates at the lexer's 10 MiB bound and is refused one character past it",
    (_, set) => {
        const atBound = "x".repeat(PGN_TEXT_MAX);
        expect(canRehydrate(treeWith((tree) => set(tree, atBound)))).toBe(true);
        expect(canRehydrate(treeWith((tree) => set(tree, `${atBound}x`)))).toBe(false);
    },
);

test("comment commands and a starting comment survive hydration", () => {
    const tree = treeWith((state) => {
        state.root.commands = "[%evp 0,34,61]";
        state.root.startingComment = "Also good: [%emt 0:00:01]";
    });

    storage.seed("commands", tree);
    expect(storage.read("commands")?.state).toMatchObject({
        root: { commands: "[%evp 0,34,61]", startingComment: "Also good: [%emt 0:00:01]" },
    });
});

test("hydrates legacy child comments by separating unmodeled PGN commands", () => {
    const tree = structuredClone(defaultTree());
    const child = { ...tree.root, children: [], comment: "[%evp 0,34] prose" };
    delete child.commands;
    delete tree.root.commands;
    tree.root.children = [child];
    storeLegacyTree("legacy-comment-command", tree);

    expect(storage.read("legacy-comment-command")?.state).toMatchObject({
        root: {
            children: [{ comment: "prose", commands: "[%evp 0,34]" }],
        },
    });
});

test.each(["legacy", "current"])(
    "hydrates %s six-color drawings once and writes them back without touching current prose",
    (format) => {
        const tree = structuredClone(defaultTree());
        const drawings = "[%cal Re2e4,Oe2e4,Oe2e4,Cg1f3,Xa1a2] [%csl Oa1,Cb2] [%opaque keep $&]";
        const prose = format === "current" ? "Current prose [%csl Oa8]" : "Legacy prose";
        tree.root.comment = format === "legacy" ? `${prose} ${drawings}` : prose;
        if (format === "legacy") delete tree.root.commands;
        else tree.root.commands = drawings;
        tree.root.shapes = [
            { orig: "e2", dest: "e4", brush: "red" },
            { orig: "e2", dest: "e4", brush: "orange" },
            // Both circle representations match the imported square, without losing its modifier.
            { orig: "a1", brush: "orange", modifiers: { lineWidth: 5 } },
        ];
        tree.root.children = [
            { ...tree.root, children: [], shapes: [], commands: "[%cal Cf2f4]", comment: "Child" },
        ];
        if (format === "legacy") storeLegacyTree("six-color-hydration", tree);
        else persistTree("six-color-hydration", tree);
        const expectedShapes = [
            ...tree.root.shapes,
            { orig: "e2", dest: "e4", brush: "orange" },
            { orig: "g1", dest: "f3", brush: "cyan" },
            { orig: "b2", dest: "b2", brush: "cyan" },
        ];
        for (let pass = 0; pass < 3; pass++) {
            const read = new TabStorageRepository().read<StoredTreeForTest>("six-color-hydration")!;
            expect(read.state.root).toMatchObject({
                comment: prose,
                shapes: expectedShapes,
                children: [
                    {
                        comment: "Child",
                        commands: "",
                        shapes: [{ orig: "f2", dest: "f4", brush: "cyan" }],
                    },
                ],
            });
            expect(read.state.root.commands).toContain("[%cal Xa1a2]");
            expect(read.state.root.commands).toContain("[%opaque keep $&]");
            expect(read.state.root.commands).not.toContain("Oe2e4");
            expect(migrateTreeForStorage(read.state)).toEqual(read.state);
            expect(deserializeStorageValue(sessionStorage.getItem("six-color-hydration")!)).toEqual(
                read,
            );
        }
    },
);

test.each(["legacy", "current"])(
    "hydrates %s drawings with two existing matching arrows and keeps exactly two across reads and migration",
    (format) => {
        const tree = structuredClone(defaultTree());
        const drawings = "[%cal Oe2e4,Oe2e4]";
        tree.root.shapes = [
            { orig: "e2", dest: "e4", brush: "orange" },
            { orig: "e2", dest: "e4", brush: "orange" },
        ];
        tree.root.comment = format === "legacy" ? `Prose ${drawings}` : "Prose";
        if (format === "legacy") {
            delete tree.root.commands;
            storeLegacyTree("matching-drawings", tree);
        } else {
            tree.root.commands = drawings;
            persistTree("matching-drawings", tree);
        }

        for (let pass = 0; pass < 3; pass++) {
            const restored = new TabStorageRepository().read<StoredTreeForTest>(
                "matching-drawings",
            )!;
            expect(restored.state.root.shapes).toHaveLength(2);
            expect(restored.state.root.shapes).toEqual(tree.root.shapes);
            expect(restored.state.root.comment).toBe("Prose");
            expect(restored.state.root.commands ?? "").toBe("");
            expect(migrateTreeForStorage(restored.state)).toEqual(restored.state);

            const persisted = deserializeStorageValue<{ state: StoredTreeForTest }>(
                sessionStorage.getItem("matching-drawings")!,
            )!;
            expect(persisted.state.root.shapes).toHaveLength(2);
            expect(persisted.state.root.commands ?? "").toBe("");
            expect(persisted).toEqual(restored);
        }
    },
);

test("drawing hydration refuses an empty-string shapes field and preserves corrupt storage bytes", () => {
    const tree = treeWith((state) => {
        state.root.commands = "[%cal Oe2e4]";
        state.root.shapes = "" as never;
    });
    persistTree("invalid-hydrated-shapes", tree);
    const raw = sessionStorage.getItem("invalid-hydrated-shapes");

    expect.soft(canRehydrate(tree)).toBe(false);
    expect.soft(storage.readTree("invalid-hydrated-shapes")).toEqual({
        kind: "unreadable",
        rawValue: raw,
    });
    expect(sessionStorage.getItem("invalid-hydrated-shapes")).toBe(raw);
});

test("drawing hydration preserves opaque bytes and validation and shape count bounds", () => {
    const tree = structuredClone(defaultTree());
    tree.root.commands = "  [%cal Xa1a2] [%eval 1.23] [%clk 0:05:00] [%other keep]  ";
    expect(migrateTreeForStorage(tree)).toEqual(tree);
    tree.root.commands = "[%cal Oe2e4]";
    tree.root.shapes = [{ orig: "a1", brush: "green" }, null] as never;
    expect(canRehydrate(tree)).toBe(false);
    tree.root.shapes = Array.from({ length: 10_000 }, () => ({ orig: "a1", brush: "green" }));
    expect(canRehydrate(tree)).toBe(false);
    persistTree("too-many-hydrated-shapes", tree);
    const raw = sessionStorage.getItem("too-many-hydrated-shapes");
    expect(storage.readTree("too-many-hydrated-shapes")).toEqual({
        kind: "unreadable",
        rawValue: raw,
    });
    expect(sessionStorage.getItem("too-many-hydrated-shapes")).toBe(raw);
});

test("preserves nodes with a commands field while migrating legacy siblings", () => {
    const tree = structuredClone(defaultTree());
    tree.root.comment = "[%evp 0,34] root prose";
    tree.root.commands = "";
    const child = { ...tree.root, children: [], comment: "[%emt 0:00:01] child prose" };
    delete child.commands;
    tree.root.children = [child];

    expect(migrateTreeForStorage(tree)).toMatchObject({
        root: {
            comment: "[%evp 0,34] root prose",
            commands: "",
            children: [{ comment: "child prose", commands: "[%emt 0:00:01]" }],
        },
    });
});

test("keeps plain comments without adding commands when migrating the tree", () => {
    const tree = structuredClone(defaultTree());
    tree.root.comment = "[%evp 0,34] root prose";
    const child = { ...tree.root, children: [], comment: "plain comment" };
    delete child.commands;
    tree.root.children = [child];

    const migrated = migrateTreeForStorage(tree) as typeof tree;
    expect(migrated.root).toMatchObject({
        comment: "root prose",
        commands: "[%evp 0,34]",
        children: [{ comment: "plain comment" }],
    });
    expect(migrated.root.children[0]).not.toHaveProperty("commands");
});

test("migrates legacy comments down to the depth bound and leaves deeper nodes as stored", () => {
    const tree = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    const template: Record<string, unknown> = {
        ...(tree.root as Record<string, unknown>),
        children: [],
    };
    delete template.commands;
    const leaf = { ...template, comment: "[%evp 0,34] deep" };
    // 513 ancestors put the leaf at depth 513: one past MAX_TREE_DEPTH, so it is left as stored.
    let node: Record<string, unknown> = leaf;
    for (let depth = 0; depth < 513; depth++) node = { ...template, children: [node], comment: "" };
    tree.root = node;

    const descend = (root: unknown, levels: number) => {
        let current = root as Record<string, unknown>;
        for (let depth = 0; depth < levels; depth++) {
            current = (current.children as Record<string, unknown>[])[0];
        }
        return current;
    };
    const deep = migrateTreeForStorage(tree) as Record<string, unknown>;
    expect(descend(deep.root, 513)).toBe(leaf);

    // One ancestor fewer puts the same leaf at depth 512, which is migrated.
    tree.root = (node.children as Record<string, unknown>[])[0];
    const bounded = migrateTreeForStorage(tree) as Record<string, unknown>;
    expect(descend(bounded.root, 512)).toMatchObject({ comment: "deep", commands: "[%evp 0,34]" });
});

test("a legacy node without a comment string is passed through for the schema to judge", () => {
    const tree = structuredClone(defaultTree());
    const child = { ...tree.root, children: [] } as unknown as Record<string, unknown>;
    delete child.commands;
    delete child.comment;
    tree.root.children = [child as unknown as typeof tree.root];

    const migrated = migrateTreeForStorage(tree) as typeof tree;
    expect(migrated.root.children[0]).not.toHaveProperty("comment");
    expect(migrated.root.children[0]).not.toHaveProperty("commands");
});

test("a flush refuses a tree that would not rehydrate and keeps the stored one", () => {
    storage.seed(
        "oversized",
        treeWith(() => {}),
    );
    const stored = sessionStorage.getItem("oversized");
    storage.write("oversized", {
        version: 0,
        state: treeWith((tree) => (tree.root.comment = "x".repeat(PGN_TEXT_MAX + 1))),
    });

    expect(storage.flush({ notify: true })).toEqual(["oversized"]);
    expect(sessionStorage.getItem("oversized")).toBe(stored);
    // The user is told why the edit was not kept, not handed a generic storage failure.
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({
            message: "Could not save this game: it no longer fits tab storage.",
        }),
    );
});

test("rejects every persisted tree type, scalar, and structural boundary", () => {
    expectSeedRejected(treeWith((tree) => (tree.position = Array(513).fill(0))));
    expectSeedRejected(treeWith((tree) => (tree.root.move = { from: -1, to: 0 } as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.move = { from: 0, to: 64 } as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.move = { role: "queen", to: -1 } as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.move = { role: "queen", to: 64 } as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.move = { role: "dragon", to: 0 } as never)));
    expectSeedRejected(
        treeWith(
            (tree) =>
                (tree.root.score = { value: { type: "cp", value: Infinity }, wdl: null } as never),
        ),
    );
    expectSeedRejected(
        treeWith(
            (tree) =>
                (tree.root.score = { value: { type: "mate", value: 0.5 }, wdl: null } as never),
        ),
    );
    expectSeedRejected(
        treeWith((tree) => (tree.root.shapes = [{ orig: "xa1", dest: "h8", brush: "" }] as never)),
    );
    expectSeedRejected(
        treeWith((tree) => (tree.root.shapes = [{ orig: "a1x", dest: "h8", brush: "" }] as never)),
    );
    expectSeedRejected(
        treeWith(
            (tree) =>
                (tree.root.shapes = [{ orig: "a1", dest: "h8", brush: "x".repeat(65) }] as never),
        ),
    );
    expectSeedRejected(treeWith((tree) => (tree.root.nags = ["invalid"] as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.halfMoves = -1)));
    expectSeedRejected(treeWith((tree) => (tree.root.depth = -1)));
    expectSeedRejected(treeWith((tree) => (tree.headers.id = 0.5)));
    expectSeedRejected(treeWith((tree) => (tree.headers.result = "invalid" as never)));
    expectSeedRejected(treeWith((tree) => (tree.root.children = null as never)));
    expect(isBoundedTreeForStorage({ root: null })).toBe(false);

    const tooManyChildren = treeWith((tree) => {
        tree.root.children = Array(100_001).fill({ ...tree.root, children: [] });
    });
    expect(isBoundedTreeForStorage(tooManyChildren)).toBe(false);
    const tooManyNodes = treeWith((tree) => {
        tree.root.children = Array(100_000).fill({ ...tree.root, children: [] });
    });
    expect(isBoundedTreeForStorage(tooManyNodes)).toBe(false);
});

test("hydrates legacy uncompressed trees and rewrites the compressed current envelope", () => {
    const tree = defaultTree();
    sessionStorage.setItem("legacy", JSON.stringify(tree));

    expect(storage.read("legacy")?.state).toMatchObject({ root: tree.root, position: [] });
    expect(deserializeStorageValue(sessionStorage.getItem("legacy")!)).toMatchObject({
        version: 1,
        state: { root: tree.root },
    });
});

test("scrubs legacy-only fields and supplies missing versioned tree fields before rewriting", () => {
    const legacy = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    delete legacy.report;
    delete legacy.dirty;
    delete legacy.position;
    legacy.legacyBoardState = { never: "persist this" };
    legacy.boardStateMap = { legacy: [] };
    sessionStorage.setItem("legacy-scrub", JSON.stringify(legacy));

    expect(storage.read("legacy-scrub")?.state).toMatchObject({
        dirty: false,
        position: [],
        report: { inProgress: false },
    });
    expect(deserializeStorageValue(sessionStorage.getItem("legacy-scrub")!)).not.toHaveProperty(
        "state.legacyBoardState",
    );
    expect(deserializeStorageValue(sessionStorage.getItem("legacy-scrub")!)).not.toHaveProperty(
        "state.boardStateMap",
    );
});

test("legacy tree read supplies defaults for each omitted field", () => {
    const fresh = storage;
    const legacy = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    delete legacy.position;
    delete legacy.dirty;
    delete legacy.report;
    sessionStorage.setItem("fresh-legacy", JSON.stringify(legacy));

    expect(fresh.read("fresh-legacy")?.state).toMatchObject({
        position: [],
        dirty: false,
        report: { inProgress: false },
    });
});

test("tree migration preserves valid values and repairs every invalid legacy field", () => {
    expect(migrateTreeForStorage("not-a-tree")).toBe("not-a-tree");
    expect(
        migrateTreeForStorage({
            position: [0],
            dirty: true,
            report: { inProgress: true },
        }),
    ).toMatchObject({
        position: [0],
        dirty: true,
        report: { inProgress: true, operationId: null },
    });
    expect(
        migrateTreeForStorage({ position: "bad", dirty: 1, report: { inProgress: "bad" } }),
    ).toMatchObject({
        position: [],
        dirty: false,
        sourceStamp: null,
        appendAttempted: false,
        report: { inProgress: false, operationId: null },
    });
});

test("file stamp and append uncertainty survive a storage write and rehydrate", () => {
    const tree = treeWith((state) => {
        state.dirty = true;
        state.sourceStamp = "c".repeat(64);
        state.appendAttempted = true;
        state.headers.event = "Edited but not saved";
    });
    storage.write("stamped-tree", { version: TREE_STORAGE_VERSION, state: tree });
    storage.flush();

    const restored = new TabStorageRepository().read("stamped-tree")?.state;
    expect(restored).toMatchObject({
        dirty: true,
        sourceStamp: "c".repeat(64),
        appendAttempted: true,
        headers: { event: "Edited but not saved" },
    });
});

test("legacy and invalid file metadata fail closed without rejecting the tree", () => {
    const base = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    base.dirty = true;
    base.headers = { ...(base.headers as object), event: "Keep my edits" };
    delete base.sourceStamp;
    delete base.appendAttempted;
    expect(migrateTreeForStorage(base)).toMatchObject({
        dirty: true,
        sourceStamp: null,
        appendAttempted: false,
        headers: { event: "Keep my edits" },
    });

    const invalid = {
        ...base,
        sourceStamp: 42,
        appendAttempted: "unknown",
    };
    expect(migrateTreeForStorage(invalid)).toMatchObject({
        dirty: true,
        sourceStamp: null,
        appendAttempted: true,
        headers: { event: "Keep my edits" },
    });
    storage.seed("invalid-source-stamp", invalid);
    expect(storage.read("invalid-source-stamp")?.state).toMatchObject({
        dirty: true,
        sourceStamp: null,
        appendAttempted: true,
        headers: { event: "Keep my edits" },
    });
});

test.each([
    ["an array holding a stamp", ["d".repeat(64)]],
    ["a string that is not a stamp", "not-a-stamp"],
    ["a stamp with a leading character", `x${"d".repeat(64)}`],
    ["a stamp with a trailing character", `${"d".repeat(64)}x`],
    ["an upper-case stamp", "D".repeat(64)],
])("a stored source stamp that is %s hydrates as null with the tree kept", (_label, stamp) => {
    const tree = treeWith((state) => {
        state.dirty = true;
        state.headers.event = "Keep my edits";
    }) as unknown as Record<string, unknown>;
    tree.sourceStamp = stamp;
    expect(migrateTreeForStorage(tree)).toMatchObject({ sourceStamp: null, dirty: true });
    sessionStorage.setItem("malformed-stamp", JSON.stringify(tree));
    expect(storage.read("malformed-stamp")?.state).toMatchObject({
        sourceStamp: null,
        dirty: true,
        headers: { event: "Keep my edits" },
    });
});

test("report operationId survives a seed/read round trip", () => {
    const tree = treeWith((state) => {
        state.report = { inProgress: true, operationId: "report_tab_abc" };
    });
    storage.seed("report-id", tree);
    expect(storage.read("report-id")?.state).toMatchObject({
        report: { inProgress: true, operationId: "report_tab_abc" },
    });
});

test("a pre-upgrade report blob without operationId still hydrates", () => {
    const tree = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    tree.report = { inProgress: false };
    sessionStorage.setItem("pre-upgrade-report", JSON.stringify(tree));

    expect(storage.read("pre-upgrade-report")?.state).toMatchObject({
        report: { inProgress: false, operationId: null },
    });
    expect(sessionStorage.getItem("pre-upgrade-report")).not.toBeNull();
});

test("a wrong-typed report operationId hydrates as null instead of discarding the tab", () => {
    const tree = structuredClone(defaultTree()) as unknown as Record<string, unknown>;
    tree.report = { inProgress: true, operationId: 123 };
    sessionStorage.setItem("wrong-typed-report", JSON.stringify(tree));

    expect(storage.read("wrong-typed-report")?.state).toMatchObject({
        report: { inProgress: true, operationId: null },
        root: defaultTree().root,
    });
    expect(sessionStorage.getItem("wrong-typed-report")).not.toBeNull();
});

test("clone does not copy a live report operationId onto the duplicate tab", () => {
    const tree = treeWith((state) => {
        state.dirty = true;
        state.report = { inProgress: true, operationId: "report_live" };
    });
    storage.write("source-report", { version: 0, state: tree });
    storage.clone("source-report", "copy-report");
    expect(storage.getStatus("copy-report")).toEqual({ kind: "available" });

    expect(storage.read("source-report")?.state).toMatchObject({
        report: { inProgress: true, operationId: "report_live" },
    });
    expect(storage.read("copy-report")?.state).toMatchObject({
        dirty: true,
        report: { inProgress: false, operationId: null },
    });
});

test.each(["candidate", "durable"] as const)(
    "%s clone reads preserve cold legacy source bytes without a migration write",
    (route) => {
        const tree = defaultTree();
        tree.root.comment = "legacy source bytes remain owned by the source";
        const raw = JSON.stringify({ version: 0, state: tree });
        sessionStorage.setItem("cold-legacy-source", raw);
        const write = vi.spyOn(Storage.prototype, "setItem");
        let candidate: ReturnType<typeof defaultTree>;
        if (route === "candidate") {
            candidate = storage.readForClone("cold-legacy-source", true)!;
        } else {
            storage.cloneDurable("cold-legacy-source", "legacy-copy", true);
            candidate = storage.readForClone("legacy-copy")!;
        }
        expect(candidate.root).toEqual(tree.root);
        candidate.root.comment = "independent candidate";
        expect(write.mock.calls.filter(([key]) => key === "cold-legacy-source")).toEqual([]);
        expect(sessionStorage.getItem("cold-legacy-source")).toBe(raw);
        expect(storage.pendingCount()).toBe(0);
    },
);

test("clone candidate permits an absent optional source and refuses a required missing source", () => {
    expect(storage.readForClone("optional-candidate")).toBeNull();
    expect(storage.getStatus("optional-candidate")).toEqual({ kind: "absent" });
    expect(() => storage.readForClone("required-candidate", true)).toThrow(/read the source tree/);
    expect(storage.getStatus("required-candidate")).toMatchObject({ kind: "unavailable" });
    expect(storage.pendingCount()).toBe(0);
});

test.each(["unreadable", "unavailable", "missing"] as const)(
    "clone candidate keeps the source's %s recovery gate after its bytes recover",
    (failure) => {
        const source = `gated-candidate-${failure}`;
        if (failure === "unreadable") sessionStorage.setItem(source, "unreadable bytes");
        const getItem = vi.spyOn(Storage.prototype, "getItem");
        if (failure === "unavailable")
            getItem.mockImplementation(() => {
                throw new DOMException("read refused", "SecurityError");
            });
        storage.readTree(source, true);
        const gate = storage.getStatus(source);
        getItem.mockRestore();
        const raw = serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() });
        sessionStorage.setItem(source, raw);
        const message = failure === "unreadable" ? /unreadable/ : /read the source tree/;
        expect(() => storage.readForClone(source, true)).toThrow(message);
        expect(() => storage.cloneDurable(source, "gated-copy", true)).toThrow(message);
        expect(storage.getStatus(source)).toBe(gate);
        expect(sessionStorage.getItem(source)).toBe(raw);
        expect(sessionStorage.getItem("gated-copy")).toBeNull();
        expect(storage.pendingCount()).toBe(0);
    },
);

test("clone candidate validates pending actions and keeps the original edits queued", () => {
    const tree = defaultTree();
    storage.seed("candidate-source", tree);
    const raw = sessionStorage.getItem("candidate-source");
    tree.root.comment = "unflushed source edit";
    tree.report = { inProgress: true, operationId: "source-lease" };
    storage.write("candidate-source", { version: 1, state: { ...tree, action: () => undefined } });
    const candidate = storage.readForClone("candidate-source", true)!;
    expect(candidate.root.comment).toBe("unflushed source edit");
    expect(candidate.report).toEqual({ inProgress: false, operationId: null });
    candidate.root.comment = "destination only";
    expect(storage.readForClone("candidate-source")!.root.comment).toBe("unflushed source edit");
    expect(sessionStorage.getItem("candidate-source")).toBe(raw);
    expect(storage.pendingCount()).toBe(1);
});

test("cloneDurable copies pending edits immediately without flushing unrelated trees", () => {
    const source = treeWith((state) => {
        state.dirty = true;
        state.report = { inProgress: true, operationId: "live-report" };
    });
    storage.write("source", { version: 0, state: source });
    storage.write("unrelated", { version: 0, state: defaultTree() });

    storage.cloneDurable("source", "target");
    expect(sessionStorage.getItem("target")).not.toBeNull();
    expect(storage.getStatus("target")).toEqual({ kind: "available" });
    expect(sessionStorage.getItem("unrelated")).toBeNull();
    expect(storage.pendingCount()).toBe(2);
    expect(storage.read("target")?.state).toMatchObject({
        dirty: true,
        report: { inProgress: false, operationId: null },
    });
});

test("cloneDurable treats a legitimate tab without tree storage as an empty clone", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    storage.cloneDurable("blank-tab", "blank-copy");
    expect(setItem).not.toHaveBeenCalledWith("blank-copy", expect.any(String));
    expect(sessionStorage.getItem("blank-copy")).toBeNull();
    expect(storage.read("blank-copy")).toBeNull();
    expect(storage.pendingCount()).toBe(0);
    setItem.mockRestore();
});

test.each(["cold", "vanished"] as const)(
    "required clone reads refuse a %s missing physical source and block blank writes",
    (sourceState) => {
        const source = crypto.randomUUID();
        const target = crypto.randomUUID();
        let priorSourceStatus = storage.getStatus(source).kind;
        if (sourceState === "vanished") {
            storage.seed(source, defaultTree());
            priorSourceStatus = storage.readTree(source).kind;
            sessionStorage.removeItem(source);
        }
        expect(priorSourceStatus).toBe(sourceState === "vanished" ? "available" : "not-read");
        expect(storage.clone(source, target, true)).toMatchObject({ kind: "unavailable" });
        expect(storage.getStatus(source)).toMatchObject({ kind: "unavailable" });
        storage.write(source, { version: TREE_STORAGE_VERSION, state: defaultTree() });
        expect(() => storage.cloneDurable(source, target, true)).toThrow(/read the source tree/);
        expect(storage.pendingCount()).toBe(0);
        expect(sessionStorage.getItem(source)).toBeNull();
        expect(sessionStorage.getItem(target)).toBeNull();
    },
);

test.each(["readable", "pending"] as const)(
    "required cloning preserves an authoritative %s physical source",
    (sourceState) => {
        const source = crypto.randomUUID();
        const queuedTarget = crypto.randomUUID();
        const durableTarget = crypto.randomUUID();
        const tree = treeWith((state) => {
            state.headers.event = "Original physical tree";
        });
        storage.seed(source, tree);
        const bytes = sessionStorage.getItem(source);
        if (sourceState === "pending") {
            tree.headers.event = "Authoritative pending tree";
            storage.write(source, { version: TREE_STORAGE_VERSION, state: tree });
        }
        expect(storage.clone(source, queuedTarget, true)).toEqual({ kind: "copied" });
        storage.cloneDurable(source, durableTarget, true);
        for (const key of [source, queuedTarget, durableTarget]) {
            expect(
                storage.read<ReturnType<typeof defaultTree>>(key, true)?.state.headers.event,
            ).toBe(tree.headers.event);
        }
        expect(sessionStorage.getItem(source)).toBe(bytes);
        expect(sessionStorage.getItem(durableTarget)).not.toBeNull();
    },
);

test("cloneDurable preserves a required missing-reference gate without publishing absence", () => {
    const source = crypto.randomUUID();
    storage.storageFor(true).getItem(source);
    const status = storage.getStatus(source);
    const changed = vi.fn();
    const stop = storage.subscribeStatus(source, changed);
    expect(() => storage.cloneDurable(source, "copy")).toThrow(/read the source tree/);
    expect(storage.getStatus(source)).toBe(status);
    expect(changed).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(source)).toBeNull();
    expect(sessionStorage.getItem("copy")).toBeNull();
    stop();
});

test("cloneDurable does not retry failed source hydration when the underlying read recovers", () => {
    storage.seed("source", defaultTree());
    const bytes = sessionStorage.getItem("source");
    const refusal = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
        throw new DOMException("read refused", "SecurityError");
    });
    expect(storage.read("source")).toBeNull();
    refusal.mockRestore();
    const status = storage.getStatus("source");
    const reads = vi.spyOn(Storage.prototype, "getItem");
    expect(() => storage.cloneDurable("source", "copy")).toThrow(/read the source tree/);
    expect(reads).not.toHaveBeenCalled();
    expect(storage.getStatus("source")).toBe(status);
    expect(sessionStorage.getItem("source")).toBe(bytes);
    expect(sessionStorage.getItem("copy")).toBeNull();
    expect(storage.pendingCount()).toBe(0);
});

test("cloneDurable refuses to duplicate an unreadable source as a clean tab", () => {
    const raw = "unreadable source tree";
    sessionStorage.setItem("source", raw);

    expect(() => storage.cloneDurable("source", "target")).toThrow(/unreadable/);

    expect(storage.getStatus("source")).toEqual({ kind: "unreadable", rawValue: raw });
    expect(sessionStorage.getItem("source")).toBe(raw);
    expect(sessionStorage.getItem("target")).toBeNull();
});

test("cloneDurable refuses to duplicate a source whose storage read is unavailable", () => {
    const stored = serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() });
    sessionStorage.setItem("source", stored);
    const failure = new DOMException("source read refused", "SecurityError");
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === "source") throw failure;
            return originalGetItem.call(this, key);
        });

    let cloneError: unknown;
    try {
        storage.cloneDurable("source", "target");
    } catch (error) {
        cloneError = error;
    }

    getItem.mockRestore();
    expect(cloneError).toMatchObject({
        message: "Could not read the source tree for duplication.",
        cause: failure,
    });
    expect(storage.getStatus("source")).toEqual({ kind: "unavailable", error: failure });
    expect(sessionStorage.getItem("source")).toBe(stored);
    expect(sessionStorage.getItem("target")).toBeNull();
});

test("cloneDurable rejects a pending source that fails storage validation", () => {
    storage.write("invalid-pending-source", { version: 0, state: { invalid: true } });

    expect(() => storage.cloneDurable("invalid-pending-source", "target")).toThrow(
        /validate the source tree/,
    );

    expect(sessionStorage.getItem("target")).toBeNull();
    expect(storage.pendingCount()).toBe(1);
});

test("cloning a legacy ID that belongs to another store preserves that store", () => {
    const databaseView = JSON.stringify({
        state: { database: { activeTab: "games" } },
        version: 0,
    });
    sessionStorage.setItem("database-view", databaseView);

    storage.clone("database-view", "ordinary-copy");
    storage.cloneDurable("database-view", "durable-copy");

    expect(sessionStorage.getItem("database-view")).toBe(databaseView);
    expect(sessionStorage.getItem("ordinary-copy")).toBeNull();
    expect(sessionStorage.getItem("durable-copy")).toBeNull();
    expect(storage.pendingCount()).toBe(0);
});

test("reading and writing reserved session keys never admits them as tab trees", () => {
    const reservedValues = new Map([
        [
            "workspace",
            serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() }),
        ],
        ["tabs", JSON.stringify([{ value: "other-tab" }])],
        ["activeTab", JSON.stringify("other-tab")],
        ["database-view", JSON.stringify({ activeTab: "games" })],
        ["expanded-directories", JSON.stringify({ expanded: ["/games"] })],
    ]);

    for (const [key, raw] of reservedValues) {
        sessionStorage.setItem(key, raw);
        expect(storage.readTree(key)).toEqual({ kind: "absent" });
        expect(storage.getStatus(key)).toEqual({ kind: "absent" });

        storage.write(key, { version: TREE_STORAGE_VERSION, state: defaultTree() });

        expect(storage.pendingCount()).toBe(0);
        expect(sessionStorage.getItem(key)).toBe(raw);

        let seedError: unknown;
        try {
            storage.seed(key, defaultTree());
        } catch (error) {
            seedError = error;
        }
        expect(seedError).toBeInstanceOf(Error);
        const blockedSeedError = seedError as Error & { cause?: unknown };
        expect(blockedSeedError.message).toBe(
            "Cannot replace a tab tree while its storage is unreadable or unavailable.",
        );
        expect(blockedSeedError.cause).toBeInstanceOf(Error);
        expect((blockedSeedError.cause as Error).message).toBe(
            "The key belongs to another session store.",
        );
        expect(sessionStorage.getItem(key)).toBe(raw);
    }
});

test("clone reports validation and destination failures without replacing either tree", () => {
    storage.write("invalid-clone-source", {
        version: TREE_STORAGE_VERSION,
        state: { invalid: true },
    });

    const invalidCopy = storage.clone("invalid-clone-source", "invalid-clone-target");
    expect(invalidCopy).toMatchObject({
        kind: "copy-failed",
        error: { message: "Could not validate the source tree." },
    });
    expect(storage.pendingCount()).toBe(1);
    expect(sessionStorage.getItem("invalid-clone-target")).toBeNull();

    for (const kind of ["unreadable", "unavailable"] as const) {
        const targetId = `clone-${kind}-target`;
        const targetRaw =
            kind === "unreadable"
                ? "target bytes cannot be decoded"
                : serializeStorageValue({
                      version: TREE_STORAGE_VERSION,
                      state: defaultTree(),
                  });
        const failure = new DOMException("target read refused", "SecurityError");
        storage.seed(`clone-${kind}-source`, defaultTree());
        sessionStorage.setItem(targetId, targetRaw);
        const originalGetItem = Storage.prototype.getItem;
        const getItem =
            kind === "unavailable"
                ? vi
                      .spyOn(Storage.prototype, "getItem")
                      .mockImplementation(function (this: Storage, key) {
                          if (key === targetId) throw failure;
                          return originalGetItem.call(this, key);
                      })
                : null;

        const result = storage.clone(`clone-${kind}-source`, targetId);

        getItem?.mockRestore();
        expect(result.kind).toBe("copy-failed");
        const errorMatches =
            result.kind === "copy-failed" &&
            (kind === "unavailable"
                ? result.error === failure
                : result.error instanceof Error &&
                  result.error.message === "The destination tree key cannot be replaced.");
        expect(errorMatches).toBe(true);
        expect(sessionStorage.getItem(targetId)).toBe(targetRaw);
    }
});

test("legacy tab cloning preserves every reserved non-tree session key", () => {
    const reservedValues = new Map([
        ["workspace", JSON.stringify({ version: 1, tabs: [] })],
        ["tabs", JSON.stringify([{ name: "Other tab" }])],
        ["activeTab", JSON.stringify("other-tab")],
        ["expanded-directories", JSON.stringify({ expanded: ["/games"] })],
    ]);
    for (const [key, value] of reservedValues) {
        sessionStorage.setItem(key, value);
        storage.clone(key, `clone-${key}`);
        expect(sessionStorage.getItem(key)).toBe(value);
        expect(sessionStorage.getItem(`clone-${key}`)).toBeNull();
    }
});

test("cloneDurable propagates a normalized target write failure without changing its source", () => {
    const source = treeWith((state) => {
        state.dirty = true;
        state.headers.event = "Latest pending source";
    });
    storage.write("source", { version: 0, state: source });
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === "target") throw new DOMException("quota", "QuotaExceededError");
            return originalSetItem.call(this, key, value);
        });

    expect(() => storage.cloneDurable("source", "target")).toThrow(
        "Could not open the game: the browser's session storage is full.",
    );
    expect(sessionStorage.getItem("target")).toBeNull();
    expect(storage.read<ReturnType<typeof defaultTree>>("source")?.state).toMatchObject({
        dirty: true,
        headers: { event: "Latest pending source" },
    });
    expect(storage.pendingCount()).toBe(1);
    setItem.mockRestore();
});

test.each(["unreadable", "unavailable"] as const)(
    "cloneDurable preserves an %s target instead of replacing it",
    (kind) => {
        const source = serializeStorageValue({
            version: TREE_STORAGE_VERSION,
            state: defaultTree(),
        });
        const target =
            kind === "unreadable"
                ? "target bytes cannot be decoded"
                : serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() });
        sessionStorage.setItem("source", source);
        sessionStorage.setItem("target", target);
        const failure = new DOMException("target read refused", "SecurityError");
        const originalGetItem = Storage.prototype.getItem;
        const getItem =
            kind === "unavailable"
                ? vi
                      .spyOn(Storage.prototype, "getItem")
                      .mockImplementation(function (this: Storage, key) {
                          if (key === "target") throw failure;
                          return originalGetItem.call(this, key);
                      })
                : null;

        let cloneError: unknown;
        try {
            storage.cloneDurable("source", "target");
        } catch (error) {
            cloneError = error;
        }
        expect(cloneError).toBeInstanceOf(Error);
        const blockedCloneError = cloneError as Error & { cause?: unknown };
        expect(blockedCloneError.message).toBe(
            "Cannot replace a tab tree while its storage is unreadable or unavailable.",
        );
        expect(blockedCloneError.cause).toEqual(
            kind === "unavailable" ? failure : { kind: "unreadable", rawValue: target },
        );

        getItem?.mockRestore();
        expect(storage.read("source")?.state).toMatchObject({ root: defaultTree().root });
        expect(sessionStorage.getItem("target")).toBe(target);
    },
);

test.each(["unreadable", "unavailable"] as const)(
    "seed preserves an %s destination instead of replacing it",
    (kind) => {
        const target =
            kind === "unreadable"
                ? "target bytes cannot be decoded"
                : serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() });
        sessionStorage.setItem("target", target);
        const failure = new DOMException("target read refused", "SecurityError");
        const originalGetItem = Storage.prototype.getItem;
        const getItem =
            kind === "unavailable"
                ? vi
                      .spyOn(Storage.prototype, "getItem")
                      .mockImplementation(function (this: Storage, key) {
                          if (key === "target") throw failure;
                          return originalGetItem.call(this, key);
                      })
                : null;

        let seedError: unknown;
        try {
            storage.seed("target", defaultTree());
        } catch (error) {
            seedError = error;
        }
        expect(seedError).toBeInstanceOf(Error);
        const blockedSeedError = seedError as Error & { cause?: unknown };
        expect(blockedSeedError.message).toBe(
            "Cannot replace a tab tree while its storage is unreadable or unavailable.",
        );
        expect(blockedSeedError.cause).toEqual(
            kind === "unavailable" ? failure : { kind: "unreadable", rawValue: target },
        );

        getItem?.mockRestore();
        expect(sessionStorage.getItem("target")).toBe(target);
    },
);

test("clone of a pending write carrying store actions succeeds without inheriting the report lease", () => {
    const tree = treeWith((state) => {
        state.dirty = true;
        state.report = { inProgress: true, operationId: "report_live" };
    });
    storage.write("pending-actions", {
        version: 0,
        state: {
            ...tree,
            setReportOperationId: () => undefined,
            setReportInProgress: () => undefined,
        },
    });

    expect(() => structuredClone(storage.read("pending-actions"))).toThrow(/could not be cloned/);
    expect(() => storage.clone("pending-actions", "copy-pending-actions")).not.toThrow();

    expect(storage.read("pending-actions")?.state).toMatchObject({
        report: { inProgress: true, operationId: "report_live" },
    });
    expect(storage.read("copy-pending-actions")?.state).toMatchObject({
        dirty: true,
        report: { inProgress: false, operationId: null },
    });
    expect(storage.read("copy-pending-actions")?.state).not.toHaveProperty("setReportOperationId");
});

test("preserves undecodable tree bytes and exposes them for recovery", () => {
    sessionStorage.setItem("broken", "not a tree");

    expect(storage.read("broken")).toBeNull();
    expect(sessionStorage.getItem("broken")).toBe("not a tree");
    expect(storage.getStatus("broken")).toEqual({ kind: "unreadable", rawValue: "not a tree" });
    expect(storage.readRawValueForRecovery("broken")).toBe("not a tree");
    expect(decodeLegacyOrCompressed("not a tree")).toBeNull();
});

test("raw recovery requires a value already known to be unreadable", () => {
    expect(() => storage.readRawValueForRecovery("not-read")).toThrow(/no readable undecodable/);
    storage.readTree("absent");
    expect(() => storage.readRawValueForRecovery("absent")).toThrow(/no readable undecodable/);

    const failure = new DOMException("storage refused the read", "SecurityError");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
        if (key === "unavailable") throw failure;
        return null;
    });
    storage.readTree("unavailable");
    expect(() => storage.readRawValueForRecovery("unavailable")).toThrow(/no readable undecodable/);
    getItem.mockRestore();
});

test("unreadable workspace copies refuse occupied and reserved session keys", () => {
    const raw = "bytes preserved for workspace repair";
    const occupied = "an unrelated value";
    const workspaceMetadata = JSON.stringify({ version: 1, tabs: [] });
    sessionStorage.setItem("occupied-target", occupied);
    sessionStorage.setItem("workspace", workspaceMetadata);

    let occupiedError: unknown;
    try {
        storage.copyUnreadableForWorkspaceRepair("occupied-target", raw);
    } catch (error) {
        occupiedError = error;
    }
    expect(occupiedError).toBeInstanceOf(Error);
    expect((occupiedError as Error).message).toBe("The destination tree key is already in use.");
    expect(() => storage.copyUnreadableForWorkspaceRepair("workspace", raw)).toThrow(
        /another session store/,
    );

    expect(sessionStorage.getItem("occupied-target")).toBe(occupied);
    expect(sessionStorage.getItem("workspace")).toBe(workspaceMetadata);
});

test("unreadable workspace copies preserve unavailable destinations", () => {
    const targetId = "unavailable-copy-target";
    const original = serializeStorageValue({
        version: TREE_STORAGE_VERSION,
        state: defaultTree(),
    });
    const failure = new DOMException("target read refused", "SecurityError");
    sessionStorage.setItem(targetId, original);
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === targetId) throw failure;
            return originalGetItem.call(this, key);
        });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    let copyError: unknown;
    try {
        storage.copyUnreadableForWorkspaceRepair(targetId, "recovery bytes");
    } catch (error) {
        copyError = error;
    }
    expect(copyError).toBe(failure);

    getItem.mockRestore();
    setItem.mockRestore();
    expect(storage.getStatus(targetId)).toEqual({ kind: "unavailable", error: failure });
    expect(sessionStorage.getItem(targetId)).toBe(original);
    expect(setItem).not.toHaveBeenCalledWith(targetId, "recovery bytes");
});

test("unreadable workspace copies write and verify exact bytes to an empty key", () => {
    const targetId = "exact-copy-target";
    const raw = "\u0000unreadable bytes, preserved exactly\n";

    storage.copyUnreadableForWorkspaceRepair(targetId, raw);

    expect(sessionStorage.getItem(targetId)).toBe(raw);
    expect(storage.getStatus(targetId)).toEqual({ kind: "unreadable", rawValue: raw });
});

test("orphan cleanup never removes reserved metadata even when it resembles a tree", () => {
    const treeShapedMetadata = serializeStorageValue({
        version: TREE_STORAGE_VERSION,
        state: defaultTree(),
    });
    sessionStorage.setItem("workspace", treeShapedMetadata);

    storage.removeOrphanedTrees(new Set());

    expect(sessionStorage.getItem("workspace")).toBe(treeShapedMetadata);
});

test("unreadable workspace copy preserves replacement bytes when exact-byte readback fails", () => {
    const targetId = "copy-target";
    const raw = "bytes preserved for workspace repair";
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    let targetWritten = false;
    let replacedTarget = false;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            originalSetItem.call(this, key, value);
            if (key === targetId) targetWritten = true;
        });
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === targetId && targetWritten && !replacedTarget) {
                replacedTarget = true;
                originalSetItem.call(this, key, "replacement bytes from another writer");
            }
            return originalGetItem.call(this, key);
        });

    expect(() => storage.copyUnreadableForWorkspaceRepair(targetId, raw)).toThrow(/verify/);

    getItem.mockRestore();
    setItem.mockRestore();
    expect(sessionStorage.getItem(targetId)).toBe("replacement bytes from another writer");
    expect(storage.getStatus(targetId).kind).toBe("unavailable");
});

test("rejects excessive recursive nesting before schema hydration", () => {
    const tree = defaultTree();
    let root = tree.root;
    for (let index = 0; index < 513; index++) root = { ...root, children: [root] };
    tree.root = root;
    sessionStorage.setItem("too-deep", JSON.stringify(tree));

    expect(storage.read("too-deep")).toBeNull();
    expect(sessionStorage.getItem("too-deep")).toBe(JSON.stringify(tree));
    expect(storage.getStatus("too-deep").kind).toBe("unreadable");
});

test("accepts the maximum recursive depth and rejects its first overflow", () => {
    const tree = defaultTree();
    let root = tree.root;
    for (let index = 0; index < 512; index++) root = { ...root, children: [root] };
    tree.root = root;
    storage.seed("depth-boundary", tree);
    expect(storage.read("depth-boundary")).not.toBeNull();
});

test("accepts exactly the maximum tree-node count", () => {
    const tree = defaultTree();
    tree.root.children = Array(99_999).fill({ ...tree.root, children: [] });
    expect(isBoundedTreeForStorage(tree)).toBe(true);
});

test("an immediate clone reads the pending tree and close cancels both pending and persisted data", () => {
    const tree = defaultTree();
    tree.dirty = true;
    storage.write("source", { version: 0, state: tree });
    storage.clone("source", "copy");

    expect(storage.read("copy")?.state).toMatchObject({ dirty: true, root: tree.root });
    storage.remove("source");
    expect(storage.pendingCount()).toBe(1);
    vi.advanceTimersByTime(300);

    expect(sessionStorage.getItem("source")).toBeNull();
    expect(storage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem("copy")).not.toBeNull();
    storage.remove("copy");
    expect(storage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem("copy")).toBeNull();
});

test("storage adapter delegates all operations and seed reports invalid/quota writes", async () => {
    const adapter = storage.storageFor<ReturnType<typeof defaultTree>>();
    const tree = defaultTree();
    adapter.setItem("adapter", { version: 0, state: tree });
    expect((await adapter.getItem("adapter"))?.state).toMatchObject({ root: tree.root });
    adapter.removeItem("adapter");
    expect(storage.read("adapter")).toBeNull();

    expect(() => storage.seed("bad", { nope: true })).toThrow(
        "Cannot persist an invalid game tree.",
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    let quotaError: unknown;
    try {
        storage.seed("quota", defaultTree());
    } catch (error) {
        quotaError = error;
    }
    expect(quotaError).toMatchObject({
        message: expect.stringContaining("session storage is full"),
        cause: expect.any(DOMException),
    });
    setItem.mockRestore();

    const securityError = new DOMException("denied", "SecurityError");
    const securitySetItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw securityError;
    });
    expect(() => storage.seed("security", defaultTree())).toThrow(securityError);
    securitySetItem.mockRestore();
});

test("rewrite and deferred flush retain recoverable state when storage temporarily rejects writes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    sessionStorage.setItem("rewrite-failure", JSON.stringify(defaultTree()));
    setItem.mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    expect(storage.read("rewrite-failure")?.state).toMatchObject({ root: defaultTree().root });
    expect(native.warn).toHaveBeenCalledWith(expect.stringContaining("migrate tree storage"));

    storage.write("flush-failure", { version: 0, state: defaultTree() });
    setItem.mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    expect(storage.flush()).toEqual(["flush-failure"]);
    expect(storage.pendingCount()).toBe(1);
    expect(native.warn).toHaveBeenCalledWith(expect.stringContaining("persist tree storage"));
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect(storage.flush()).toEqual([]);
    expect(storage.pendingCount()).toBe(0);
    expect(storage.read("flush-failure")).not.toBeNull();
});

test("migration rewrite failures fall back to console when native logging rejects", async () => {
    const raw = JSON.stringify(defaultTree());
    sessionStorage.setItem("rewrite-log-failure", raw);
    const logError = new Error("log IPC failed");
    native.warn.mockRejectedValueOnce(logError);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });

    try {
        expect(storage.read("rewrite-log-failure")?.state).toMatchObject({
            root: defaultTree().root,
        });
        expect(sessionStorage.getItem("rewrite-log-failure")).toBe(raw);
        expect(native.warn).toHaveBeenCalledOnce();
        expect(native.warn).toHaveBeenCalledWith(expect.stringContaining("migrate tree storage"));

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleWarn).toHaveBeenCalledOnce();
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("migrate tree storage"), {
            loggerFailure: expect.anything(),
        });
        expect(persistError.reportPersistError).not.toHaveBeenCalled();
    } finally {
        setItem.mockRestore();
        consoleWarn.mockRestore();
    }
});

test.each([42, null, undefined])(
    "wraps a non-Error storage failure with its original cause: %s",
    (cause) => {
        const reported = persistStorageWriteError(cause);

        expect(reported.message).toBe(
            "Could not save this game. Session storage rejected the write.",
        );
        expect(reported.cause).toBe(cause);
    },
);

test("recognizes a plain quota-shaped failure and retains its cause", () => {
    const cause = { name: "QuotaExceededError" };

    expect(persistStorageWriteError(cause)).toMatchObject({
        message:
            "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
        cause,
    });
});

test("returns a non-quota Error as-is", () => {
    const cause = new Error("disk went away");
    expect(persistStorageWriteError(cause)).toBe(cause);
});

test("live debounce reports a non-quota write failure without the session-full message", () => {
    const securityError = new DOMException("denied", "SecurityError");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw securityError;
    });

    storage.write("security-failure", { version: 0, state: defaultTree() });
    vi.advanceTimersByTime(300);

    const reported = persistError.reportPersistError.mock.calls[0][0] as Error;
    expect(reported.message).not.toContain("session storage is full");
    expect(reported).toBe(securityError);
    setItem.mockRestore();
});

test("live debounce reports quota failure with the seed error and retains pending state", () => {
    const quotaError = new DOMException("quota", "QuotaExceededError");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw quotaError;
    });

    storage.write("live-failure", { version: 0, state: defaultTree() });
    vi.advanceTimersByTime(300);

    expect(storage.pendingCount()).toBe(1);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({
            message:
                "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
            cause: quotaError,
        }),
    );
    setItem.mockRestore();
});

test("lifecycle flush failures warn and retain pending state without notifying", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    storage.write("quit-failure", { version: 0, state: defaultTree() });

    expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow();
    expect(() => window.dispatchEvent(new Event("beforeunload"))).not.toThrow();

    expect(storage.pendingCount()).toBe(1);
    expect(native.warn).toHaveBeenCalledWith(expect.stringContaining("persist tree storage"));
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    setItem.mockRestore();
});

test("flush failures fall back to console when native logging rejects", async () => {
    const logError = new Error("log IPC failed");
    native.warn.mockRejectedValueOnce(logError);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });
    storage.write("quit-log-failure", { version: 0, state: defaultTree() });

    try {
        expect(storage.flush()).toEqual(["quit-log-failure"]);
        expect(storage.pendingCount()).toBe(1);
        expect(native.warn).toHaveBeenCalledOnce();
        expect(native.warn).toHaveBeenCalledWith(expect.stringContaining("persist tree storage"));

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleWarn).toHaveBeenCalledOnce();
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("persist tree storage"), {
            loggerFailure: expect.anything(),
        });
        expect(persistError.reportPersistError).not.toHaveBeenCalled();
    } finally {
        setItem.mockRestore();
        consoleWarn.mockRestore();
    }
});

test("notified flush reports the first write failure once when several keys fail", () => {
    storage.write("first", { version: 0, state: defaultTree() });
    storage.write("second", { version: 0, state: defaultTree() });
    const firstError = new DOMException("denied", "SecurityError");
    const secondError = new DOMException("quota", "QuotaExceededError");
    const errors = [firstError, secondError];
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw errors.shift() ?? secondError;
    });

    expect(storage.flush({ notify: true })).toEqual(["first", "second"]);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(firstError);
    setItem.mockRestore();
});

test("flush continues after one failed key and persists the remaining key", () => {
    storage.write("first", { version: 0, state: defaultTree() });
    storage.write("second", { version: 0, state: defaultTree() });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });

    expect(storage.flush()).toEqual(["first"]);

    expect(storage.pendingCount()).toBe(1);
    expect(storage.read("first")).not.toBeNull();
    expect(sessionStorage.getItem("first")).toBeNull();
    expect(sessionStorage.getItem("second")).not.toBeNull();
    setItem.mockRestore();
});

test("scheduled lifecycle events flush once and a missing clone source stays absent", () => {
    expect(storage.clone("missing", "target")).toEqual({ kind: "absent" });
    expect(storage.getStatus("missing")).toEqual({ kind: "absent" });
    expect(storage.getStatus("target")).toEqual({ kind: "not-read" });
    expect(storage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem("target")).toBeNull();
    expect(storage.read("target")).toBeNull();
    storage.write("event-flush", { version: 0, state: defaultTree() });
    window.dispatchEvent(new Event("pagehide"));
    expect(storage.pendingCount()).toBe(0);
    expect(storage.read("event-flush")).not.toBeNull();
    window.dispatchEvent(new Event("beforeunload"));
});

test("debounce scheduling replaces exactly one timer and installs one pair of lifecycle handlers", () => {
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const addEventListener = vi.spyOn(window, "addEventListener");

    storage.write("first", { version: 0, state: defaultTree() });
    storage.write("second", { version: 0, state: defaultTree() });

    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(addEventListener).toHaveBeenNthCalledWith(1, "beforeunload", expect.any(Function));
    expect(addEventListener).toHaveBeenNthCalledWith(2, "pagehide", expect.any(Function));

    storage.flush();
    expect(clearTimeout).toHaveBeenCalledTimes(2);
    clearTimeout.mockRestore();
    addEventListener.mockRestore();
});

function withTabStorageTracker(
    mode: string,
    tracker: ((repository: TabStorageRepository) => void) | undefined,
    run: () => void,
) {
    const key = "__chessfableTrackTabStorage";
    const originalTracker = Object.getOwnPropertyDescriptor(globalThis, key);
    try {
        // Vitest's meta-env transform reads the same worker environment as stubEnv.
        vi.stubEnv("MODE", mode);
        if (tracker) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value: tracker,
            });
        } else {
            Reflect.deleteProperty(globalThis, key);
        }
        run();
    } finally {
        try {
            // These boundary cases deliberately bypass shared fixture registration.
            storage.flush();
        } finally {
            if (originalTracker) Object.defineProperty(globalThis, key, originalTracker);
            else Reflect.deleteProperty(globalThis, key);
            vi.unstubAllEnvs();
        }
    }
}

test("non-test writes bypass a present test cleanup tracker and still flush", () => {
    const tracker = vi.fn();
    const tree = treeWith((state) => {
        state.headers.event = "Production write";
    });
    withTabStorageTracker("production", tracker, () => {
        expect(import.meta.env.MODE).toBe("production");
        storage.write("production-write", { version: TREE_STORAGE_VERSION, state: tree });
        expect(storage.pendingCount()).toBe(1);
        expect(tracker).not.toHaveBeenCalled();
        expect(storage.flush()).toEqual([]);
        expect(storage.pendingCount()).toBe(0);
        expect(deserializeStorageValue(sessionStorage.getItem("production-write")!)).toEqual({
            version: TREE_STORAGE_VERSION,
            state: tree,
        });
    });
});

test("test-mode writes tolerate an absent cleanup tracker and still flush", () => {
    const tree = treeWith((state) => {
        state.headers.event = "Unregistered test write";
    });
    withTabStorageTracker("test", undefined, () => {
        expect(import.meta.env.MODE).toBe("test");
        expect(() =>
            storage.write("unregistered-write", {
                version: TREE_STORAGE_VERSION,
                state: tree,
            }),
        ).not.toThrow();
        expect(storage.pendingCount()).toBe(1);
        expect(storage.flush()).toEqual([]);
        expect(storage.pendingCount()).toBe(0);
        expect(deserializeStorageValue(sessionStorage.getItem("unregistered-write")!)).toEqual({
            version: TREE_STORAGE_VERSION,
            state: tree,
        });
    });
});

test("flush does not clear a timer when none is pending", () => {
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    storage.flush();
    expect(clearTimeout).not.toHaveBeenCalled();
    clearTimeout.mockRestore();
});

test("current envelopes do not rewrite, while empty raw keys stay untouched", () => {
    storage.seed("current", defaultTree());
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    expect(storage.read("current")).not.toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    sessionStorage.setItem("empty", "");
    expect(storage.read("empty")).toBeNull();
    expect(storage.getStatus("empty")).toEqual({ kind: "unreadable", rawValue: "" });
    expect(storage.readRawValueForRecovery("empty")).toBe("");
    expect(sessionStorage.getItem("empty")).toBe("");
    setItem.mockRestore();
});

test("read refusal stays unavailable and a successful retry can load the exact key", () => {
    const id = "temporarily-unavailable";
    const stored = serializeStorageValue({
        version: TREE_STORAGE_VERSION,
        state: treeWith((tree) => {
            tree.headers.event = "Recovered after retry";
        }),
    });
    sessionStorage.setItem(id, stored);
    const failure = new DOMException("storage refused the read", "SecurityError");
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === id) throw failure;
            return originalGetItem.call(this, key);
        });

    expect(storage.read(id)).toBeNull();
    expect(storage.getStatus(id)).toEqual({ kind: "unavailable", error: failure });
    storage.write(id, { version: TREE_STORAGE_VERSION, state: defaultTree() });
    storage.flush();
    expect(storage.pendingCount()).toBe(0);

    getItem.mockRestore();
    expect(storage.readTree(id)).toMatchObject({
        kind: "available",
        value: { state: { headers: { event: "Recovered after retry" } } },
    });
    expect(storage.getStatus(id)).toEqual({ kind: "available" });
    expect(storage.read(id)?.state).toMatchObject({
        headers: { event: "Recovered after retry" },
    });
});

test("a failed retry remains unavailable and does not authorize a default write", () => {
    const id = "retry-still-refused";
    const failure = new DOMException("storage refused the read", "SecurityError");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
        if (key === id) throw failure;
        return null;
    });

    expect(storage.read(id)).toBeNull();
    expect(storage.readTree(id)).toEqual({ kind: "unavailable", error: failure });
    storage.write(id, { version: TREE_STORAGE_VERSION, state: defaultTree() });
    storage.flush();

    expect(storage.getStatus(id)).toEqual({ kind: "unavailable", error: failure });
    expect(storage.pendingCount()).toBe(0);
    expect(getItem).toHaveBeenCalledWith(id);
    getItem.mockRestore();
});

test("status subscriptions notify only on state changes and clean up safely", () => {
    const id = "status-subscriptions";
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = storage.subscribeStatus(id, first);
    const stopSecond = storage.subscribeStatus(id, second);
    const internals = storage as unknown as {
        readStatuses: Map<string, unknown>;
        statusListeners: Map<string, Set<() => void>>;
    };

    expect(storage.getStatus(id)).toEqual({ kind: "not-read" });
    expect(storage.readTree(id)).toEqual({ kind: "absent" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    storage.readTree(id);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    storage.seed(id, defaultTree());
    expect(storage.getStatus(id)).toEqual({ kind: "available" });
    storage.readTree(id);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    sessionStorage.setItem(id, "unreadable A");
    storage.readTree(id);
    storage.readTree(id);
    expect(storage.getStatus(id)).toEqual({ kind: "unreadable", rawValue: "unreadable A" });
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);
    sessionStorage.setItem(id, "unreadable B");
    storage.readTree(id);
    expect(first).toHaveBeenCalledTimes(4);
    expect(second).toHaveBeenCalledTimes(4);

    const firstFailure = new DOMException("read refused", "SecurityError");
    const secondFailure = new DOMException("read refused", "SecurityError");
    let readFailure = firstFailure;
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === id) throw readFailure;
            return originalGetItem.call(this, key);
        });
    storage.readTree(id);
    storage.readTree(id);
    expect(storage.getStatus(id)).toEqual({ kind: "unavailable", error: firstFailure });
    expect(first).toHaveBeenCalledTimes(5);
    expect(second).toHaveBeenCalledTimes(5);
    readFailure = secondFailure;
    storage.readTree(id);
    expect(storage.getStatus(id)).toEqual({ kind: "unavailable", error: secondFailure });
    expect(first).toHaveBeenCalledTimes(6);
    expect(second).toHaveBeenCalledTimes(6);
    getItem.mockRestore();

    sessionStorage.setItem(
        id,
        serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() }),
    );
    storage.readTree(id);
    expect(storage.getStatus(id)).toEqual({ kind: "available" });
    expect(first).toHaveBeenCalledTimes(7);
    expect(second).toHaveBeenCalledTimes(7);

    stopFirst();
    sessionStorage.setItem(id, "unreadable C");
    storage.readTree(id);
    expect(first).toHaveBeenCalledTimes(7);
    expect(second).toHaveBeenCalledTimes(8);
    stopSecond();
    expect(internals.statusListeners.has(id)).toBe(false);

    // An old unsubscribe must not remove a later listener set for the same tab.
    stopFirst();
    const later = vi.fn();
    const stopLater = storage.subscribeStatus(id, later);
    stopFirst();
    expect(internals.statusListeners.has(id)).toBe(true);
    sessionStorage.setItem(id, "unreadable D");
    storage.readTree(id);
    expect(later).toHaveBeenCalledOnce();

    storage.remove(id);
    expect(storage.getStatus(id)).toEqual({ kind: "not-read" });
    expect(internals.readStatuses.has(id)).toBe(false);
    stopLater();
    expect(internals.statusListeners.has(id)).toBe(false);
});

test("a first write is blocked by undecodable bytes already at its destination", () => {
    const id = "write-over-unreadable";
    const raw = "preserve before explicit recovery";
    sessionStorage.setItem(id, raw);

    storage.write(id, { version: TREE_STORAGE_VERSION, state: defaultTree() });

    expect(storage.getStatus(id)).toEqual({ kind: "unreadable", rawValue: raw });
    expect(storage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem(id)).toBe(raw);
});

test("a write to a known available tree does not probe storage again", () => {
    const id = "write-known-available";
    storage.seed(id, defaultTree());
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    storage.write(id, { version: TREE_STORAGE_VERSION, state: defaultTree() });

    expect(getItem).not.toHaveBeenCalled();
    expect(storage.pendingCount()).toBe(1);
    getItem.mockRestore();
});

test("pending edits remain authoritative without consulting refused storage", () => {
    const tree = treeWith((state) => {
        state.dirty = true;
        state.headers.event = "Latest pending edit";
    });
    storage.write("pending-authoritative", {
        version: TREE_STORAGE_VERSION,
        state: tree,
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("storage refused the read", "SecurityError");
    });

    expect(storage.read("pending-authoritative")?.state).toMatchObject({
        dirty: true,
        headers: { event: "Latest pending edit" },
    });
    expect(getItem).not.toHaveBeenCalled();
    expect(storage.getStatus("pending-authoritative")).toEqual({ kind: "available" });
    getItem.mockRestore();
});

test("failed discard retains the unreadable gate and reports its storage error", () => {
    sessionStorage.setItem("discard-refused", "corrupt bytes");
    storage.read("discard-refused");
    const failure = new DOMException("storage refused removal", "SecurityError");
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === "discard-refused") throw failure;
            return Storage.prototype.removeItem.call(this, key);
        });

    expect(() => storage.discardUnreadable("discard-refused")).toThrow(failure);
    expect(storage.getStatus("discard-refused")).toEqual({
        kind: "unreadable",
        rawValue: "corrupt bytes",
    });
    expect(sessionStorage.getItem("discard-refused")).toBe("corrupt bytes");
    expect(persistError.reportPersistError).toHaveBeenCalledWith(failure);
    removeItem.mockRestore();
});

test("successful discard clears only a readable unreadable gate", () => {
    sessionStorage.setItem("discard-success", "corrupt bytes");
    storage.read("discard-success");

    expect(storage.discardUnreadable("discard-success")).toBe(true);
    expect(sessionStorage.getItem("discard-success")).toBeNull();
    expect(storage.getStatus("discard-success")).toEqual({ kind: "absent" });
    expect(storage.discardUnreadable("discard-success")).toBe(false);
});

test("a discard that silently retains bytes keeps the unreadable write gate", () => {
    const id = "discard-silent-refusal";
    const raw = "keep these corrupt bytes";
    sessionStorage.setItem(id, raw);
    storage.readTree(id);
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {});

    expect(() => storage.discardUnreadable(id)).toThrow(
        "Session storage retained the unreadable tree after removal.",
    );
    expect(storage.getStatus(id)).toEqual({ kind: "unreadable", rawValue: raw });
    expect(sessionStorage.getItem(id)).toBe(raw);
    expect(storage.pendingCount()).toBe(0);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    removeItem.mockRestore();
});

test.each([
    { position: [0, 0, 5], expected: [0, 0] },
    { position: [2], expected: [] },
])("read clamps unresolved position $position to its valid prefix", ({ position, expected }) => {
    persistTree("stale-position", treeWithPaths({ position }));

    expect(storage.read("stale-position")?.state).toMatchObject({ position: expected });
});

test("read removes an unresolved start header and retains a valid nested start", () => {
    persistTree("stale-start", treeWithPaths({ start: [0, 5] }));
    expect(storage.read("stale-start")?.state).not.toHaveProperty("headers.start");

    persistTree("valid-start", treeWithPaths({ start: [0, 0] }));
    expect(storage.read("valid-start")?.state).toMatchObject({ headers: { start: [0, 0] } });
});

test("read clamps practice paths and preserves null or absent practice state", () => {
    persistTree("stale-practice", treeWithPaths({ practicePath: [1, 3] }));
    expect(storage.read("stale-practice")?.state).toMatchObject({ practicePath: [1] });

    persistTree("null-practice", treeWithPaths({ practicePath: null }));
    expect(storage.read("null-practice")?.state).toMatchObject({ practicePath: null });

    persistTree("absent-practice", treeWithPaths({}));
    expect(storage.read("absent-practice")?.state).not.toHaveProperty("practicePath");
});

test("a healthy tree with three valid paths is unchanged and is not rewritten", () => {
    const tree = treeWithPaths({
        position: [0, 0],
        start: [0, 0],
        practicePath: [1],
    });
    storage.seed("healthy-paths", tree);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    try {
        expect(storage.read("healthy-paths")?.state).toEqual(tree);
        expect(setItem).not.toHaveBeenCalled();
    } finally {
        setItem.mockRestore();
    }
});

test("read persists repaired paths back into the stored envelope", () => {
    persistTree(
        "repair-writeback",
        treeWithPaths({ position: [0, 0, 5], start: [0, 5], practicePath: [1, 3] }),
    );

    storage.read("repair-writeback");

    const raw = sessionStorage.getItem("repair-writeback");
    expect(raw).not.toBeNull();
    expect(deserializeStorageValue(raw!)).toMatchObject({
        state: { position: [0, 0], practicePath: [1] },
    });
    expect(deserializeStorageValue(raw!)).not.toHaveProperty("state.headers.start");
});

test("seed and both clone routes store repaired start headers", () => {
    const stale = treeWithPaths({ start: [0, 5] });

    // seed and cloneDurable write sessionStorage directly; the raw value is asserted because read
    // would repair a stale path on its own and hide a writer that stored it.
    storage.seed("seed-repair", stale);
    expect(deserializeStorageValue(sessionStorage.getItem("seed-repair")!)).not.toHaveProperty(
        "state.headers.start",
    );

    persistTree("clone-source-repair", stale);
    storage.clone("clone-source-repair", "clone-target-repair");
    expect(storage.read("clone-target-repair")?.state).not.toHaveProperty("headers.start");

    persistTree("durable-source-repair", stale);
    storage.cloneDurable("durable-source-repair", "durable-target-repair");
    expect(
        deserializeStorageValue(sessionStorage.getItem("durable-target-repair")!),
    ).not.toHaveProperty("state.headers.start");
});

test("failed-admission replay ignores malformed markers without touching their trees or unrelated keys", () => {
    const invalidId = "not-a-uuid";
    const invalidValueId = crypto.randomUUID();
    const validId = crypto.randomUUID();
    for (const id of [invalidId, invalidValueId, validId]) persistTree(id, defaultTree());
    const marker = (id: string) => `chessfable:failed-tab-admission:${id}`;
    sessionStorage.setItem(marker(invalidId), "1");
    sessionStorage.setItem(marker(invalidValueId), "unexpected");
    sessionStorage.setItem(marker(validId), "1");
    sessionStorage.setItem("Stryker was here", "keep");
    sessionStorage.setItem("undefined", "keep");

    const replay = storage.replayFailedAdmissions(new Set());

    expect(replay.markedIds).toEqual(new Set([validId]));
    expect(replay.failedIds.size).toBe(0);
    expect(sessionStorage.getItem(invalidId)).not.toBeNull();
    expect(sessionStorage.getItem(invalidValueId)).not.toBeNull();
    expect(sessionStorage.getItem(validId)).toBeNull();
    for (const id of [invalidId, invalidValueId, validId]) {
        expect(sessionStorage.getItem(marker(id))).toBeNull();
    }
    expect(sessionStorage.getItem("Stryker was here")).toBe("keep");
    expect(sessionStorage.getItem("undefined")).toBe("keep");
});

test("failed-admission replay skips a null storage-key slot and processes later markers", () => {
    const id = crypto.randomUUID();
    const marker = `chessfable:failed-tab-admission:${id}`;
    sessionStorage.setItem("unrelated", "keep");
    persistTree(id, defaultTree());
    sessionStorage.setItem(marker, "1");
    const originalKey = Storage.prototype.key;
    const key = vi
        .spyOn(Storage.prototype, "key")
        .mockImplementation(function (this: Storage, index) {
            if (index === 0) return null;
            return originalKey.call(this, index);
        });

    const replay = storage.replayFailedAdmissions(new Set());

    key.mockRestore();
    expect(replay.markedIds).toEqual(new Set([id]));
    expect(sessionStorage.getItem(id)).toBeNull();
    expect(sessionStorage.getItem(marker)).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test("failed-admission replay reports a storage-key enumeration failure", () => {
    const failure = new DOMException("key enumeration denied", "SecurityError");
    sessionStorage.setItem("unrelated", "keep");
    const key = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
        throw failure;
    });

    expect(storage.replayFailedAdmissions(new Set())).toEqual({
        markedIds: new Set(),
        failedIds: new Set(),
    });

    key.mockRestore();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(failure);
});

test("failed-admission replay keeps a marker if its tree cannot be read and continues", () => {
    const unreadableId = crypto.randomUUID();
    const removableId = crypto.randomUUID();
    const marker = (id: string) => `chessfable:failed-tab-admission:${id}`;
    for (const id of [unreadableId, removableId]) {
        persistTree(id, defaultTree());
        sessionStorage.setItem(marker(id), "1");
    }
    const failure = new DOMException("tree read denied", "SecurityError");
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === unreadableId) throw failure;
            return originalGetItem.call(this, key);
        });

    const replay = storage.replayFailedAdmissions(new Set());

    getItem.mockRestore();
    expect(replay.markedIds).toEqual(new Set([unreadableId, removableId]));
    expect(replay.failedIds).toEqual(new Set([unreadableId]));
    expect(sessionStorage.getItem(unreadableId)).not.toBeNull();
    expect(sessionStorage.getItem(marker(unreadableId))).toBe("1");
    expect(sessionStorage.getItem(removableId)).toBeNull();
    expect(sessionStorage.getItem(marker(removableId))).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(failure);
});

test("failed-admission replay reports the first marker cleanup error and preserves both markers", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const markers = ids.map((id) => `chessfable:failed-tab-admission:${id}`);
    for (const key of markers) sessionStorage.setItem(key, "1");
    const firstError = new DOMException("first marker denied", "SecurityError");
    const secondError = new DOMException("second marker denied", "SecurityError");
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === markers[0]) throw firstError;
            if (key === markers[1]) throw secondError;
            return originalRemoveItem.call(this, key);
        });

    storage.replayFailedAdmissions(new Set());

    removeItem.mockRestore();
    expect(sessionStorage.getItem(markers[0]!)).toBe("1");
    expect(sessionStorage.getItem(markers[1]!)).toBe("1");
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(firstError);
});

test("known-tree batch removal reports its first failure and survives a throwing iterator", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) persistTree(id, defaultTree());
    const firstError = new DOMException("first removal denied", "SecurityError");
    const secondError = new DOMException("second removal denied", "SecurityError");
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === ids[0]) throw firstError;
            if (key === ids[1]) throw secondError;
            return originalRemoveItem.call(this, key);
        });

    expect(storage.removeKnownTreesSafely(ids)).toEqual(new Set(ids));
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(firstError);
    removeItem.mockRestore();
    persistError.reportPersistError.mockClear();
    const iteratorFailure = new Error("enumeration failed");
    function* brokenIds() {
        yield ids[0]!;
        throw iteratorFailure;
    }
    expect(storage.removeKnownTreesSafely(brokenIds())).toEqual(new Set());
    expect(sessionStorage.getItem(ids[0]!)).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(iteratorFailure);
});

test("tree-key snapshot accepts the exact length bound and supports omitted exclusions", () => {
    const boundaryKey = "a".repeat(128);
    const oversizedKey = "b".repeat(129);
    persistTree(boundaryKey, defaultTree());
    expect(storage.snapshotStoredTreeKeys(1, 128)).toEqual([boundaryKey]);
    expect(storage.snapshotStoredTreeKeys(1, 128, new Set([boundaryKey]))).toEqual([]);
    persistTree(oversizedKey, defaultTree());
    expect(storage.snapshotStoredTreeKeys(2, 128)).toBeNull();
});

test("tree-key snapshot refuses two boundary-length keys when only one is allowed", () => {
    persistTree("a".repeat(128), defaultTree());
    persistTree("b".repeat(128), defaultTree());

    expect(storage.snapshotStoredTreeKeys(1, 128)).toBeNull();
});

test("tree-key snapshot reports enumeration failures and returns no snapshot", () => {
    persistTree("stored-tree", defaultTree());
    const scanError = new DOMException("tree snapshot denied", "SecurityError");
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
        throw scanError;
    });

    expect(storage.snapshotStoredTreeKeys(1, 128)).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(scanError);
});
