import { INITIAL_FEN } from "chessops/fen";
import { initializeI18n } from "@/i18n";
import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame, Token } from "@/bindings";
import {
    tabsAtom,
    recentFilesAtom,
    addRecentFileAtom,
    lastOpenedAtom,
    closingTabsAtom,
    tabFamily,
    type RecentEntryInput,
} from "@/state/atoms";
import { databaseGameOpenedKey } from "@/state/lastOpened";
import { WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import signatureCases from "./gameSignature.cases.json";
import { tabStorage } from "@/state/store/tabStorage";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { databaseGameSeed, normalizeGameSignature, openDatabaseGame } from "./databaseGame";
import { createTab, runTabCreation, serializeStoreTree } from "./tabs";
import type { TreeState } from "./treeReducer";

const native = vi.hoisted(() => ({
    lexPgn: vi.fn(),
    resolveLinkedGame: vi.fn(),
    getDbGame: vi.fn(),
    inferGameOrientation: vi.fn(),
    log: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: vi.fn() }));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    logFailureSafely: native.log,
}));

const database = { id: { id: "header-database" }, kind: "database" } as const;
const ids: string[] = [];

beforeEach(async () => {
    await initializeI18n();
    native.resolveLinkedGame.mockReset().mockResolvedValue(null);
    native.getDbGame.mockReset();
    native.inferGameOrientation.mockReset().mockResolvedValue(null);
    native.log.mockReset().mockResolvedValue(undefined);
    native.lexPgn.mockReset().mockResolvedValue([
        { type: "San", value: "e4" },
        { type: "San", value: "e5" },
        { type: "Outcome", value: "*" },
    ] satisfies Token[]);
});

afterEach(() => {
    ids.splice(0).forEach(closeTreeStore);
    tabStorage.flush();
    sessionStorage.clear();
    localStorage.clear();
});

test.each([
    { stored: String.raw`Open \"A\" Cup`, decoded: 'Open "A" Cup' },
    { stored: String.raw`Hall \\ Wing`, decoded: "Hall \\ Wing" },
    { stored: String.raw`Hall \\\\ Wing`, decoded: "Hall \\\\ Wing" },
    { stored: String.raw`Open \\\"A\" Cup\\`, decoded: 'Open \\"A" Cup\\' },
])(
    "database header $stored seeds decoded text and saves its exact spelling",
    async ({ stored, decoded }) => {
        const game: NormalizedGame = {
            id: 42,
            fen: INITIAL_FEN,
            event: stored,
            event_id: 1,
            site: stored,
            site_id: 2,
            white: String.raw`Ada \"Ace\"`,
            white_id: 3,
            black: String.raw`Bob \\ Labs`,
            black_id: 4,
            round: String.raw`R\"1`,
            time_control: String.raw`600+5\"bonus`,
            result: "*",
            moves: "1. e4 e5 *",
        };
        const seed = databaseGameSeed(game, database);
        native.getDbGame.mockResolvedValue({ kind: "found", game });
        expect(seed.headers).toEqual({ ...game, event: decoded, site: decoded });
        expect(game.event).toBe(stored);
        expect(game.site).toBe(stored);

        const workspace = createStore();
        workspace.set(tabsAtom, []);
        const id = await createTab({
            ...seed,
            setTabs: (...args) => workspace.set(tabsAtom, ...args),
        });
        expect(id).not.toBeNull();
        ids.push(id!);
        const store = createTreeStore(id!);
        expect(store.getState().headers).toEqual({
            id: game.id,
            fen: game.fen,
            event: decoded,
            site: decoded,
            white: game.white,
            black: game.black,
            round: game.round,
            time_control: game.time_control,
            result: game.result,
        });
        expect(store.getState().headers.event).toBe(decoded);
        expect(store.getState().headers.site).toBe(decoded);
        expect(workspace.get(tabsAtom)[0].gameOrigin).toEqual({
            kind: "database",
            database,
            gameId: game.id,
        });

        const serialized = serializeStoreTree(store);
        expect(serialized.split("\n").slice(0, 2)).toEqual([
            `[Event "${stored}"]`,
            `[Site "${stored}"]`,
        ]);
        expect(serialized).toContain("1. e4 e5 *");
        expect(native.lexPgn).toHaveBeenCalledWith(game.moves, undefined);
        expect(native.resolveLinkedGame).toHaveBeenCalledWith(database, game.id, null);
    },
);

