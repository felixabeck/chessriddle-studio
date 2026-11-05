import { parseUci } from "chessops";
import { afterEach, expect, test, vi } from "vitest";
import {
    createNode,
    defaultTree,
    getBoardState,
    getMemoizedBoardStateMap,
    getEffectiveGameEnd,
} from "@/utils/treeReducer";
import { serializeStorageValue } from "./debouncedStorage";
import { tabStorage, TREE_STORAGE_VERSION } from "./tabStorage";
import { emptyPuzzleSession } from "@/state/puzzleSession";
import {
    captureReportOwner,
    closeTreeStore,
    createTreeStore,
    discardTreeStoreStorage,
    retryTreeStoreStorage,
    retargetTreeStore,
    prepareTreeStoreRetarget,
    nextContinuation,
} from "./tree";

const ids: string[] = [];

test.each([undefined, {}, { termination: "Abandoned" }])(
    "tab hydration preserves gameEnd=%j without applying a load default",
    (gameEnd) => {
        const tree = defaultTree();
        const memory = createTreeStore(undefined, tree);
        memory.getState().makeMoves({ payload: ["e4", "e5"] });
        const saved = structuredClone({
            ...tree,
            root: memory.getState().root,
            headers: {
                ...tree.headers,
                result: "1-0" as const,
                other: { Termination: "Header stays on hydration" },
            },
        });
        if (gameEnd) saved.root.children[0].gameEnd = gameEnd;
        const id = crypto.randomUUID();
        ids.push(id);
        sessionStorage.setItem(
            id,
            serializeStorageValue({ version: TREE_STORAGE_VERSION, state: saved }),
        );
        const hydrated = createTreeStore(id).getState();
        expect(hydrated.root).toEqual(saved.root);
        expect(hydrated.headers).toEqual(saved.headers);
        expect(hydrated.dirty).toBe(false);
        expect(getEffectiveGameEnd(hydrated.root)?.position).toEqual(gameEnd ? [0] : undefined);
        expect(hydrated.root.children[0].children[0].gameEnd).toBeUndefined();
    },
);

test.each(
    [0, TREE_STORAGE_VERSION].flatMap((version) =>
        ["KQkq e3", "HAha -"].map((rightsAndEp) => ({ version, rightsAndEp })),
    ),
)(
    "hydration derives $rightsAndEp identity without rewriting version $version FENs",
    ({ version, rightsAndEp }) => {
        const id = crypto.randomUUID();
        ids.push(id);
        const board = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b";
        const fen = `${board} ${rightsAndEp} 0 1`;
        const memory = createTreeStore(undefined, defaultTree(fen));
        const cycle = ["g8f6", "g1f3", "f6g8", "f3g1"];
        expect(memory.getState().makeMoves({ payload: cycle }).success).toBe(true);
        const saved = memory.getState();
        const raw = serializeStorageValue({ version, state: saved });
        sessionStorage.setItem(id, raw);

        const store = createTreeStore(id);
        const restored = store.getState();
        expect(restored.root).toEqual(saved.root);
        expect(restored.headers).toEqual(saved.headers);
        expect(restored.position).toEqual([0, 0, 0, 0]);
        expect(restored.currentNode()).toMatchObject({
            fen: `${board} KQkq - 4 3`,
            halfMoves: 5,
        });
        const map = getMemoizedBoardStateMap(restored.root);
        expect(map[getBoardState(restored.currentNode().fen)].map(({ path }) => path)).toEqual([
            [],
            [0, 0, 0, 0],
        ]);
        expect(nextContinuation(restored)?.path).toEqual([]);
        expect(tabStorage.read<TreeStoreSnapshot>(id)?.state.root).toEqual(saved.root);
        expect(restored.headers.result).toBe("*");
        expect(restored.makeMoves({ payload: cycle }).success).toBe(true);
        expect(store.getState().headers.result).toBe("1/2-1/2");
        expect(store.getState().root.fen).toBe(fen);
        expect(store.getState().headers.fen).toBe(fen);
        expect(store.getState().currentNode().fen).toBe(`${board} KQkq - 8 5`);
    },
);

