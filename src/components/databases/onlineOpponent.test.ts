import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ScopedMutator } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
    DatabaseHandle,
    ErrorPayload,
    OpponentAccount,
    OpponentImportOutcome,
    OpponentImportRequest,
} from "@/bindings";
import { opponentImportsAtom, opponentLinksAtom, pendingPlayerCardAtom } from "@/state/atoms";
import {
    defaultOpponentFilter,
    MAX_OPPONENT_ACCOUNTS,
    type OpponentLink,
} from "@/state/opponentLinks";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DatabaseList, SuccessDatabaseInfo } from "@/utils/db";
import type { DatabaseRouteTarget } from "./databaseRoute";

const mocks = vi.hoisted(() => ({
    publishDatabaseList: vi.fn(),
    opponentPlayers: vi.fn(),
    importOpponentGames: vi.fn(),
    withDownloadTicket: vi.fn(),
    getDatabaseWorkspace: vi.fn(),
    listWorkspaceDatabases: vi.fn(),
    deleteDatabase: vi.fn(),
    cancelDownload: vi.fn(),
    forgetDeletedDatabase: vi.fn(),
    notify: vi.fn(),
    notifyHide: vi.fn(),
    warn: vi.fn(),
    translate: (key: string, options?: Record<string, unknown>) =>
        String(options?.defaultValue ?? key),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            importOpponentGames: mocks.importOpponentGames,
            getDatabaseWorkspace: mocks.getDatabaseWorkspace,
            listWorkspaceDatabases: mocks.listWorkspaceDatabases,
            deleteDatabase: mocks.deleteDatabase,
            cancelDownload: mocks.cancelDownload,
        },
        withDownloadTicket: mocks.withDownloadTicket,
    };
});
vi.mock("@/hooks/useDatabaseList", () => ({
    publishDatabaseList: mocks.publishDatabaseList,
}));
vi.mock("./opponentLookup", () => ({
    opponentPlayers: mocks.opponentPlayers,
}));
vi.mock("./forgetDeletedDatabase", () => ({
    forgetDeletedDatabase: mocks.forgetDeletedDatabase,
}));
vi.mock("@/hooks/useProgress", () => ({ useProgress: () => ({ progress: 45 }) }));
vi.mock("@mantine/notifications", () => ({
    notifications: { show: mocks.notify, hide: mocks.notifyHide },
}));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    warnSafely: mocks.warn,
}));
vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options),
    }),
}));
vi.mock("@/i18n", async (original) => ({
    ...(await original<typeof import("@/i18n")>()),
    default: {
        t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options),
    },
}));

import {
    closeOnlineOpponentModal,
    enterOnlineOpponent,
    onlineOpponentDownloadAtom,
} from "./onlineOpponent";
import OnlineOpponentDownload from "./OnlineOpponentDownload";
import * as opponentImport from "./opponentImport";
import { runOpponentImport } from "./opponentImport";
import { reportOpponentImport } from "./opponentImportNotice";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
installInlineComputedStyleStub();

const ROOT = { id: { id: "db-root" }, kind: "databaseRoot" } as const;
const ID = "11111111-1111-4111-8111-111111111111";
const DB_FILENAME = `opponent-${ID}-0a1b2c3d.db3`;
const DB_FILE: DatabaseHandle = { id: { id: "opponent-db-1" }, kind: "database" };
const LICHESS: OpponentAccount = { provider: "lichess", username: "DrNykterstein" };
const CHESSCOM: OpponentAccount = { provider: "chesscom", username: "DrNykterstein" };

function successDatabase(
    filename = DB_FILENAME,
    file: DatabaseHandle = DB_FILE,
): SuccessDatabaseInfo {
    return {
        type: "success",
        file,
        filename,
        title: "DrNykterstein (online)",
        description: "",
        player_count: 2,
        event_count: 1,
        game_count: 12,
        storage_size: "1024",
        indexed: false,
    };
}