test.each(signatureCases)(
    "normalizes signature marker $value with native semantics",
    ({ value, normal, date, round }) => {
        expect(
            normalizeGameSignature({
                white: value,
                black: value,
                event: value,
                site: value,
                date: value,
                round: value,
            }),
        ).toEqual({
            white: normal,
            black: normal,
            event: normal,
            site: normal,
            date,
            round,
        });
    },
);

test.each(["admitted", "refused", "online"] as const)(
    "opener records only admitted database games: %s",
    async (mode) => {
        const game: NormalizedGame = {
            id: 73,
            stamp: "b".repeat(64),
            fen: INITIAL_FEN,
            white: "White",
            black: "Black",
            white_id: 1,
            black_id: 2,
            event: String.raw`Cup \"A\"`,
            site: String.raw`Hall \\ Wing`,
            event_id: 1,
            site_id: 1,
            date: null,
            round: null,
            result: "*",
            moves: "1. e4 e5 *",
            linked: {
                collection: "11111111-1111-4111-8111-111111111111",
                generation: "old",
                ordinal: 2,
                stamp: "a".repeat(64),
            },
        };
        const workspace = createStore();
        workspace.set(tabsAtom, []);
        workspace.set(recentFilesAtom, []);
        workspace.set(lastOpenedAtom, {});
        native.getDbGame.mockResolvedValue({ kind: "found", game });
        const add = vi.fn(
            (
                entry: Parameters<typeof openDatabaseGame>[0]["addRecentFile"] extends (
                    entry: infer T,
                ) => void
                    ? T
                    : never,
            ) => workspace.set(addRecentFileAtom, entry),
        );
        const id = await openDatabaseGame({
            game,
            database: mode === "online" ? null : database,
            databaseTitle: "Meine Partien",
            setTabs:
                mode === "refused" ? () => false : (...args) => workspace.set(tabsAtom, ...args),
            addRecentFile: add,
        });
        if (id) ids.push(id);
        expect(
            id ? tabStorage.read<{ sourceStamp: string | null }>(id)?.state.sourceStamp : null,
        ).toBe(id ? (mode === "online" ? null : game.stamp) : null);
        const expectedEntry = expect.objectContaining({
            kind: "database",
            database,
            databaseTitle: "Meine Partien",
            gameId: 73,
            linked: {
                locator: game.linked,
                signature: {
                    white: "White",
                    black: "Black",
                    event: game.event,
                    site: game.site,
                    date: null,
                    round: null,
                },
            },
        });
        expect(add.mock.calls).toEqual(mode === "admitted" ? [[expectedEntry]] : []);
        expect(workspace.get(recentFilesAtom)).toHaveLength(mode === "admitted" ? 1 : 0);
        const admittedLastOpened = {
            [database.id.id]: expect.any(Number),
            [databaseGameOpenedKey(database, game.id)]: expect.any(Number),
        };
        expect(workspace.get(lastOpenedAtom)).toEqual(
            mode === "admitted" ? admittedLastOpened : {},
        );
        expect(native.getDbGame).toHaveBeenCalledTimes(mode === "online" ? 0 : 1);
        expect(native.inferGameOrientation).toHaveBeenCalledTimes(mode === "online" ? 0 : 1);
    },
);