test.each(["omitted", "undefined", "provided"] as const)(
    "complete tree replacement normalizes %s provenance while ordinary partial updates retain it",
    (provenance) => {
        const logical = crypto.randomUUID();
        const physical = crypto.randomUUID();
        ids.push(logical, physical);
        const locator = {
            collection: "22222222-2222-4222-8222-222222222222",
            generation: "old-linked-generation",
            ordinal: 0,
            stamp: "a".repeat(64),
        };
        tabStorage.seed(logical, { ...defaultTree(), linkedSource: locator });
        const store = createTreeStore(logical);
        store.setState({ dirty: true });
        expect(store.getState().linkedSource).toEqual(locator);
        const nextLocator = { ...locator, generation: "new-generation", stamp: "b".repeat(64) };
        const tree = {
            ...defaultTree(),
            ...(provenance === "provided"
                ? { linkedSource: nextLocator }
                : provenance === "undefined"
                  ? { linkedSource: undefined }
                  : {}),
        };
        const before = store.getState();
        const install = prepareTreeStoreRetarget(logical, physical, tree);
        expect(store.getState()).toBe(before);
        install();
        expect(store.getState().linkedSource).toEqual(
            provenance === "provided" ? nextLocator : null,
        );
        store.getState().setComment("Persist the admitted replacement");
        expect(tabStorage.flush()).toEqual([]);
        closeTreeStore(logical);
        const cold = createTreeStore(logical, undefined, physical);
        expect(cold.getState().linkedSource).toEqual(
            provenance === "provided" ? nextLocator : null,
        );
    },
);

test("session selection B and played annotations restore together in a fresh store", () => {
    const id = crypto.randomUUID();
    ids.push(id);
    const store = createTreeStore(id);
    const puzzle = {
        id: 1,
        fen: defaultTree().root.fen,
        moves: ["e2e4", "e7e5"],
        rating: 1500,
        rating_deviation: 50,
        popularity: 90,
        nb_plays: 100,
        completion: "incomplete" as const,
        timeSpent: 1200,
    };
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    store.getState().setComment("B played annotation");
    expect(
        store.getState().transitionPuzzleSession((draft) => {
            draft.puzzleSession = {
                version: 1,
                attempts: [
                    { attemptId: "a", puzzle },
                    { attemptId: "b", puzzle },
                ],
                selectedAttemptId: "b",
            };
        }).success,
    ).toBe(true);
    const expected = store.getState();
    closeTreeStore(id);
    const restored = createTreeStore(id);
    expect(restored).not.toBe(store);
    expect(restored.getState().root).toEqual(expected.root);
    expect(restored.getState()).toMatchObject({
        position: [0, 0],
        puzzleSession: expected.puzzleSession,
    });
    expect(restored.getState().currentNode().comment).toBe("B played annotation");
    expect(restored.getState().puzzleSession!.selectedAttemptId).toBe("b");
});

test("session transition after retarget saves only the current physical generation", () => {
    const logical = crypto.randomUUID();
    const physical = crypto.randomUUID();
    ids.push(logical, physical);
    const store = createTreeStore(logical);
    const ownsOriginal = store.getState().capturePuzzleSessionOwner();
    const replacement = { ...defaultTree(), puzzleSession: emptyPuzzleSession() };
    tabStorage.seed(physical, replacement);
    retargetTreeStore(logical, physical, replacement);
    expect(ownsOriginal()).toBe(false);
    const ownsReplacement = store.getState().capturePuzzleSessionOwner();
    expect(ownsReplacement()).toBe(true);
    expect(
        store.getState().transitionPuzzleSession((draft) => {
            draft.root.comment = "physical session";
        }).success,
    ).toBe(true);
    expect(sessionStorage.getItem(logical)).toBeNull();
    expect(tabStorage.read(physical, true)?.state).toMatchObject({
        root: { comment: "physical session" },
        puzzleSession: emptyPuzzleSession(),
    });
    expect(ownsReplacement()).toBe(false);
    const ownsCommitted = store.getState().capturePuzzleSessionOwner();
    expect(ownsCommitted()).toBe(true);
    closeTreeStore(logical);
    expect(ownsCommitted()).toBe(false);
});

test("invalid session hydration gates the tree and preserves bytes until explicit discard", async () => {
    const id = crypto.randomUUID();
    ids.push(id);
    const bytes = serializeStorageValue({
        version: TREE_STORAGE_VERSION,
        state: { ...defaultTree(), puzzleSession: { version: 99 } },
    });
    sessionStorage.setItem(id, bytes);
    const store = createTreeStore(id);
    const before = store.getState();
    expect(tabStorage.getStatus(id)).toEqual({ kind: "unreadable", rawValue: bytes });
    expect(
        before.transitionPuzzleSession((draft) => {
            draft.puzzleSession = emptyPuzzleSession();
        }).success,
    ).toBe(false);
    expect(store.getState()).toBe(before);
    expect(sessionStorage.getItem(id)).toBe(bytes);
    expect(await retryTreeStoreStorage(id)).toEqual({ kind: "unreadable", rawValue: bytes });
    expect(discardTreeStoreStorage(id)).toBe(true);
    expect(
        store.getState().transitionPuzzleSession((draft) => {
            draft.puzzleSession = emptyPuzzleSession();
        }).success,
    ).toBe(true);
});