function makeListing(overrides: Partial<DatabaseList> = {}): DatabaseList {
    return {
        databases: [],
        unread: [],
        workspaceFilenames: [],
        root: ROOT,
        ...overrides,
    };
}

function makeLink(overrides: Partial<OpponentLink> = {}): OpponentLink {
    return {
        id: ID,
        playerName: "DrNykterstein",
        accounts: [LICHESS],
        filter: defaultOpponentFilter(),
        ...overrides,
    };
}

function importedOutcome(
    account: OpponentAccount,
    games = 5,
    merged = true,
): OpponentImportOutcome {
    return { kind: "imported", database: DB_FILE, accounts: [{ account, games }], merged };
}

let store: ReturnType<typeof createStore>;
let navigate: ReturnType<typeof vi.fn<(target: DatabaseRouteTarget) => unknown>>;
let mutateCache: ScopedMutator;
let t: Awaited<ReturnType<typeof catalogueI18n>>["t"];
let pendingSettlements: Array<() => void> = [];
let modalMount: { root: Root; container: HTMLDivElement } | null = null;

function deps() {
    return { store, navigate, mutateCache, t };
}

async function mountDownloadModal(): Promise<void> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    modalMount = { root, container };
    await act(async () =>
        root.render(
            createElement(
                MantineProvider,
                { env: "test" },
                createElement(Provider, { store }, createElement(OnlineOpponentDownload)),
            ),
        ),
    );
}

beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    pendingSettlements = [];
    modalMount = null;
    const i18n = await catalogueI18n("en-US");
    t = i18n.t.bind(i18n);
    mocks.translate = (key, options) => i18n.t(key, options);
    store = createStore();
    navigate = vi.fn<(target: DatabaseRouteTarget) => unknown>();
    mutateCache = vi.fn() as unknown as ScopedMutator;
    mocks.publishDatabaseList.mockResolvedValue(makeListing());
    mocks.opponentPlayers.mockResolvedValue([{ id: 42, name: "DrNykterstein" }]);
    mocks.getDatabaseWorkspace.mockResolvedValue({ root: ROOT, displayName: "Databases" });
    mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [], unread: [] });
    mocks.deleteDatabase.mockResolvedValue(null);
    mocks.cancelDownload.mockResolvedValue(true);
    mocks.withDownloadTicket.mockImplementation((run: (ticket: string) => Promise<unknown>) =>
        run("ticket-1"),
    );
});

afterEach(async () => {
    for (const settle of pendingSettlements) settle();
    if (modalMount) {
        const { root, container } = modalMount;
        modalMount = null;
        await act(async () => root.unmount());
        container.remove();
    }
});

function deferredImport() {
    let resolve!: (outcome: OpponentImportOutcome) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<OpponentImportOutcome>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    pendingSettlements.push(() =>
        reject({ tag: "backend-error", category: "cancellation", message: "Cancellation" }),
    );
    mocks.importOpponentGames.mockReturnValueOnce(promise);
    return { resolve, reject };
}