test.each([
    { linked: false, orientation: undefined },
    { linked: true, orientation: undefined },
    { linked: true, orientation: "white" },
    { linked: true, orientation: "black" },
] as const)(
    "opening a row preserves its tree and stamp, linked=$linked, orientation=$orientation",
    async ({ linked, orientation }) => {
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        const row: NormalizedGame = {
            id: 812,
            stamp: "b".repeat(64),
            fen,
            white: "White",
            black: "Black",
            white_id: 1,
            black_id: 2,
            event: "Row event",
            event_id: 1,
            site: "Berlin",
            site_id: 1,
            result: "*",
            moves: "1... c5 *",
            linked: {
                collection: "11111111-1111-4111-8111-111111111111",
                generation: "linked",
                ordinal: 2,
                stamp: "a".repeat(64),
            },
        };
        native.lexPgn.mockResolvedValue([
            { type: "San", value: "c5" },
            { type: "Outcome", value: "*" },
        ] satisfies Token[]);
        if (linked) {
            native.lexPgn.mockResolvedValueOnce([
                ...(orientation
                    ? [
                          {
                              type: "Header" as const,
                              value: { tag: "Orientation", value: orientation },
                          },
                      ]
                    : []),
                { type: "San", value: "d4" },
                { type: "Outcome", value: "*" },
            ] satisfies Token[]);
            native.resolveLinkedGame.mockResolvedValueOnce({
                locator: { ...row.linked, stamp: "c".repeat(64) },
                file: { id: { id: "linked-file" }, kind: "fileWorkspace" },
                name: "Linked",
                ordinal: 2,
                purpose: "game",
                numGames: 3,
                game: { pgn: "1. d4 *", stamp: "c".repeat(64), revision: "linked", present: true },
            });
        }
        const workspace = createStore();
        workspace.set(tabsAtom, []);
        native.getDbGame.mockResolvedValue({ kind: "found", game: row });
        native.inferGameOrientation.mockResolvedValue("black");
        const id = await openDatabaseGame({
            game: row,
            database,
            setTabs: (...args) => workspace.set(tabsAtom, ...args),
            addRecentFile: vi.fn(),
        });
        expect(id).not.toBeNull();
        ids.push(id!);
        const persisted = tabStorage.read<TreeState>(id!)?.state;
        expect(persisted?.sourceStamp).toBe((linked ? "c" : "b").repeat(64));
        expect(workspace.get(tabsAtom)[0].gameOrigin.kind).toBe(linked ? "file" : "database");
        expect(linked ? null : persisted?.root.fen).toBe(linked ? null : fen);
        expect(linked ? null : persisted?.root.children[0].san).toBe(linked ? null : "c5");
        expect(linked ? {} : persisted?.headers).toMatchObject(
            linked
                ? {}
                : {
                      event: "Row event",
                      site: "Berlin",
                      white: "White",
                      black: "Black",
                  },
        );
        expect(persisted?.headers.orientation).toBe(orientation ?? "black");
        expect(persisted?.dirty).toBe(false);
        expect(native.inferGameOrientation).toHaveBeenCalledTimes(orientation ? 0 : 1);
    },
);

const orientationRow: NormalizedGame = {
    id: 42,
    stamp: "a".repeat(64),
    fen: INITIAL_FEN,
    white: "Opponent",
    white_id: 1,
    black: "Owner",
    black_id: 2,
    event: "Game",
    event_id: 1,
    site: "?",
    site_id: 1,
    result: "*",
    moves: "1. e4 e5 *",
};

