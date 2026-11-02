import { INITIAL_FEN } from "chessops/fen";
import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame, Token } from "@/bindings";
import { tabsAtom, recentFilesAtom, addRecentFileAtom } from "@/state/atoms";
import signatureCases from "./gameSignature.cases.json";
import { tabStorage } from "@/state/store/tabStorage";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { databaseGameSeed, normalizeGameSignature, openDatabaseGame } from "./databaseGame";
import { createTab, serializeStoreTree } from "./tabs";

const native = vi.hoisted(() => ({ lexPgn: vi.fn(), resolveLinkedGame: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: vi.fn() }));

const database = { id: { id: "header-database" }, kind: "database" } as const;
const ids: string[] = [];

beforeEach(() => {
    native.resolveLinkedGame.mockReset().mockResolvedValue(null);
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
            setTabs:
                mode === "refused" ? () => false : (...args) => workspace.set(tabsAtom, ...args),
            addRecentFile: add,
        });
        if (id) ids.push(id);
        const expectedEntry = expect.objectContaining({
            kind: "database",
            database,
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
    },
);
