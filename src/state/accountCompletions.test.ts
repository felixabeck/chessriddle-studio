import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { AccountCompletion, AccountImportRequest, DatabaseHandle } from "@/bindings";
import { accountCompletionsAtom, databaseConversionStateAtom } from "./atoms";
import {
    accountCompletionKey,
    observeAccountCompletions,
    runAccountImport,
} from "./accountCompletions";

const mocks = vi.hoisted(() => ({
    pendingAccountCompletions: vi.fn(),
    importAccountGames: vi.fn(),
    acknowledgeAccountCompletion: vi.fn(),
    completionChanged: vi.fn(),
    notifyShow: vi.fn(),
}));

vi.mock("@/platform/tauri", async (original) => ({
    ...(await original<typeof import("@/platform/tauri")>()),
    tauri: {
        pendingAccountCompletions: mocks.pendingAccountCompletions,
        importAccountGames: mocks.importAccountGames,
        acknowledgeAccountCompletion: mocks.acknowledgeAccountCompletion,
    },
    tauriSubscriptions: {
        completionChanged: mocks.completionChanged,
    },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notifyShow } }));
vi.mock("@/platform/native", () => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const database: DatabaseHandle = { id: { id: "database" }, kind: "database" };
const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" as const };
const request: AccountImportRequest = {
    provider: "chesscom",
    account: "Felix",
    accountHandle: null,
    destination: { id: "destination" },
    pendingBatch: null,
    sinceMs: null,
    target: { kind: "unlinked", database, title: "Felix Chess.com" },
};

function completion(state: "running" | "succeeded"): AccountCompletion {
    return {
        id: "account-operation",
        request,
        progressId: "opaque-download-ticket",
        attempt: 1,
        importing: state === "running",
        outcome:
            state === "succeeded"
                ? { state: "succeeded", result: { collectionNotice: false } }
                : { state: "running" },
        publication: state === "running" ? null : { handle: workspace, durability: "Durable" },
        committedDatabase: null,
        deletionPending: false,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

let store: ReturnType<typeof createStore>;
let snapshot: AccountCompletion[];
let changed: (() => void) | undefined;
let unlisten: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
    vi.resetAllMocks();
    store = createStore();
    snapshot = [];
    changed = undefined;
    unlisten = vi.fn();
    mocks.pendingAccountCompletions.mockImplementation(async () => snapshot);
    mocks.acknowledgeAccountCompletion.mockImplementation(async (id: string) => {
        snapshot = snapshot.filter((entry) => entry.id !== id || entry.deletionPending);
    });
    mocks.completionChanged.mockImplementation(async (listener: () => void) => {
        changed = listener;
        return unlisten;
    });
});

test("unlinked import clears its conversion row when the last surface unsubscribes (event first)", async () => {
    const running = completion("running");
    const succeeded = completion("succeeded");
    snapshot = [running];

    const pendingImport = deferred<AccountCompletion>();
    mocks.importAccountGames.mockReturnValue(pendingImport.promise);

    const surface = {
        refresh: vi.fn(async () => undefined),
        collectionNotice: vi.fn(),
    };
    const unsubscribe = observeAccountCompletions(store, accountCompletionKey(request), surface);
    const importPromise = runAccountImport(store, request);

    await vi.waitFor(() => {
        expect(store.get(databaseConversionStateAtom)).toEqual([
            expect.objectContaining({
                id: `conversion:${running.id}`,
                targetDatabase: database,
            }),
        ]);
    });

    unsubscribe();
    snapshot = [succeeded];

    changed?.();
    await vi.waitFor(() => {
        expect(
            store.get(accountCompletionsAtom).get(accountCompletionKey(request))?.outcome.state,
        ).toBe("succeeded");
    });
    pendingImport.resolve(succeeded);
    await importPromise;

    expect(store.get(databaseConversionStateAtom)).toEqual([]);
    expect(
        store.get(accountCompletionsAtom).get(accountCompletionKey(request))?.outcome.state,
    ).toBe("succeeded");
    expect(unlisten).toHaveBeenCalledOnce();
});

test("unlinked import clears its conversion row when the last surface unsubscribes (reply first)", async () => {
    const running = completion("running");
    const succeeded = completion("succeeded");
    snapshot = [running];

    const pendingImport = deferred<AccountCompletion>();
    mocks.importAccountGames.mockReturnValue(pendingImport.promise);

    const surface = {
        refresh: vi.fn(async () => undefined),
        collectionNotice: vi.fn(),
    };
    const unsubscribe = observeAccountCompletions(store, accountCompletionKey(request), surface);
    const importPromise = runAccountImport(store, request);

    await vi.waitFor(() => {
        expect(store.get(databaseConversionStateAtom)).toEqual([
            expect.objectContaining({
                id: `conversion:${running.id}`,
                targetDatabase: database,
            }),
        ]);
    });

    unsubscribe();
    snapshot = [succeeded];

    pendingImport.resolve(succeeded);
    await importPromise;
    changed?.();

    expect(store.get(databaseConversionStateAtom)).toEqual([]);
    expect(
        store.get(accountCompletionsAtom).get(accountCompletionKey(request))?.outcome.state,
    ).toBe("succeeded");
    expect(unlisten).toHaveBeenCalledOnce();
});

test("control case: unlinked import clears its conversion row while a surface stays subscribed", async () => {
    const running = completion("running");
    const succeeded = completion("succeeded");
    snapshot = [running];

    const pendingImport = deferred<AccountCompletion>();
    mocks.importAccountGames.mockReturnValue(pendingImport.promise);

    const surface = {
        refresh: vi.fn(async () => undefined),
        collectionNotice: vi.fn(),
    };
    const unsubscribe = observeAccountCompletions(store, accountCompletionKey(request), surface);
    const importPromise = runAccountImport(store, request);

    await vi.waitFor(() => {
        expect(store.get(databaseConversionStateAtom)).toHaveLength(1);
    });

    snapshot = [succeeded];
    changed?.();
    pendingImport.resolve(succeeded);
    await importPromise;

    expect(store.get(databaseConversionStateAtom)).toEqual([]);
    expect(store.get(accountCompletionsAtom).size).toBe(0);
    expect(surface.refresh).toHaveBeenCalledOnce();
    expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledExactlyOnceWith(succeeded.id);
    unsubscribe();
});