test("an owned linked database open finishes current-game, source and orientation preparation before replacement", async () => {
    const workspace = createStore();
    const ownerId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const owner = {
        value: ownerId,
        name: "New",
        type: "new" as const,
        gameOrigin: { kind: "none" as const },
    };
    const other = { ...owner, value: otherId, name: "Other", type: "analysis" as const };
    workspace.set(tabsAtom, [other, owner], ownerId);
    workspace.set(recentFilesAtom, []);
    workspace.set(lastOpenedAtom, {});
    const locator = {
        collection: "11111111-1111-4111-8111-111111111111",
        generation: "current",
        ordinal: 2,
        stamp: "c".repeat(64),
    };
    const current = { ...orientationRow, white: "Current White", linked: locator };
    native.getDbGame.mockResolvedValueOnce({ kind: "found", game: current });
    const file = { id: { id: "opaque-linked-source" }, kind: "fileWorkspace" as const };
    native.resolveLinkedGame.mockResolvedValueOnce({
        locator,
        file,
        name: "Source",
        ordinal: 2,
        purpose: "repertoire",
        numGames: 3,
        game: { pgn: "1. e4 e5 *", stamp: locator.stamp, revision: "current", present: true },
    });
    native.inferGameOrientation.mockImplementationOnce(async () => {
        expect(workspace.get(tabsAtom)).toEqual([other, owner]);
        expect(workspace.get(lastOpenedAtom)).toEqual({});
        expect(workspace.get(recentFilesAtom)).toEqual([]);
        return "black";
    });
    const append = vi.fn();
    const id = await openDatabaseGame({
        game: orientationRow,
        database,
        ownerId,
        store: workspace,
        setTabs: append,
        addRecentFile: (entry) => workspace.set(addRecentFileAtom, entry),
    });
    expect(id).not.toBeNull();
    ids.push(id!);
    expect(append).not.toHaveBeenCalled();
    expect(native.getDbGame).toHaveBeenCalledExactlyOnceWith(database, orientationRow.id, null);
    expect(native.resolveLinkedGame).toHaveBeenCalledExactlyOnceWith(database, current.id, locator);
    expect(native.inferGameOrientation).toHaveBeenCalledExactlyOnceWith(database, current.id);
    expect(workspace.get(tabsAtom)).toEqual([
        other,
        expect.objectContaining({
            value: id,
            name: "Current White - Owner",
            gameOrigin: expect.objectContaining({
                kind: "file",
                gameNumber: 2,
                file: expect.objectContaining({ handle: file }),
            }),
        }),
    ]);
    expect(tabStorage.read<TreeState>(id!)?.state).toMatchObject({
        sourceStamp: locator.stamp,
        linkedSource: locator,
        headers: { orientation: "black" },
        dirty: false,
    });
    expect(workspace.get(tabFamily(id!))).toBe("info");
    expect(workspace.get(lastOpenedAtom)[database.id.id]).toBeGreaterThan(0);
});

test.each(["removed", "closing", "replaced", "tree", "workspace"] as const)(
    "an owned database open refused or superseded after preparation has no admission or records: %s",
    async (change) => {
        const workspace = createStore();
        const ownerId = crypto.randomUUID();
        const owner = {
            value: ownerId,
            name: "New",
            type: "new" as const,
            gameOrigin: { kind: "none" as const },
        };
        const other = { ...owner, value: crypto.randomUUID(), type: "analysis" as const };
        workspace.set(tabsAtom, [other, owner], ownerId);
        workspace.set(recentFilesAtom, []);
        workspace.set(lastOpenedAtom, {});
        let finish!: (orientation: string) => void;
        native.getDbGame.mockResolvedValueOnce({ kind: "found", game: orientationRow });
        native.inferGameOrientation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const append = vi.fn();
        const addRecentFile = vi.fn((entry: RecentEntryInput) =>
            workspace.set(addRecentFileAtom, entry),
        );
        const opening = openDatabaseGame({
            game: orientationRow,
            database,
            ownerId,
            store: workspace,
            setTabs: append,
            addRecentFile,
        });
        await vi.waitFor(() => expect(native.inferGameOrientation).toHaveBeenCalledOnce());
        if (change === "removed") workspace.set(tabsAtom, [other]);
        if (change === "closing") workspace.set(closingTabsAtom, new Set([ownerId]));
        if (change === "replaced") workspace.set(tabsAtom, [other, { ...owner, type: "analysis" }]);
        const before = workspace.get(tabsAtom);
        const openedBytes = localStorage.getItem("last-opened");
        const recentBytes = localStorage.getItem("recent-files");
        const original = Storage.prototype.setItem;
        const write = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (
                    this === sessionStorage &&
                    ((change === "workspace" && key === WORKSPACE_STORAGE_KEY) ||
                        (change === "tree" && key !== WORKSPACE_STORAGE_KEY))
                )
                    throw new DOMException("full", "QuotaExceededError");
                return original.call(this, key, value);
            });
        try {
            finish("black");
            expect(await opening).toBeNull();
            expect(append).not.toHaveBeenCalled();
            expect(addRecentFile).not.toHaveBeenCalled();
            expect(workspace.get(tabsAtom)).toEqual(before);
            expect(workspace.get(lastOpenedAtom)).toEqual({});
            expect(workspace.get(recentFilesAtom)).toEqual([]);
            expect(localStorage.getItem("last-opened")).toBe(openedBytes);
            expect(localStorage.getItem("recent-files")).toBe(recentBytes);
        } finally {
            write.mockRestore();
        }
    },
);