describe("enterOnlineOpponent", () => {
    test("reports a failing listing and starts nothing; a cancelled listing is silent", async () => {
        const failure = new Error("disk error");
        mocks.publishDatabaseList.mockRejectedValueOnce(failure);

        await enterOnlineOpponent(deps(), LICHESS);

        expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ color: "danger", title: "Error" }),
        );
        expect(store.get(opponentLinksAtom)).toEqual([]);
        expect(mocks.importOpponentGames).not.toHaveBeenCalled();
        expect(store.get(onlineOpponentDownloadAtom)).toBeNull();

        mocks.notify.mockClear();
        const cancelled: ErrorPayload = {
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        };
        mocks.publishDatabaseList.mockRejectedValueOnce(cancelled);

        await enterOnlineOpponent(deps(), LICHESS);

        expect(mocks.notify).not.toHaveBeenCalled();
        expect(store.get(opponentLinksAtom)).toEqual([]);
        expect(mocks.importOpponentGames).not.toHaveBeenCalled();
    });

    describe("case 1: existing link with the account", () => {
        test("opens the card without downloading when its database is readable", async () => {
            store.set(opponentLinksAtom, [makeLink({ database: DB_FILENAME })]);
            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase()] }),
            );

            await enterOnlineOpponent(deps(), { provider: "lichess", username: "drnykterstein" });

            expect(mocks.importOpponentGames).not.toHaveBeenCalled();
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
            expect(store.get(pendingPlayerCardAtom)).toEqual({
                database: "opponent-db-1",
                playerId: 42,
                playerName: "DrNykterstein",
            });
            expect(navigate).toHaveBeenCalledExactlyOnceWith({
                to: "/databases/$databaseId",
                params: { databaseId: "opponent-db-1" },
            });
        });

        test.each([
            [
                "unreadable entry",
                makeListing({
                    databases: [
                        {
                            type: "error",
                            file: DB_FILE,
                            filename: DB_FILENAME,
                            indexed: false,
                            error: "corrupt",
                        },
                    ],
                }),
            ],
            [
                "unread file",
                makeListing({
                    databases: [],
                    unread: [{ filename: DB_FILENAME, error: "permission denied" }],
                }),
            ],
        ])(
            "reports OnlineUnavailable and stops when the database is an %s",
            async (_label, listing) => {
                store.set(opponentLinksAtom, [makeLink({ database: DB_FILENAME })]);
                mocks.publishDatabaseList.mockResolvedValue(listing);

                await enterOnlineOpponent(deps(), LICHESS);

                expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        color: "danger",
                        title: "Error",
                        message: "The online games could not be read.",
                    }),
                );
                expect(mocks.importOpponentGames).not.toHaveBeenCalled();
                expect(navigate).not.toHaveBeenCalled();
                expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
            },
        );

        test.each([
            ["never downloaded", undefined],
            ["deleted from the Library", DB_FILENAME],
        ])(
            "downloads when the existing link has a database that was %s",
            async (_label, database) => {
                await mountDownloadModal();
                store.set(opponentLinksAtom, [makeLink({ database })]);
                const { resolve } = deferredImport();

                await act(async () => {
                    await enterOnlineOpponent(deps(), LICHESS);
                });

                expect(store.get(opponentLinksAtom)).toHaveLength(1);
                expect(store.get(onlineOpponentDownloadAtom)).toBe(ID);
                await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());
                const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
                expect(request.title).toBe("DrNykterstein (online)");

                mocks.publishDatabaseList.mockResolvedValue(
                    makeListing({
                        databases: [successDatabase(request.filename)],
                    }),
                );
                await act(async () => {
                    resolve(importedOutcome(LICHESS, 7));
                });

                await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
                expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
                expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        color: "success",
                        message: "Downloaded 7 online games.",
                    }),
                );
            },
        );
    });

    describe("case 2: a link carries the account's name", () => {
        test("adds the account to the same-named link and reruns its import", async () => {
            await mountDownloadModal();
            store.set(opponentLinksAtom, [
                makeLink({ playerName: "drnykterstein", accounts: [LICHESS] }),
            ]);
            const { resolve } = deferredImport();

            await act(async () => {
                await enterOnlineOpponent(deps(), CHESSCOM);
            });

            const links = store.get(opponentLinksAtom);
            expect(links).toHaveLength(1);
            expect(links[0].id).toBe(ID);
            expect(links[0].playerName).toBe("drnykterstein");
            expect(links[0].accounts).toEqual([LICHESS, CHESSCOM]);
            expect(store.get(onlineOpponentDownloadAtom)).toBe(ID);
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());
            const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
            expect(request.accounts).toEqual([LICHESS, CHESSCOM]);
            expect(request.title).toBe("drnykterstein (online)");

            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(request.filename)] }),
            );
            await act(async () => {
                resolve(importedOutcome(CHESSCOM, 3));
            });
            await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
        });

        test("reports the limit and starts nothing when the link already has MAX_OPPONENT_ACCOUNTS", async () => {
            const fullAccounts: OpponentAccount[] = Array.from(
                { length: MAX_OPPONENT_ACCOUNTS },
                (_, index) => ({ provider: "lichess", username: `account${index}` }),
            );
            store.set(opponentLinksAtom, [
                makeLink({ playerName: "DrNykterstein", accounts: fullAccounts }),
            ]);

            await enterOnlineOpponent(deps(), CHESSCOM);

            expect(store.get(opponentLinksAtom)[0].accounts).toEqual(fullAccounts);
            expect(mocks.importOpponentGames).not.toHaveBeenCalled();
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
            expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    color: "warning",
                    message: `DrNykterstein already has ${MAX_OPPONENT_ACCOUNTS} linked accounts, the maximum allowed.`,
                }),
            );
        });

        test("refuses without changes while that link's import is running", async () => {
            store.set(opponentLinksAtom, [
                makeLink({ playerName: "DrNykterstein", accounts: [LICHESS] }),
            ]);
            const { resolve } = deferredImport();
            const running = runOpponentImport({ store, mutateCache }, ID, "DrNykterstein (online)");
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

            await enterOnlineOpponent(deps(), CHESSCOM);

            expect(store.get(opponentLinksAtom)[0].accounts).toEqual([LICHESS]);
            expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1);
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
            expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    color: "warning",
                    message:
                        "The games of DrNykterstein are being downloaded. You can add this account once it has finished.",
                }),
            );

            resolve(importedOutcome(LICHESS, 1));
            await running;
        });
    });

    describe("case 3: new opponent", () => {
        test("creates a link named like the account (site spelling) with the default filter and imports", async () => {
            await mountDownloadModal();
            const { resolve } = deferredImport();

            await act(async () => {
                await enterOnlineOpponent(deps(), LICHESS);
            });

            const links = store.get(opponentLinksAtom);
            expect(links).toHaveLength(1);
            const [created] = links;
            expect(created.playerName).toBe("DrNykterstein");
            expect(created.accounts).toEqual([LICHESS]);
            expect(created.filter).toEqual(defaultOpponentFilter());
            expect(store.get(onlineOpponentDownloadAtom)).toBe(created.id);

            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());
            const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
            expect(request.title).toBe("DrNykterstein (online)");
            expect(request.accounts).toEqual([LICHESS]);

            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(request.filename)] }),
            );
            await act(async () => {
                resolve(importedOutcome(LICHESS, 4));
            });
            await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
            expect(store.get(opponentLinksAtom)[0].database).toBe(request.filename);
        });
    });

    describe("ownership and single navigation", () => {
        test("joins a card-started run without reporting; opens card only if modal is still open", async () => {
            await mountDownloadModal();
            store.set(opponentLinksAtom, [makeLink()]);
            const { resolve } = deferredImport();
            const cardRun = runOpponentImport({ store, mutateCache }, ID, "DrNykterstein (online)");
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

            // First: entry joins while modal remains open -> opens card, never reports.
            await act(async () => {
                await enterOnlineOpponent(deps(), LICHESS);
            });
            expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1);
            expect(store.get(onlineOpponentDownloadAtom)).toBe(ID);

            const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest)
                .filename;
            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(filename)] }),
            );
            await act(async () => {
                resolve(importedOutcome(LICHESS, 6));
                await cardRun;
            });

            await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
            expect(mocks.notify).not.toHaveBeenCalled();
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
        });

        test("joined entry with closed modal neither reports nor navigates", async () => {
            await mountDownloadModal();
            store.set(opponentLinksAtom, [makeLink()]);
            const { resolve } = deferredImport();
            const cardRun = runOpponentImport({ store, mutateCache }, ID, "DrNykterstein (online)");
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

            await act(async () => {
                await enterOnlineOpponent(deps(), LICHESS);
            });
            expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
            await act(async () => {
                closeOnlineOpponentModal(store, ID);
            });
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
            expect(document.body.querySelector('[role="dialog"]')).toBeNull();

            const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest)
                .filename;
            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(filename)] }),
            );
            await act(async () => {
                resolve(importedOutcome(LICHESS, 6));
                await cardRun;
            });

            expect(navigate).not.toHaveBeenCalled();
            expect(mocks.notify).not.toHaveBeenCalled();
        });

        test.each([
            [
                "noGames",
                (resolve: (o: OpponentImportOutcome) => void) =>
                    resolve({ kind: "imported", database: null, accounts: [], merged: true }),
            ],
            [
                "accountFailed",
                (resolve: (o: OpponentImportOutcome) => void) =>
                    resolve({
                        kind: "accountFailed",
                        account: LICHESS,
                        error: {
                            tag: "backend-error",
                            category: "network",
                            message: "404",
                            remoteHttpRejection: { status: 404, authorizationSent: false },
                        },
                    }),
            ],
            [
                "failed",
                (_resolve: (o: OpponentImportOutcome) => void, reject: (e: unknown) => void) =>
                    reject({
                        tag: "backend-error",
                        category: "database",
                        message: "disk I/O",
                    } satisfies ErrorPayload),
            ],
            [
                "cancelled",
                (_resolve: (o: OpponentImportOutcome) => void, reject: (e: unknown) => void) =>
                    reject({
                        tag: "backend-error",
                        category: "cancellation",
                        message: "Cancellation",
                    } satisfies ErrorPayload),
            ],
        ] as const)(
            "joined card-started run ending %s closes the modal and reports nothing from the entry",
            async (_label, settle) => {
                await mountDownloadModal();
                store.set(opponentLinksAtom, [makeLink()]);
                const { resolve, reject } = deferredImport();
                const cardRun = runOpponentImport(
                    { store, mutateCache },
                    ID,
                    "DrNykterstein (online)",
                );
                await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

                await act(async () => {
                    await enterOnlineOpponent(deps(), LICHESS);
                });
                expect(store.get(onlineOpponentDownloadAtom)).toBe(ID);

                await act(async () => {
                    settle(resolve, reject);
                    await cardRun;
                });

                expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
                expect(mocks.notify).not.toHaveBeenCalled();
                expect(navigate).not.toHaveBeenCalled();
            },
        );

        test("requested modal that never mounted shows Open action on finish and does not navigate", async () => {
            const { resolve } = deferredImport();

            await enterOnlineOpponent(deps(), LICHESS);
            const [created] = store.get(opponentLinksAtom);
            expect(store.get(onlineOpponentDownloadAtom)).toBe(created.id);
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

            const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(request.filename)] }),
            );
            resolve(importedOutcome(LICHESS, 7));

            await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
            expect(navigate).not.toHaveBeenCalled();
            expect(store.get(onlineOpponentDownloadAtom)).toBeNull();

            const shown = mocks.notify.mock.calls[0][0] as { id?: string; message: ReactNode };
            expect(typeof shown.id).toBe("string");
            const container = document.createElement("div");
            document.body.append(container);
            const noticeRoot = createRoot(container);
            try {
                act(() => {
                    noticeRoot.render(
                        createElement(MantineProvider, { env: "test" }, shown.message),
                    );
                });
                expect(container.textContent).toContain("Downloaded 7 online games.");
                const openButton = [...container.querySelectorAll("button")].find(
                    (button) => button.textContent?.trim() === "Open",
                );
                expect(openButton).toBeDefined();
            } finally {
                act(() => noticeRoot.unmount());
                container.remove();
            }
        });

        test("continuation rejection closes the modal and reports via notifyUnlessCancelled", async () => {
            await mountDownloadModal();
            const runSpy = vi
                .spyOn(opponentImport, "runOpponentImport")
                .mockRejectedValueOnce(new Error("unexpected crash"))
                .mockRejectedValueOnce({
                    tag: "backend-error",
                    category: "cancellation",
                    message: "Cancellation",
                } satisfies ErrorPayload);
            try {
                await act(async () => {
                    await enterOnlineOpponent(deps(), LICHESS);
                });

                await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
                expect(mocks.notify).toHaveBeenCalledWith(
                    expect.objectContaining({ color: "danger", title: "Error" }),
                );
                expect(store.get(onlineOpponentDownloadAtom)).toBeNull();

                mocks.notify.mockClear();
                await act(async () => {
                    await enterOnlineOpponent(deps(), CHESSCOM);
                });
                await vi.waitFor(() => expect(store.get(onlineOpponentDownloadAtom)).toBeNull());
                expect(mocks.notify).not.toHaveBeenCalled();
            } finally {
                runSpy.mockRestore();
            }
        });

        test("two entries on one run report once and navigate once", async () => {
            await mountDownloadModal();
            const { resolve } = deferredImport();

            await act(async () => {
                await enterOnlineOpponent(deps(), LICHESS);
            });
            const [created] = store.get(opponentLinksAtom);
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1));
            await act(async () => {
                closeOnlineOpponentModal(store, created.id);
            });
            await act(async () => {
                await enterOnlineOpponent(deps(), LICHESS);
            });

            expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1);
            expect(store.get(onlineOpponentDownloadAtom)).toBe(created.id);

            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());
            const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
            mocks.publishDatabaseList.mockResolvedValue(
                makeListing({ databases: [successDatabase(request.filename)] }),
            );
            await act(async () => {
                resolve(importedOutcome(LICHESS, 9));
            });

            await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
            expect(mocks.notify).toHaveBeenCalledTimes(1);
            expect(mocks.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    color: "success",
                    message: "Downloaded 9 online games.",
                }),
            );
            expect(store.get(opponentImportsAtom).size).toBe(0);
        });
    });
});