test("prepared retarget bypasses mutable actions and preserves the durable seed through subscriber failure", () => {
    const logical = crypto.randomUUID();
    const physical = crypto.randomUUID();
    ids.push(logical, physical);
    const store = createTreeStore(logical);
    store.getState().setComment("Pending old tree");
    const pending = tabStorage.read(logical)?.state;
    const tree = defaultTree();
    tree.headers.event = "Prepared candidate";
    tree.sourceStamp = "b".repeat(64);
    tabStorage.seed(physical, tree);
    const bytes = sessionStorage.getItem(physical);
    const install = prepareTreeStoreRetarget(logical, physical, tree);
    vi.spyOn(store.getState(), "setState").mockImplementation(() => {
        throw new Error("Mutable action must be bypassed");
    });
    const failure = new Error("Installed observer failure");
    const unsubscribe = store.subscribe(() => {
        throw failure;
    });
    expect(() => install()).toThrow(failure);
    unsubscribe();
    expect(store.getState()).toMatchObject(tree);
    expect(store.getState().practicePath).toBeNull();
    expect(tabStorage.pendingCount()).toBe(1);
    expect(tabStorage.read(logical)?.state).toEqual(pending);
    expect(sessionStorage.getItem(physical)).toBe(bytes);
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(physical)).toBe(bytes);
    store.getState().setComment("Later candidate edit");
    expect(tabStorage.flush()).toEqual([]);
    expect(tabStorage.read(physical, true)?.state).toMatchObject({
        headers: tree.headers,
        root: { comment: "Later candidate edit" },
    });
    expect(tabStorage.read(logical)?.state).toMatchObject({
        root: { comment: "Pending old tree" },
        dirty: true,
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    for (const id of ids.splice(0)) {
        closeTreeStore(id);
        tabStorage.remove(id);
    }
});

test("hydrates the referenced physical tree without reading the logical tab key", () => {
    const logical = crypto.randomUUID();
    const physical = crypto.randomUUID();
    ids.push(logical, physical);
    const legacy = defaultTree();
    legacy.headers.event = "Discarded game";
    const candidate = defaultTree();
    candidate.headers.event = "Referenced game";
    candidate.sourceStamp = "a".repeat(64);
    tabStorage.seed(logical, legacy);
    tabStorage.seed(physical, candidate);
    const store = createTreeStore(logical, undefined, physical);
    expect(store.getState().headers.event).toBe("Referenced game");
    expect(createTreeStore(logical, undefined, physical)).toBe(store);
    store.getState().setComment("edit on referenced tree");
    expect(tabStorage.flush()).toEqual([]);
    expect(tabStorage.read<TreeStoreSnapshot>(logical)?.state.headers.event).toBe("Discarded game");
    expect(tabStorage.read<TreeStoreSnapshot>(physical)?.state.root.comment).toBe(
        "edit on referenced tree",
    );
});

type TreeStoreSnapshot = ReturnType<typeof defaultTree>;

test.each(["missing", "refused"] as const)(
    "retargeted legacy cached store requires its physical generation after a %s read",
    async (failure) => {
        const logical = crypto.randomUUID();
        const physical = crypto.randomUUID();
        ids.push(logical, physical);
        const store = createTreeStore(logical);
        const reportOwner = captureReportOwner(logical);
        expect(tabStorage.getStatus(logical).kind).toBe("absent");
        const replacement = defaultTree();
        replacement.headers.event = "Durable replacement";
        tabStorage.seed(physical, replacement);
        retargetTreeStore(logical, physical, replacement);
        expect(tabStorage.flush()).toEqual([]);
        const bytes = sessionStorage.getItem(physical)!;
        const installed = store.getState();
        sessionStorage.removeItem(physical);
        if (failure === "refused") {
            const get = Storage.prototype.getItem;
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(
                function (this: Storage, key) {
                    if (key === physical) throw new DOMException("refused", "SecurityError");
                    return get.call(this, key);
                },
            );
        }
        expect(await retryTreeStoreStorage(logical)).toMatchObject({ kind: "unavailable" });
        expect(store.getState()).toEqual(installed);
        store.getState().setComment("blocked edit after retarget");
        expect(tabStorage.pendingCount()).toBe(0);
        vi.restoreAllMocks();
        expect(sessionStorage.getItem(physical)).toBeNull();
        expect(sessionStorage.getItem(logical)).toBeNull();
        sessionStorage.setItem(physical, bytes);
        expect(await retryTreeStoreStorage(logical)).toEqual({ kind: "available" });
        expect(createTreeStore(logical)).toBe(store);
        expect(captureReportOwner(logical)).toBe(reportOwner);
        expect(store.getState().headers.event).toBe("Durable replacement");
        expect(store.getState().root.comment).toBe("");
        store.getState().setComment("recovered physical edit");
        expect(tabStorage.flush()).toEqual([]);
        expect(tabStorage.read<TreeStoreSnapshot>(physical, true)?.state.root.comment).toBe(
            "recovered physical edit",
        );
        expect(sessionStorage.getItem(logical)).toBeNull();
    },
);

test.each(["missing", "unreadable", "unavailable"] as const)(
    "referenced %s tree remains write gated until explicit recovery",
    async (kind) => {
        const logical = crypto.randomUUID();
        const physical = crypto.randomUUID();
        ids.push(logical, physical);
        if (kind === "unreadable") sessionStorage.setItem(physical, "corrupt referenced bytes");
        if (kind === "unavailable") {
            const get = Storage.prototype.getItem;
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(
                function (this: Storage, key) {
                    if (key === physical) throw new DOMException("refused", "SecurityError");
                    return get.call(this, key);
                },
            );
        }
        const store = createTreeStore(logical, undefined, physical);
        expect(tabStorage.getStatus(physical).kind).toBe(kind === "missing" ? "unavailable" : kind);
        store.getState().setComment("must not overwrite reference");
        expect(tabStorage.pendingCount()).toBe(0);
        vi.restoreAllMocks();
        expect(sessionStorage.getItem(physical)).toBe(
            kind === "unreadable" ? "corrupt referenced bytes" : null,
        );
        if (kind === "unreadable") discardTreeStoreStorage(logical, physical);
        tabStorage.flush();
        const recovered = defaultTree();
        recovered.headers.event = "Recovered physical generation";
        sessionStorage.setItem(
            physical,
            serializeStorageValue({ version: TREE_STORAGE_VERSION, state: recovered }),
        );
        expect(await retryTreeStoreStorage(logical)).toEqual({ kind: "available" });
        expect(store.getState().headers.event).toBe("Recovered physical generation");
        expect(createTreeStore(logical)).toBe(store);
    },
);

test.each([0, TREE_STORAGE_VERSION])(
    "restores saved moves and metadata from a version %i tree envelope",
    (version) => {
        const id = `tree-hydration-version-${version}`;
        ids.push(id);
        const saved = defaultTree();
        saved.headers.event = "Saved game";
        saved.position = [0];
        const child = createNode({
            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
        });
        child.comment = "Saved annotation";
        saved.root.children.push(child);
        sessionStorage.setItem(id, serializeStorageValue({ version, state: saved }));

        const restored = createTreeStore(id).getState();

        expect(restored.headers.event).toBe("Saved game");
        expect(restored.position).toEqual([0]);
        expect(restored.root.children).toHaveLength(1);
        expect(restored.root.children[0]).toMatchObject({
            san: "e4",
            comment: "Saved annotation",
            halfMoves: 1,
        });
    },
);

test("rehydration repairs stale paths before deriving the whole-tree board map", () => {
    const id = "tree-hydration-stale-paths";
    ids.push(id);
    const saved = defaultTree();
    saved.position = [0, 0, 5];
    saved.headers.start = [0, 5];

    const e4 = createNode({
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves: 1,
    });
    const e5 = createNode({
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        move: parseUci("e7e5")!,
        san: "e5",
        halfMoves: 2,
    });
    e4.children.push(e5);
    const d4 = createNode({
        fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1",
        move: parseUci("d2d4")!,
        san: "d4",
        halfMoves: 1,
    });
    saved.root.children.push(e4, d4);
    sessionStorage.setItem(
        id,
        serializeStorageValue({ version: TREE_STORAGE_VERSION, state: saved }),
    );

    const restored = createTreeStore(id).getState();

    expect(restored.headers.start).toBeUndefined();
    expect(restored.position).toEqual([0, 0]);
    const map = getMemoizedBoardStateMap(restored.root, restored.headers.start ?? []);
    expect(map[getBoardState(d4.fen)]?.map(({ path }) => path)).toEqual([[1]]);
    expect(Object.values(map).flat()).toHaveLength(4);
});