test.each(["white", "black"] as const)(
    "a stale list row opens with the current %s orientation and CAS stamp",
    async (orientation) => {
        const current = { ...orientationRow, orientation, stamp: "c".repeat(64) };
        native.getDbGame.mockResolvedValue({ kind: "found", game: current });
        native.inferGameOrientation.mockResolvedValue("black");
        const workspace = createStore();
        workspace.set(tabsAtom, []);
        const id = await openDatabaseGame({
            game: orientationRow,
            database,
            setTabs: (...args) => workspace.set(tabsAtom, ...args),
            addRecentFile: vi.fn(),
        });
        expect(id).not.toBeNull();
        ids.push(id!);
        expect(tabStorage.read<TreeState>(id!)?.state).toMatchObject({
            headers: { orientation },
            sourceStamp: current.stamp,
            dirty: false,
        });
        expect(native.getDbGame).toHaveBeenCalledExactlyOnceWith(database, 42, null);
        expect(native.inferGameOrientation).not.toHaveBeenCalled();
    },
);

test("an inference failure still admits the game cleanly with White fallback", async () => {
    native.getDbGame.mockResolvedValue({ kind: "found", game: orientationRow });
    native.inferGameOrientation.mockRejectedValue(new Error("Inference failed"));
    const workspace = createStore();
    workspace.set(tabsAtom, []);
    const addRecentFile = vi.fn();
    const id = await openDatabaseGame({
        game: orientationRow,
        database,
        setTabs: (...args) => workspace.set(tabsAtom, ...args),
        addRecentFile,
    });
    expect(id).not.toBeNull();
    ids.push(id!);
    const tree = tabStorage.read<TreeState>(id!)?.state;
    expect(tree?.headers.orientation).toBeUndefined();
    expect(tree?.dirty).toBe(false);
    expect(native.log).toHaveBeenCalledOnce();
    expect(addRecentFile).toHaveBeenCalledOnce();
});

test("a row deleted since listing rejects with a not-found error before any admission", async () => {
    native.getDbGame.mockResolvedValue({ kind: "missing" });
    const setTabs = vi.fn();
    const addRecentFile = vi.fn();
    await expect(
        openDatabaseGame({ game: orientationRow, database, setTabs, addRecentFile }),
    ).rejects.toEqual({
        category: "not-found",
        message: "This game no longer exists in the database.",
    });
    expect(setTabs).not.toHaveBeenCalled();
    expect(addRecentFile).not.toHaveBeenCalled();
    expect(native.inferGameOrientation).not.toHaveBeenCalled();
    expect(native.resolveLinkedGame).not.toHaveBeenCalled();
    expect(native.lexPgn).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
});

test("a deleted row reaches the tab caller's error path without success or recent recording", async () => {
    native.getDbGame.mockResolvedValue({ kind: "missing" });
    const setTabs = vi.fn();
    const addRecentFile = vi.fn();
    const onError = vi.fn();
    const onSuccess = vi.fn();
    expect(
        await runTabCreation({
            create: () =>
                openDatabaseGame({ game: orientationRow, database, setTabs, addRecentFile }),
            onError,
            onSuccess,
        }),
    ).toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith({
        category: "not-found",
        message: "This game no longer exists in the database.",
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(setTabs).not.toHaveBeenCalled();
    expect(addRecentFile).not.toHaveBeenCalled();
});

test.each(["Unknown", "?", ""])(
    "a native no-inference result for Black %s leaves White fallback unset",
    async (black) => {
        native.getDbGame.mockResolvedValue({
            kind: "found",
            game: { ...orientationRow, black, black_id: 0 },
        });
        const workspace = createStore();
        workspace.set(tabsAtom, []);
        const id = await openDatabaseGame({
            game: orientationRow,
            database,
            setTabs: (...args) => workspace.set(tabsAtom, ...args),
            addRecentFile: vi.fn(),
        });
        expect(id).not.toBeNull();
        ids.push(id!);
        const tree = tabStorage.read<TreeState>(id!)?.state;
        expect(tree?.headers.orientation).toBeUndefined();
        expect(tree?.dirty).toBe(false);
    },
);
