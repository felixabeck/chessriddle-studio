import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createTab: vi.fn(),
    readGame: vi.fn(),
    parsePGN: vi.fn(),
    storeGet: vi.fn(),
    storeSet: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return { ...actual, tauri: mocks };
});

vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return {
        ...actual,
        getDefaultStore: () => ({
            get: mocks.storeGet,
            set: mocks.storeSet,
        }),
    };
});

vi.mock("@/utils/chess", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/chess")>();
    return { ...actual, parsePGN: mocks.parsePGN };
});

vi.mock("./tabs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./tabs")>()),
    createTab: mocks.createTab,
}));

import type { StampedGame } from "@/bindings";
import i18n, { initializeI18n } from "@/i18n";
import {
    addRecentFileAtom,
    hidePreviewMovesAtom,
    invisibleFamily,
    tabFamily,
    tabsAtom,
} from "@/state/atoms";
import { defaultBoardArrangement } from "@/state/boardArrangement";
import { boardLayoutFamily } from "@/state/layoutStorage";
import { getFileFreshness } from "@/state/fileFreshness";
import { beginFileStructureChange, hasFileOpenInFlight } from "@/state/fileStructureChange";
import { openFile } from "./openFile";
import { fileWorkspaceKey } from "./pathCapabilities";

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const freshPgn =
    '[Event "Fresh from disk"]\n[White "Fresh White"]\n[Black "Fresh Black"]\n\n1. e4 e5 *';
const freshStamp = "a".repeat(64);