describe("reportOpponentImport optional onOpen parameter", () => {
    function renderNotification(node: ReactNode) {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        act(() => {
            root.render(createElement(MantineProvider, { env: "test" }, node));
        });
        return {
            container,
            cleanup: () => {
                act(() => root.unmount());
                container.remove();
            },
        };
    }

    test("renders an Open action on imported when onOpen is provided and calls it on click", () => {
        const onOpen = vi.fn();
        reportOpponentImport(t, { kind: "imported", games: 2, merged: true, leftovers: 0 }, onOpen);

        expect(mocks.notify).toHaveBeenCalledOnce();
        const shown = mocks.notify.mock.calls[0][0] as { id?: string; message: ReactNode };
        expect(typeof shown.id).toBe("string");
        const { container, cleanup } = renderNotification(shown.message);
        try {
            expect(container.textContent).toContain("Downloaded 2 online games.");
            const openButton = [...container.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "Open",
            );
            expect(openButton).toBeDefined();
            act(() => openButton!.click());
            expect(mocks.notifyHide).toHaveBeenCalledExactlyOnceWith(shown.id);
            expect(onOpen).toHaveBeenCalledOnce();
        } finally {
            cleanup();
        }
    });

    test("keeps plain string message when onOpen is omitted or outcome is not imported", () => {
        reportOpponentImport(t, { kind: "imported", games: 2, merged: true, leftovers: 0 });
        expect(mocks.notify).toHaveBeenLastCalledWith({
            color: "success",
            message: "Downloaded 2 online games.",
        });

        const onOpen = vi.fn();
        reportOpponentImport(t, { kind: "noGames", leftovers: 0 }, onOpen);
        expect(mocks.notify).toHaveBeenLastCalledWith({
            color: "warning",
            message: "No game matches the period and time controls.",
        });
        expect(onOpen).not.toHaveBeenCalled();
    });
});