describe("openFile tab admission", () => {
    const file = {
        type: "file" as const,
        name: "white.pgn",
        handle: { id: { id: "white" }, kind: "fileWorkspace" as const },
        numGames: 1,
        metadata: { type: "repertoire" as const, tags: [] },
        lastModified: 1,
    };
    const setTabs = vi.fn();

    beforeEach(() => {
        mocks.parsePGN.mockImplementation(async (pgn: string) => {
            const tree = (await import("@/utils/treeReducer")).defaultTree();
            tree.headers.event = pgn.match(/\[Event "([^"]+)"\]/)?.[1] ?? "";
            tree.headers.white = pgn.match(/\[White "([^"]+)"\]/)?.[1] ?? "";
            tree.headers.black = pgn.match(/\[Black "([^"]+)"\]/)?.[1] ?? "";
            return tree;
        });
        mocks.readGame.mockResolvedValue({
            pgn: freshPgn,
            stamp: freshStamp,
            revision: "device:inode:revision",
            present: true,
        });
    });

    test("refuses to open during a file structure change without reading and opens after it ends", async () => {
        await initializeI18n();
        const endChange = beginFileStructureChange(fileWorkspaceKey(file.handle));
        try {
            await expect(openFile(file, setTabs)).rejects.toThrow(
                i18n.t("Files.LineSection.Stale"),
            );
            expect(mocks.readGame).not.toHaveBeenCalled();
            expect(mocks.createTab).not.toHaveBeenCalled();
            expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
        } finally {
            endChange();
        }

        mocks.createTab.mockResolvedValueOnce("tab-id");
        await expect(openFile(file, setTabs)).resolves.toBe("tab-id");
        expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(file.handle, 0, undefined);
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test("holds the open lease through the read and tab admission", async () => {
        const read = deferred<StampedGame>();
        const admission = deferred<string>();
        mocks.readGame.mockReturnValueOnce(read.promise);
        mocks.createTab.mockReturnValueOnce(admission.promise);
        const pending = openFile(file, setTabs);
        try {
            expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(true);
            expect(mocks.readGame).toHaveBeenCalledOnce();
            expect(mocks.createTab).not.toHaveBeenCalled();
            read.resolve({ pgn: freshPgn, stamp: freshStamp, revision: "revision", present: true });
            await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledOnce());
            expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(true);
        } finally {
            read.resolve({ pgn: freshPgn, stamp: freshStamp, revision: "revision", present: true });
            admission.resolve("tab-id");
            await pending;
        }
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test.each(["read", "parse", "admission"])(
        "releases the open lease after %s failure and permits another open",
        async (boundary) => {
            const failure = new Error("Open failed");
            if (boundary === "read") mocks.readGame.mockRejectedValueOnce(failure);
            if (boundary === "parse") mocks.parsePGN.mockRejectedValueOnce(failure);
            if (boundary === "admission") mocks.createTab.mockRejectedValueOnce(failure);

            await expect(openFile(file, setTabs)).rejects.toBe(failure);
            expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);

            mocks.createTab.mockResolvedValueOnce("tab-id");
            await expect(openFile(file, setTabs)).resolves.toBe("tab-id");
            expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
        },
    );

    test("refused admission preserves metadata, releases the open lease and permits retry", async () => {
        mocks.createTab.mockResolvedValueOnce(null);

        await expect(openFile(file, setTabs)).resolves.toBeNull();

        expect(mocks.readGame).toHaveBeenCalledWith(file.handle, 0, undefined);
        expect(mocks.storeSet).not.toHaveBeenCalled();
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);

        mocks.createTab.mockResolvedValueOnce("tab-id");
        await expect(openFile(file, setTabs)).resolves.toBe("tab-id");
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test("forwards cancellation through the read and refuses a retired open before admission", async () => {
        const { createTab } = await vi.importActual<typeof import("./tabs")>("./tabs");
        const controller = new AbortController();
        const admission = deferred<void>();
        mocks.createTab.mockImplementationOnce(async (options) => {
            await admission.promise;
            return createTab(options);
        });
        const pending = openFile(file, setTabs, { signal: controller.signal });
        try {
            await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledOnce());
            controller.abort();
        } finally {
            admission.resolve();
        }

        await expect(pending).resolves.toBeNull();
        expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(file.handle, 0, {
            signal: controller.signal,
        });
        expect(mocks.parsePGN).toHaveBeenCalledWith(freshPgn, undefined, {
            signal: controller.signal,
        });
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ signal: controller.signal }),
        );
        expect(setTabs).not.toHaveBeenCalled();
        expect(mocks.storeSet).not.toHaveBeenCalled();
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test("returns the admitted id and records an ordinary repertoire without selecting Practice", async () => {
        mocks.createTab.mockResolvedValueOnce("tab-id");

        await expect(openFile(file, setTabs)).resolves.toBe("tab-id");

        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                initialTree: expect.objectContaining({ sourceStamp: freshStamp }),
                tab: { name: "Fresh White", type: "analysis" },
                gameOrigin: { kind: "file", file, gameNumber: 0 },
            }),
        );
        expect(mocks.storeSet).toHaveBeenCalledTimes(1);
        expect(mocks.storeSet).toHaveBeenCalledWith(
            addRecentFileAtom,
            expect.objectContaining({ handle: file.handle }),
        );
        expect(mocks.storeSet).not.toHaveBeenCalledWith(tabFamily("tab-id"), "practice");
    });

    test.each([
        {
            type: "repertoire" as const,
            pgn: '[White "Dragon"]\n[Black "?"]\n[Event "fertig"]\n\n*',
            name: "Dragon",
        },
        {
            type: "repertoire" as const,
            pgn: '[White "?"]\n[Black "?"]\n[Event "Legacy"]\n\n*',
            name: "Legacy",
        },
        {
            type: "repertoire" as const,
            pgn: '[White "?"]\n[Black "?"]\n[Event "?"]\n\n*',
            name: "white",
        },
        { type: "repertoire" as const, pgn: "", name: "white" },
        { type: "game" as const, pgn: freshPgn, name: "Fresh White - Fresh Black" },
    ])("opens $type with tab name $name", async ({ type, pgn, name }) => {
        mocks.readGame.mockResolvedValueOnce({
            pgn,
            stamp: freshStamp,
            revision: "r1",
            present: true,
        });
        mocks.createTab.mockResolvedValueOnce("tab-id");
        await openFile({ ...file, metadata: { type, tags: [] } }, setTabs);
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ tab: { name, type: "analysis" } }),
        );
    });

    test("passes the owner through full preparation and selects Practice only on request", async () => {
        mocks.createTab.mockResolvedValueOnce("practice-id");
        const prior = mocks.storeGet.getMockImplementation();
        const gameLayoutAtom = boardLayoutFamily("game");
        mocks.storeGet.mockImplementation((atom: unknown) => {
            if (atom === tabsAtom) return [];
            if (atom === gameLayoutAtom) {
                return { arrangement: defaultBoardArrangement(), tabsHidden: true };
            }
            return prior?.(atom);
        });
        await openFile(file, setTabs, { ownerId: "home", panel: "practice" });
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerId: "home",
                initialTree: expect.objectContaining({ sourceStamp: freshStamp }),
            }),
        );
        expect(mocks.storeSet).toHaveBeenCalledWith(tabFamily("practice-id"), "practice");
        // Practice lives in the tab strip, so a hidden strip is shown.
        const layoutCall = mocks.storeSet.mock.calls.find(([atom]) => atom === gameLayoutAtom);
        expect(layoutCall).toBeDefined();
        const updater = layoutCall![1] as (prev: {
            arrangement: ReturnType<typeof defaultBoardArrangement>;
            tabsHidden: boolean;
        }) => { arrangement: ReturnType<typeof defaultBoardArrangement>; tabsHidden: boolean };
        expect(
            updater({ arrangement: defaultBoardArrangement(), tabsHidden: true }).tabsHidden,
        ).toBe(false);
    });

    test("an owner without an admitted id leaves freshness and all metadata untouched", async () => {
        mocks.createTab.mockResolvedValueOnce(null);
        const before = getFileFreshness("failed-owner");
        await expect(
            openFile(file, setTabs, { ownerId: "failed-owner", panel: "practice" }),
        ).resolves.toBeNull();
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ ownerId: "failed-owner" }),
        );
        expect(mocks.storeSet).not.toHaveBeenCalled();
        expect(getFileFreshness("failed-owner")).toEqual(before);
    });

    test.each([
        { difference: "stamp", stamp: "different-stamp", revision: "device:inode:revision" },
        {
            difference: "revision with the same stamp",
            stamp: freshStamp,
            revision: "older-revision",
        },
    ])("refuses a differing $difference before admitting a tab", async ({ stamp, revision }) => {
        await initializeI18n();
        await expect(openFile(file, setTabs, { expected: { stamp, revision } })).rejects.toThrow(
            i18n.t("Files.LineSection.Stale"),
        );
        expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(file.handle, 0, undefined);
        expect(mocks.createTab).not.toHaveBeenCalled();
        expect(mocks.storeSet).not.toHaveBeenCalled();
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test("admits a tab when the expected stamp and revision both match", async () => {
        mocks.createTab.mockResolvedValueOnce("tab-id");
        await expect(
            openFile(file, setTabs, {
                expected: { stamp: freshStamp, revision: "device:inode:revision" },
            }),
        ).resolves.toBe("tab-id");
        expect(mocks.createTab).toHaveBeenCalledOnce();
        expect(hasFileOpenInFlight(fileWorkspaceKey(file.handle))).toBe(false);
    });

    test.each([
        { pgn: "*", name: "Example" },
        { pgn: '[Event "?"]\n[White "?"]\n[Black "?"]\n\n*', name: "Example" },
        { pgn: '[White "White"]\n[Black "Black"]\n\n*', name: "White - Black" },
        { pgn: '[Event "Morra"]\n\n*', name: "Morra" },
    ])(
        "uses $name for the chapter tab and the file name for its recent entry",
        async ({ pgn, name }) => {
            mocks.readGame.mockResolvedValueOnce({
                pgn,
                stamp: freshStamp,
                revision: "r1",
                present: true,
            });
            mocks.createTab.mockResolvedValueOnce("tab-id");
            await openFile(
                { ...file, name: "Example.pgn", numGames: 3, metadata: { type: "game", tags: [] } },
                setTabs,
                {
                    gameNumber: 1,
                },
            );
            expect(mocks.readGame).toHaveBeenCalledWith(file.handle, 1, undefined);
            expect(mocks.createTab).toHaveBeenCalledWith(
                expect.objectContaining({ tab: { name, type: "analysis" } }),
            );
            expect(mocks.storeSet).toHaveBeenCalledWith(
                addRecentFileAtom,
                expect.objectContaining({ name: "Example.pgn" }),
            );
        },
    );

    test("an explicit tab name does not override the recent file name", async () => {
        mocks.createTab.mockResolvedValueOnce("tab-id");
        await openFile(file, setTabs, { tabName: "Custom" });
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ tab: { name: "Custom", type: "analysis" } }),
        );
        expect(mocks.storeSet).toHaveBeenCalledWith(
            addRecentFileAtom,
            expect.objectContaining({ name: file.name }),
        );
    });

    test("loads current disk text rather than accepting a preview supplied by the caller", async () => {
        mocks.readGame.mockResolvedValueOnce({
            pgn: '[Event "Fresh from disk"]\n\n1. e4 e5 *',
            stamp: freshStamp,
            revision: "new-revision",
            present: true,
        });
        mocks.createTab.mockResolvedValueOnce("tab-id");

        await openFile(file, setTabs, { gameNumber: 0 });

        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                tab: { name: "Fresh from disk", type: "analysis" },
                initialTree: expect.objectContaining({
                    sourceStamp: freshStamp,
                    headers: expect.objectContaining({ event: "Fresh from disk" }),
                }),
            }),
        );
        // The tab starts verified at the revision it was read at, so the gate does not re-read it.
        expect(getFileFreshness("tab-id")).toMatchObject({
            state: "verified",
            verifiedRevision: "new-revision",
        });
    });

    test.each([
        { fromPreview: true, preference: true, hidden: true },
        { fromPreview: true, preference: false, hidden: false },
        { fromPreview: false, preference: true, hidden: false },
    ])(
        "fromPreview=$fromPreview with preference $preference sets invisible=$hidden",
        async ({ fromPreview, preference, hidden }) => {
            mocks.createTab.mockResolvedValueOnce("tab-id");
            mocks.storeGet.mockImplementation((atom) =>
                atom === hidePreviewMovesAtom ? preference : undefined,
            );
            await openFile(file, setTabs, fromPreview ? { fromPreview: true } : undefined);
            expect(
                mocks.storeSet.mock.calls.some(
                    ([atom, value]) => atom === invisibleFamily("tab-id") && value === true,
                ),
            ).toBe(hidden);
        },
    );
});
