import { notifications } from "@mantine/notifications";
import { createStore as createJotaiStore } from "jotai";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import { createStore } from "zustand/vanilla";
import type {
    WorkspaceSessionFixedLeaves,
    WorkspaceSessionLeafState,
    WorkspaceSessionNames,
    WorkspaceSessionQuarantineResult,
    WorkspaceSessionReadEntry,
} from "@/bindings";
import { tabsAtom } from "@/state/atoms";
import { PAGE_TABS_STORAGE_KEY, pageTabsAtom } from "@/state/pageTabs";
import { collectOriginalPathOwners } from "@/state/pathOwners";
import { readRestoreOpenTabsPreference, RESTORE_OPEN_TABS_KEY } from "@/state/restoreOpenTabs";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import {
    decodeLegacyOrCompressed,
    tabStorage,
    TREE_STORAGE_VERSION,
} from "@/state/store/tabStorage";
import { closeTreeStore, getOrCreateTreeStore, type TreeStore } from "@/state/store/tree";
import {
    MAX_WORKSPACE_TABS,
    parseStoredWorkspaceForRestore,
    WORKSPACE_STORAGE_KEY,
    type Workspace,
} from "@/state/workspace";
import type { Tab } from "@/state/workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";
import { clearWorkspaceAndUnsavedBeforeWipe } from "@/components/settings/advancedActions";
import {
    flushWorkspaceSessionNotices,
    markWorkspaceSessionRestoreFailed,
    PAGE_TABS_LEAF_KEY,
    resetWorkspaceSessionForTests,
    restoreWorkspaceSessionAtStart,
    WORKSPACE_LEAF_KEY,
    WORKSPACE_SESSION_READ_MAX_KEYS,
    WORKSPACE_SESSION_UNAVAILABLE_KEY,
    WORKSPACE_SESSION_WRITE_DELAY_MS,
    WorkspaceSessionMirror,
    type WorkspaceSessionNative,
} from "./workspaceSession";

vi.mock("@/platform/native", () => ({
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
}));

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

function fakeSessionNative() {
    const leaves = new Map<string, string>();
    const skipped = new Map<string, string>();
    const quarantined: Array<{ keys: string[] | null }> = [];
    const calls: string[] = [];
    const heldByKey = new Map<string, Deferred[]>();
    const heldRemovesByKey = new Map<string, Deferred[]>();
    const failWriteKeys = new Set<string>();
    const holdRemoveKeys = new Set<string>();
    let failRemoveCount = 0;
    let failReadFixed: unknown;
    let failQuarantine: unknown;
    let quarantineFailedKeys: string[] = [];
    let holdKeys = new Set<string>();
    let holdAllWrites = false;

    const stateOf = (key: string): WorkspaceSessionLeafState => {
        if (skipped.has(key)) return { kind: "skipped", reason: skipped.get(key)! };
        if (leaves.has(key)) return { kind: "record", content: leaves.get(key)! };
        return { kind: "absent" };
    };

    const native: WorkspaceSessionNative = {
        writeLeaf: async (key, content) => {
            calls.push(`write:${key}`);
            if (failWriteKeys.has(key)) throw new Error(`write failed: ${key}`);
            if (holdAllWrites || holdKeys.has(key)) {
                await new Promise<void>((resolve, reject) => {
                    const list = heldByKey.get(key) ?? [];
                    list.push({ resolve, reject });
                    heldByKey.set(key, list);
                });
            }
            leaves.set(key, content);
        },
        readFixed: async (): Promise<WorkspaceSessionFixedLeaves> => {
            calls.push("readFixed");
            if (failReadFixed) throw failReadFixed;
            return {
                workspace: stateOf(WORKSPACE_LEAF_KEY),
                pageTabs: stateOf(PAGE_TABS_LEAF_KEY),
            };
        },
        readLeaves: async (keys): Promise<WorkspaceSessionReadEntry[]> => {
            calls.push(`readLeaves:${keys.join(",")}`);
            return keys.map((key) => ({ key, state: stateOf(key) }));
        },
        listNames: async (): Promise<WorkspaceSessionNames> => {
            calls.push("listNames");
            const names = [...new Set([...leaves.keys(), ...skipped.keys()])]
                .filter((k) => k !== WORKSPACE_LEAF_KEY && k !== PAGE_TABS_LEAF_KEY)
                .sort();
            return { names, omitted: 0 };
        },
        removeLeaf: async (key) => {
            calls.push(`remove:${key}`);
            if (holdRemoveKeys.has(key)) {
                await new Promise<void>((resolve, reject) => {
                    const list = heldRemovesByKey.get(key) ?? [];
                    list.push({ resolve, reject });
                    heldRemovesByKey.set(key, list);
                });
            }
            if (failRemoveCount > 0) {
                failRemoveCount -= 1;
                throw new Error("remove refused");
            }
            leaves.delete(key);
            skipped.delete(key);
        },
        quarantine: async (keys): Promise<WorkspaceSessionQuarantineResult> => {
            calls.push(`quarantine:${keys === null ? "all" : keys.join(",")}`);
            quarantined.push({ keys });
            if (failQuarantine) throw failQuarantine;
            const targets =
                keys === null ? [...new Set([...leaves.keys(), ...skipped.keys()])] : keys;
            const moved: string[] = [];
            const failed: Array<{ key: string; reason: string }> = [];
            for (const key of targets) {
                if (quarantineFailedKeys.includes(key)) {
                    failed.push({ key, reason: "rename failed" });
                } else if (leaves.has(key) || skipped.has(key)) {
                    leaves.delete(key);
                    skipped.delete(key);
                    moved.push(key);
                }
            }
            return {
                bucket: moved.length > 0 || failed.length > 0 ? "quarantine-test" : null,
                moved,
                failed,
            };
        },
        clear: async () => {
            calls.push("clear");
            leaves.clear();
            skipped.clear();
            return [];
        },
    };

    return {
        native,
        leaves,
        skipped,
        quarantined,
        calls,
        failWriteKeys,
        setFailRemoveCount: (n: number) => {
            failRemoveCount = n;
        },
        setFailReadFixed: (err: unknown) => {
            failReadFixed = err;
        },
        setFailQuarantine: (err: unknown) => {
            failQuarantine = err;
        },
        setQuarantineFailedKeys: (keys: string[]) => {
            quarantineFailedKeys = keys;
        },
        holdKey: (key: string) => holdKeys.add(key),
        holdRemoveKey: (key: string) => holdRemoveKeys.add(key),
        rejectRemoveKey: (key: string, error: Error) => {
            holdRemoveKeys.delete(key);
            for (const d of heldRemovesByKey.get(key)?.splice(0) ?? []) d.reject(error);
        },
        holdAll: () => {
            holdAllWrites = true;
        },
        releaseKey: (key: string) => {
            holdKeys.delete(key);
            for (const d of heldByKey.get(key)?.splice(0) ?? []) d.resolve();
        },
        releaseAll: () => {
            holdAllWrites = false;
            holdKeys.clear();
            for (const list of heldByKey.values()) {
                for (const d of list.splice(0)) d.resolve();
            }
        },
    };
}

function encodedTree(opts: { dirty?: boolean; appendAttempted?: boolean; comment?: string } = {}) {
    const tree = defaultTree();
    tree.dirty = opts.dirty ?? false;
    tree.appendAttempted = opts.appendAttempted ?? false;
    if (opts.comment) tree.root.comment = opts.comment;
    return serializeStorageValue({ version: TREE_STORAGE_VERSION, state: tree });
}

function analysisTab(id = crypto.randomUUID(), name = "Game"): Tab {
    return { value: id, name, type: "analysis", gameOrigin: { kind: "none" } };
}

function newTab(id = crypto.randomUUID()): Tab {
    return { value: id, name: "Tab.NewTab", type: "new", gameOrigin: { kind: "none" } };
}

function workspacePayload(tabs: Tab[], activeTab: string | null = tabs[0]?.value ?? null): string {
    const ws: Workspace = { version: 1, tabs, activeTab };
    return serializeStorageValue(ws);
}

function treeStore(dirty = false): TreeStore {
    return createStore(() => ({ ...defaultTree(), dirty })) as unknown as TreeStore;
}

beforeAll(async () => {
    await i18n.init({
        lng: "en-US",
        resources: { "en-US": { translation: enUSCatalogue.translation } },
    });
});

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    resetWorkspaceSessionForTests();
});

afterEach(() => {
    resetWorkspaceSessionForTests();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// O2: Session mirror crash-point ordering & confirmation

test("mirror lists a new tab in durable workspace only after its tree leaf is durable, and failed first tree write does not block other tabs", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const notify = vi.fn();
    const idOk = crypto.randomUUID();
    const idFail = crypto.randomUUID();
    const tabOk = analysisTab(idOk, "Good");
    const tabFail = analysisTab(idFail, "Bad");

    fake.failWriteKeys.add(idFail);
    sessionStorage.setItem(idOk, encodedTree({ dirty: true }));
    sessionStorage.setItem(idFail, encodedTree({ dirty: true }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tabOk, tabFail], idOk));
    jotai.set(tabsAtom, [tabOk, tabFail]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify,
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await vi.advanceTimersByTimeAsync(WORKSPACE_SESSION_WRITE_DELAY_MS);
    await mirror.drain();

    expect(fake.leaves.has(idOk)).toBe(true);
    expect(fake.leaves.has(idFail)).toBe(false);
    expect(mirror.isConfirmed(idOk)).toBe(true);
    expect(mirror.isConfirmed(idFail)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    // Durable workspace lists tabOk and omits tabFail.
    const durableWs = parseStoredWorkspaceForRestore(fake.leaves.get(WORKSPACE_LEAF_KEY)!)!;
    expect(durableWs.tabs.map((t) => t.value)).toEqual([idOk]);
    mirror.stop();
});

test("already-durable tab stays listed in durable workspace while a newer tree write is pending or failed (R20)", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id, "Durable");
    const v1 = encodedTree({ dirty: true, comment: "v1" });
    sessionStorage.setItem(id, v1);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));
    jotai.set(tabsAtom, [tab]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();
    expect(mirror.isConfirmed(id)).toBe(true);
    expect(fake.leaves.get(id)).toBe(v1);

    // Subsequent edit fails to write: tab becomes unconfirmed, but stays listed in durable workspace!
    fake.failWriteKeys.add(id);
    const v2 = encodedTree({ dirty: true, comment: "v2" });
    sessionStorage.setItem(id, v2);
    const tab2 = newTab();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab, tab2], id));
    jotai.set(tabsAtom, [tab, tab2]);

    await mirror.drain();
    expect(mirror.isConfirmed(id)).toBe(false);
    expect(fake.leaves.get(id)).toBe(v1);
    const durableWs = parseStoredWorkspaceForRestore(fake.leaves.get(WORKSPACE_LEAF_KEY)!)!;
    expect(durableWs.tabs.map((t) => t.value)).toEqual([id, tab2.value]);
    mirror.stop();
});

test("tree leaf is removed only after durable workspace drops it, and failed removes retry with backoff", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id);
    sessionStorage.setItem(id, encodedTree({ dirty: false }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));
    jotai.set(tabsAtom, [tab]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();
    expect(fake.leaves.has(id)).toBe(true);

    // Hold workspace write and fail remove once.
    fake.holdKey(WORKSPACE_LEAF_KEY);
    fake.setFailRemoveCount(1);
    sessionStorage.removeItem(id);
    const replacement = newTab();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([replacement]));
    jotai.set(tabsAtom, [replacement]);
    await vi.advanceTimersByTimeAsync(0);

    // While workspace write is still in flight, tree leaf MUST NOT be removed yet.
    expect(fake.calls.some((c) => c === `remove:${id}`)).toBe(false);
    expect(fake.leaves.has(id)).toBe(true);

    // Release workspace write -> first remove attempt runs and fails, leaf stays until backoff retry.
    fake.releaseKey(WORKSPACE_LEAF_KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c === `remove:${id}`)).toHaveLength(1);
    expect(fake.leaves.has(id)).toBe(true);

    // Retry after 1000ms succeeds.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.leaves.has(id)).toBe(false);
    mirror.stop();
});

test("undecodable tree bytes are preserved byte-for-byte in the durable store", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id);
    const rawCorrupt = "<<<corrupt-undecodable-bytes>>>";
    sessionStorage.setItem(id, rawCorrupt);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));
    jotai.set(tabsAtom, [tab]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();

    expect(fake.leaves.get(id)).toBe(rawCorrupt);
    expect(mirror.isConfirmed(id)).toBe(true);
    mirror.stop();
});

test("isConfirmed is false when tabStorage has a pending or failed write (R5)", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id);
    const store = treeStore(false);
    sessionStorage.setItem(id, encodedTree({ dirty: false }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));
    jotai.set(tabsAtom, [tab]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => store,
    });
    mirror.start();
    await mirror.drain();
    expect(mirror.isConfirmed(id)).toBe(true);

    // Queue a pending write in tabStorage and fail flush via sessionStorage.setItem throwing.
    tabStorage.write(id, {
        version: TREE_STORAGE_VERSION,
        state: { ...defaultTree(), dirty: true },
    });
    expect(tabStorage.hasPendingOrFailedWrite(id)).toBe(true);
    expect(mirror.isConfirmed(id)).toBe(false);

    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
    });
    try {
        const drainResult = await mirror.drain();
        expect(drainResult.finished).toBe(false);
        expect(tabStorage.hasPendingOrFailedWrite(id)).toBe(true);
        expect(mirror.isConfirmed(id)).toBe(false);
    } finally {
        setSpy.mockRestore();
        tabStorage.remove(id);
        mirror.stop();
    }
});

// ---------------------------------------------------------------------------------------------
// O3: Startup restore

test("reload skips restore; empty store is a silent no-op", async () => {
    const fake = fakeSessionNative();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([newTab()]));

    const reload = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        sampleFresh: () => ({ fresh: false, unreadable: false }),
    });
    expect(reload).toEqual({ kind: "skipped", reason: "reload" });
    expect(fake.calls).toEqual([]);

    sessionStorage.clear();
    const empty = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(empty).toEqual({ kind: "empty" });
    const notices: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices.push(msg));
    expect(notices).toEqual([]);
});

test("missing or invalid workspace leaf with other leaves present quarantines all and notifies", async () => {
    const fake = fakeSessionNative();
    const orphanId = crypto.randomUUID();
    fake.leaves.set(orphanId, encodedTree({ dirty: true }));
    fake.leaves.set(WORKSPACE_LEAF_KEY, "not-valid-workspace");

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result).toEqual({ kind: "quarantined", storeUnavailable: false });
    expect(fake.quarantined).toEqual([{ keys: null }]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();

    const notices: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices.push(msg));
    expect(notices).toEqual([enUSCatalogue.translation["WorkspaceSession.Quarantined"]]);
});

test("skipped tree leaf is omitted, quarantined and counted; absent tree leaf keeps absent-tree behaviour", async () => {
    const fake = fakeSessionNative();
    const idOk = crypto.randomUUID();
    const idSkipped = crypto.randomUUID();
    const idNew = crypto.randomUUID();
    const ws = workspacePayload(
        [analysisTab(idOk), analysisTab(idSkipped), newTab(idNew)],
        idSkipped,
    );

    fake.leaves.set(WORKSPACE_LEAF_KEY, ws);
    fake.leaves.set(idOk, encodedTree({ dirty: true, comment: "ok" }));
    fake.skipped.set(idSkipped, "not UTF-8");
    // idNew intentionally absent.

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result).toEqual({ kind: "restored", tabCount: 2, skippedCount: 1 });
    expect(fake.quarantined).toEqual([{ keys: [idSkipped] }]);
    expect(sessionStorage.getItem(idOk)).not.toBeNull();
    expect(sessionStorage.getItem(idSkipped)).toBeNull();
    expect(sessionStorage.getItem(idNew)).toBeNull();
    const seededWs = parseStoredWorkspaceForRestore(
        sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!,
    )!;
    expect(seededWs.tabs.map((t) => t.value)).toEqual([idOk, idNew]);

    const notices: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices.push(msg));
    expect(notices).toEqual([
        enUSCatalogue.translation["WorkspaceSession.SkippedTabs_one"].replace("{{count}}", "1"),
    ]);
});

test("read failure puts mirror in store-unavailable mode so earlier session is never overwritten", async () => {
    const fake = fakeSessionNative();
    fake.setFailReadFixed(new Error("permission denied"));

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result.kind).toBe("unavailable");

    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id);
    sessionStorage.setItem(id, encodedTree({ dirty: true }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab]));
    jotai.set(tabsAtom, [tab]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();
    expect(mirror.isConfirmed(id)).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("write:"))).toBe(false);
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");
    mirror.stop();

    // F7: A webview reload with the session marker still keeps the mirror in store-unavailable mode.
    const reloadResult = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: false, unreadable: false }),
    });
    expect(reloadResult).toEqual({ kind: "skipped", reason: "reload" });
    const reloadedMirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    reloadedMirror.start();
    await reloadedMirror.drain();
    expect(reloadedMirror.isConfirmed(id)).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("write:"))).toBe(false);
    reloadedMirror.stop();
});

test("seeding quota failure rolls back seeded keys, does not quarantine healthy store, and enters store-unavailable mode", async () => {
    const fake = fakeSessionNative();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([analysisTab(id1), analysisTab(id2)]));
    fake.leaves.set(id1, encodedTree({ dirty: true }));
    fake.leaves.set(id2, encodedTree({ dirty: true }));

    const origSetItem = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
    ) {
        if (key === id2) throw new DOMException("QuotaExceededError", "QuotaExceededError");
        origSetItem.call(this, key, value);
    });

    try {
        const result = await restoreWorkspaceSessionAtStart({
            native: fake.native,
            warn: () => undefined,
            sampleFresh: () => ({ fresh: true, unreadable: false }),
        });
        expect(result).toEqual({ kind: "quota-failed" });
        expect(sessionStorage.getItem(id1)).toBeNull();
        expect(sessionStorage.getItem(id2)).toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(fake.quarantined).toEqual([]);
        expect(fake.leaves.has(id1)).toBe(true);
    } finally {
        setSpy.mockRestore();
    }
});

test("setting off keeps dirty, undecodable and append-outstanding protected tabs, drops clean tabs and pageTabs, and hands them over as removal targets", async () => {
    const fake = fakeSessionNative();
    const idDirty = crypto.randomUUID();
    const idUndecodable = crypto.randomUUID();
    const idAppend = crypto.randomUUID();
    const idClean = crypto.randomUUID();

    localStorage.setItem(RESTORE_OPEN_TABS_KEY, "false");
    expect(readRestoreOpenTabsPreference()).toBe(false);

    const tabs = [
        analysisTab(idDirty, "Dirty"),
        analysisTab(idUndecodable, "Undecodable"),
        analysisTab(idAppend, "Append"),
        analysisTab(idClean, "Clean"),
    ];
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload(tabs, idClean));
    fake.leaves.set(PAGE_TABS_LEAF_KEY, serializeStorageValue(["settings"]));
    fake.leaves.set(idDirty, encodedTree({ dirty: true }));
    fake.leaves.set(idUndecodable, "corrupt-bytes");
    fake.leaves.set(idAppend, encodedTree({ dirty: false, appendAttempted: true }));
    fake.leaves.set(idClean, encodedTree({ dirty: false }));

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result).toEqual({ kind: "restored", tabCount: 3, skippedCount: 0 });
    expect(sessionStorage.getItem(idDirty)).not.toBeNull();
    expect(sessionStorage.getItem(idUndecodable)).toBe("corrupt-bytes");
    expect(sessionStorage.getItem(idAppend)).not.toBeNull();
    expect(sessionStorage.getItem(idClean)).toBeNull();
    expect(sessionStorage.getItem(PAGE_TABS_STORAGE_KEY)).toBeNull();

    // Starting the mirror writes the new workspace leaf and then removes idClean and page-tabs,
    // never removing the workspace leaf itself (R21).
    const jotai = createJotaiStore();
    jotai.set(tabsAtom, [tabs[0]!, tabs[1]!, tabs[2]!]);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();
    expect(fake.leaves.has(idClean)).toBe(false);
    expect(fake.leaves.has(PAGE_TABS_LEAF_KEY)).toBe(false);
    expect(fake.leaves.has(WORKSPACE_LEAF_KEY)).toBe(true);
    expect(fake.calls.includes(`remove:${WORKSPACE_LEAF_KEY}`)).toBe(false);
    mirror.stop();
});

test("setting off with only clean tabs seeds nothing (default workspace)", async () => {
    const fake = fakeSessionNative();
    const idClean = crypto.randomUUID();
    localStorage.setItem(RESTORE_OPEN_TABS_KEY, "false");
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([analysisTab(idClean)]));
    fake.leaves.set(idClean, encodedTree({ dirty: false }));

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result).toEqual({ kind: "restored", tabCount: 0, skippedCount: 0 });
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(idClean)).toBeNull();
});

// ---------------------------------------------------------------------------------------------
// O4: Unified Clear saved data helper

test("clearWorkspaceAndUnsavedBeforeWipe clears both stores on success and resumes appropriately on each failure branch", async () => {
    const wipe = vi.fn();
    const mirror = {
        pause: vi.fn(),
        resume: vi.fn(),
        drain: vi.fn().mockResolvedValue({ finished: true }),
    };
    const sessionNative = { clear: vi.fn().mockResolvedValue([]) };
    const legacyNative = { clear: vi.fn().mockResolvedValue([]) };

    await clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe });
    expect(mirror.pause).toHaveBeenCalledOnce();
    expect(sessionNative.clear).toHaveBeenCalledOnce();
    expect(legacyNative.clear).toHaveBeenCalledOnce();
    expect(wipe).toHaveBeenCalledOnce();
    expect(mirror.resume).not.toHaveBeenCalled();

    // Drain rejecting -> keeps session, resumes with clearedCompletely: false (F8f).
    wipe.mockClear();
    mirror.resume.mockClear();
    mirror.drain.mockRejectedValueOnce(new Error("drain boom"));
    await expect(
        clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe }),
    ).rejects.toThrow(/could not be removed/);
    expect(mirror.resume).toHaveBeenCalledWith({ clearedCompletely: false });
    expect(wipe).not.toHaveBeenCalled();

    // Session clear fails -> clearedCompletely: false (keeps store-unavailable if set).
    mirror.resume.mockClear();
    sessionNative.clear.mockRejectedValueOnce(new Error("io"));
    await expect(
        clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe }),
    ).rejects.toThrow(/could not be removed/);
    expect(mirror.resume).toHaveBeenCalledWith({ clearedCompletely: false });
    expect(wipe).not.toHaveBeenCalled();

    // Session clear returns leftovers -> keeps session, clearedCompletely: false (F8f).
    mirror.resume.mockClear();
    sessionNative.clear.mockResolvedValueOnce(["leftover-session"]);
    await expect(
        clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe }),
    ).rejects.toThrow(/could not be removed/);
    expect(mirror.resume).toHaveBeenCalledWith({ clearedCompletely: false });
    expect(wipe).not.toHaveBeenCalled();

    // Session clear succeeds, legacy clear rejects -> clearedCompletely: true (F8f).
    mirror.resume.mockClear();
    legacyNative.clear.mockRejectedValueOnce(new Error("legacy io"));
    await expect(
        clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe }),
    ).rejects.toThrow(/could not be removed/);
    expect(mirror.resume).toHaveBeenCalledWith({ clearedCompletely: true });
    expect(wipe).not.toHaveBeenCalled();

    // Session clear succeeds, legacy clear has leftovers -> clearedCompletely: true (R26).
    mirror.resume.mockClear();
    legacyNative.clear.mockResolvedValueOnce(["leftover-id"]);
    await expect(
        clearWorkspaceAndUnsavedBeforeWipe({ mirror, sessionNative, legacyNative, wipe }),
    ).rejects.toThrow(/could not be removed/);
    expect(mirror.resume).toHaveBeenCalledWith({ clearedCompletely: true });
    expect(wipe).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------------------------
// F8: Additional regression tests (b, c, d, e, F2, F3, F5, F6, F10)

test("sampleFreshProcess -> workspaceStartedFresh handoff preserves fresh start across seeding and fails closed on unreadable storage (F8b)", async () => {
    vi.resetModules();
    const tabsMod = await import("@/state/atoms");
    expect(tabsMod.sampleFreshProcess(sessionStorage)).toEqual({ fresh: true, unreadable: false });
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([newTab()]));
    tabsMod.initializeWorkspace();
    expect(tabsMod.workspaceStartedFresh()).toBe(true);

    vi.resetModules();
    const tabsUnreadable = await import("@/state/atoms");
    const unreadableStorage = {
        getItem: () => {
            throw new DOMException("blocked", "SecurityError");
        },
    };
    expect(tabsUnreadable.sampleFreshProcess(unreadableStorage)).toEqual({
        fresh: false,
        unreadable: true,
    });
    expect(tabsUnreadable.workspaceStartedFresh()).toBe(false);
});

test("WorkspaceSessionMirror.resume keeps store-unavailable unless clearedCompletely and rewrites all mirrored keys (F8c)", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const idDirty = crypto.randomUUID();
    const idClean = crypto.randomUUID();
    const tabDirty = analysisTab(idDirty, "Dirty");
    const tabClean = analysisTab(idClean, "Clean");
    sessionStorage.setItem(idDirty, encodedTree({ dirty: true }));
    sessionStorage.setItem(idClean, encodedTree({ dirty: false }));
    sessionStorage.setItem(PAGE_TABS_STORAGE_KEY, serializeStorageValue(["settings"]));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tabDirty, tabClean], idDirty));
    sessionStorage.setItem(WORKSPACE_SESSION_UNAVAILABLE_KEY, "1");
    jotai.set(tabsAtom, [tabDirty, tabClean]);

    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
        storeUnavailable: true,
    });
    mirror.start();
    mirror.pause();
    mirror.resume({ clearedCompletely: false });
    await mirror.drain();
    expect(fake.calls.some((c) => c.startsWith("write:"))).toBe(false);
    expect(mirror.isConfirmed(idDirty)).toBe(false);
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");

    mirror.pause();
    mirror.resume({ clearedCompletely: true });
    await mirror.drain();
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBeNull();
    expect(fake.leaves.get(idDirty)).toBe(sessionStorage.getItem(idDirty));
    expect(fake.leaves.get(idClean)).toBe(sessionStorage.getItem(idClean));
    expect(fake.leaves.get(PAGE_TABS_LEAF_KEY)).toBe(sessionStorage.getItem(PAGE_TABS_STORAGE_KEY));
    expect(fake.leaves.has(WORKSPACE_LEAF_KEY)).toBe(true);
    expect(mirror.isConfirmed(idDirty)).toBe(true);
    expect(mirror.isConfirmed(idClean)).toBe(true);
    mirror.stop();
});

test("quarantine throwing, partial quarantine failure, and skipped page-tabs quarantine failure enter store-unavailable mode with notice (F5, F8d)", async () => {
    // 1. Quarantine throws on invalid workspace.
    const fakeThrow = fakeSessionNative();
    fakeThrow.leaves.set(WORKSPACE_LEAF_KEY, "corrupt");
    fakeThrow.setFailQuarantine(new Error("quarantine io"));
    const resThrow = await restoreWorkspaceSessionAtStart({
        native: fakeThrow.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(resThrow).toEqual({ kind: "quarantined", storeUnavailable: true });
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");

    // 2. Quarantine returns partial failed keys.
    sessionStorage.clear();
    resetWorkspaceSessionForTests();
    const fakePartial = fakeSessionNative();
    const idBad = crypto.randomUUID();
    fakePartial.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([analysisTab(idBad)]));
    fakePartial.skipped.set(idBad, "not UTF-8");
    fakePartial.setQuarantineFailedKeys([idBad]);
    await restoreWorkspaceSessionAtStart({
        native: fakePartial.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");

    // 3. F5: Skipped page-tabs leaf with failed quarantine queues a notice even with 0 skipped tree keys.
    sessionStorage.clear();
    resetWorkspaceSessionForTests();
    const fakePageTabs = fakeSessionNative();
    const idGood = crypto.randomUUID();
    fakePageTabs.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([analysisTab(idGood)]));
    fakePageTabs.leaves.set(idGood, encodedTree({ dirty: false }));
    fakePageTabs.skipped.set(PAGE_TABS_LEAF_KEY, "not UTF-8");
    fakePageTabs.setFailQuarantine(new Error("rename denied"));
    await restoreWorkspaceSessionAtStart({
        native: fakePageTabs.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    const notices: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices.push(msg));
    expect(notices).toHaveLength(1);
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");
});

test("first dirty transition on a real persisted TreeStore created after start flushes and writes the new dirty state immediately (G1, F2, F3)", async () => {
    const fake = fakeSessionNative();
    const idRestored = crypto.randomUUID();
    const idLeftover = crypto.randomUUID();
    const tabRestored = analysisTab(idRestored, "Restored");
    const restoredTree = encodedTree({ dirty: false, comment: "before-edit" });
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([tabRestored], idRestored));
    fake.leaves.set(idRestored, restoredTree);
    fake.leaves.set(idLeftover, encodedTree({ dirty: false }));

    await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });

    const jotai = createJotaiStore();
    jotai.set(tabsAtom, [tabRestored]);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
    });
    mirror.start();

    try {
        // F3: Leftover UUID is removed on start without waiting for a workspace write.
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.leaves.has(idLeftover)).toBe(false);

        // G1 + F2: Real persisted TreeStore created AFTER mirror.start() writes the NEW dirty
        // state immediately (delay 0, strictly below WORKSPACE_SESSION_WRITE_DELAY_MS).
        const realStore = getOrCreateTreeStore(idRestored);
        realStore.getState().setComment("dirty-edit");
        await vi.advanceTimersByTimeAsync(0);

        const durableRaw = fake.leaves.get(idRestored);
        expect(durableRaw).toBeDefined();
        const decoded = decodeLegacyOrCompressed(durableRaw!);
        expect(decoded?.state.dirty).toBe(true);
        expect(decoded?.state.root.comment).toBe("dirty-edit");
    } finally {
        mirror.stop();
        closeTreeStore(idRestored);
    }
});

test("dirty + close in one synchronous turn still removes the leaf after the durable workspace drops it, and a failing flush on first dirty edit still notifies (H1, H2)", async () => {
    // H1: dirty + close in the same synchronous turn must not cancel removal.
    const fake = fakeSessionNative();
    const id = crypto.randomUUID();
    const tab = analysisTab(id, "DirtyThenClosed");
    const initialTree = encodedTree({ dirty: false });
    sessionStorage.setItem(id, initialTree);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));

    const jotai = createJotaiStore();
    jotai.set(tabsAtom, [tab]);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
    });
    mirror.start();
    const store = getOrCreateTreeStore(id);
    await mirror.drain();
    expect(fake.leaves.has(id)).toBe(true);

    const replacement = newTab();
    try {
        // Turn dirty and close synchronously in one turn.
        store.getState().setComment("dirty-before-close");
        sessionStorage.removeItem(id);
        sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([replacement]));
        jotai.set(tabsAtom, [replacement]);

        await vi.advanceTimersByTimeAsync(0);
        await mirror.drain();
        expect(fake.leaves.has(id)).toBe(false);
    } finally {
        mirror.stop();
        closeTreeStore(id);
    }

    // H2: A failing flush on the first dirty edit still reports through notifications.show.
    const idQuota = crypto.randomUUID();
    const tabQuota = analysisTab(idQuota, "QuotaTab");
    sessionStorage.setItem(idQuota, encodedTree({ dirty: false }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tabQuota], idQuota));
    jotai.set(tabsAtom, [tabQuota]);
    const mirrorQuota = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
    });
    mirrorQuota.start();
    const quotaStore = getOrCreateTreeStore(idQuota);
    const showSpy = vi.spyOn(notifications, "show").mockImplementation(() => "");
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    try {
        quotaStore.getState().setComment("trigger-quota-error");
        await vi.advanceTimersByTimeAsync(0);
        expect(showSpy).toHaveBeenCalled();
    } finally {
        setSpy.mockRestore();
        showSpy.mockRestore();
        mirrorQuota.stop();
        tabStorage.remove(idQuota);
        closeTreeStore(idQuota);
    }
});

test("generation guard ignores a late first tree write after close, and stop schedules no retry timer on an in-flight remove rejection (G4, H3b)", async () => {
    const fake = fakeSessionNative();
    const jotai = createJotaiStore();
    const idClosing = crypto.randomUUID();
    const tabClosing = analysisTab(idClosing, "Closing");
    const firstTree = encodedTree({ dirty: true, comment: "first-write-in-flight" });
    sessionStorage.setItem(idClosing, firstTree);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tabClosing], idClosing));
    jotai.set(tabsAtom, [tabClosing]);

    // H3(b): Hold the tab's VERY FIRST tree write in flight before it is ever durable.
    fake.holdKey(idClosing);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toContain(`write:${idClosing}`);
    expect(mirror.isConfirmed(idClosing)).toBe(false);

    // Close the tab while its first tree write is still in flight.
    const replacement = newTab();
    sessionStorage.removeItem(idClosing);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([replacement]));
    jotai.set(tabsAtom, [replacement]);
    await vi.advanceTimersByTimeAsync(0);

    // Watch confirmed-change notifications while releasing the stale in-flight write:
    // the generation guard must prevent marking it durable or triggering another workspace write.
    const confirmedEvents = vi.fn();
    const unsub = mirror.onConfirmedChange(confirmedEvents);
    fake.releaseKey(idClosing);
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
    expect(confirmedEvents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unsub();

    await mirror.drain();
    const durableWs = parseStoredWorkspaceForRestore(fake.leaves.get(WORKSPACE_LEAF_KEY)!)!;
    expect(durableWs.tabs.map((t) => t.value)).toEqual([replacement.value]);
    expect(fake.leaves.has(idClosing)).toBe(false);
    expect(mirror.isConfirmed(idClosing)).toBe(false);

    // G4(b): Make removeLeaf genuinely in flight, call stop(), reject it, assert 0 retry timers.
    const idStop = crypto.randomUUID();
    const tabStop = analysisTab(idStop, "StopTab");
    sessionStorage.setItem(idStop, encodedTree({ dirty: false }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tabStop]));
    jotai.set(tabsAtom, [tabStop]);
    await mirror.drain();

    fake.holdRemoveKey(idStop);
    sessionStorage.removeItem(idStop);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([replacement]));
    jotai.set(tabsAtom, [replacement]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toContain(`remove:${idStop}`);

    mirror.stop();
    fake.rejectRemoveKey(idStop, new Error("remove failed after stop"));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
});

test("markWorkspaceSessionRestoreFailed sets storeUnavailable, persists marker, queues notice, and survives a throwing sessionStorage getter (G2, H3c)", async () => {
    const fake = fakeSessionNative();
    markWorkspaceSessionRestoreFailed(new Error("boom"), sessionStorage);
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBe("1");
    const notices: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices.push(msg));
    expect(notices).toHaveLength(1);

    const jotai = createJotaiStore();
    const id = crypto.randomUUID();
    const tab = analysisTab(id);
    sessionStorage.setItem(id, encodedTree({ dirty: true }));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab]));
    jotai.set(tabsAtom, [tab]);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    await mirror.drain();
    expect(mirror.isConfirmed(id)).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("write:"))).toBe(false);
    mirror.stop();

    // H3(c): Clear WORKSPACE_SESSION_UNAVAILABLE_KEY before the throwing-getter subtest so the
    // assertion depends solely on startupHandoff.storeUnavailable set by the function itself.
    sessionStorage.removeItem(WORKSPACE_SESSION_UNAVAILABLE_KEY);
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBeNull();
    resetWorkspaceSessionForTests();
    const origDesc = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
    Object.defineProperty(globalThis, "sessionStorage", {
        get() {
            throw new DOMException("blocked", "SecurityError");
        },
        configurable: true,
    });
    try {
        expect(() => markWorkspaceSessionRestoreFailed(new Error("boom2"))).not.toThrow();
    } finally {
        Object.defineProperty(globalThis, "sessionStorage", origDesc);
    }
    expect(sessionStorage.getItem(WORKSPACE_SESSION_UNAVAILABLE_KEY)).toBeNull();
    const notices2: string[] = [];
    flushWorkspaceSessionNotices((msg) => notices2.push(msg));
    expect(notices2).toHaveLength(1);
    const mirror2 = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror2.start();
    await mirror2.drain();
    expect(mirror2.isConfirmed(id)).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("write:"))).toBe(false);
    mirror2.stop();
});

test("on reload start, closing a tab does not remove its tree leaf even when drain triggers startEligibleRemovals while the first workspace write is held (G3, H3a)", async () => {
    const fake = fakeSessionNative();
    const id = crypto.randomUUID();
    const tab = analysisTab(id, "Reloaded");
    const tree = encodedTree({ dirty: false });
    sessionStorage.setItem(id, tree);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([tab], id));
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([tab], id));
    fake.leaves.set(id, tree);

    const res = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: false, unreadable: false }),
    });
    expect(res).toEqual({ kind: "skipped", reason: "reload" });

    const jotai = createJotaiStore();
    jotai.set(tabsAtom, [tab]);
    fake.holdKey(WORKSPACE_LEAF_KEY);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();

    // Close the tab while the session's first workspace write is held, then call drain(50) which
    // explicitly invokes startEligibleRemovals(true): with durableWorkspaceSynced=false, removeLeaf
    // must NOT run until the workspace write finishes.
    const replacement = newTab();
    sessionStorage.removeItem(id);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePayload([replacement]));
    jotai.set(tabsAtom, [replacement]);
    const drainPromise = mirror.drain(50);
    await vi.advanceTimersByTimeAsync(50);
    await drainPromise;
    expect(fake.calls.includes(`remove:${id}`)).toBe(false);
    expect(fake.leaves.has(id)).toBe(true);

    // Once the workspace write commits durably, removal runs.
    fake.releaseKey(WORKSPACE_LEAF_KEY);
    await mirror.drain();
    expect(fake.leaves.has(id)).toBe(false);
    mirror.stop();
});

test("MAX_WORKSPACE_TABS fits within WORKSPACE_SESSION_READ_MAX_KEYS so restore reads in one request (G5)", () => {
    expect(MAX_WORKSPACE_TABS).toBeLessThanOrEqual(WORKSPACE_SESSION_READ_MAX_KEYS);
});

test("seeded file and database tabs are retained by collectOriginalPathOwners and pageTabs mirror", async () => {
    const fake = fakeSessionNative();
    const fileTabId = crypto.randomUUID();
    const dbTabId = crypto.randomUUID();
    const fileTab: Tab = {
        value: fileTabId,
        name: "repertoire.pgn",
        type: "analysis",
        gameOrigin: {
            kind: "file",
            file: {
                type: "file",
                handle: { id: { id: "file-handle-1" }, kind: "fileWorkspace" },
                name: "repertoire.pgn",
                numGames: 1,
                metadata: { type: "game", tags: [] },
                lastModified: 1,
            },
            gameNumber: 0,
        },
    };
    const dbTab: Tab = {
        value: dbTabId,
        name: "master.db3",
        type: "analysis",
        gameOrigin: {
            kind: "database",
            database: { id: { id: "db-handle-1" }, kind: "database" },
            gameId: 42,
        },
    };

    localStorage.setItem(RESTORE_OPEN_TABS_KEY, "true");
    fake.leaves.set(WORKSPACE_LEAF_KEY, workspacePayload([fileTab, dbTab], fileTabId));
    fake.leaves.set(fileTabId, encodedTree({ dirty: true }));
    fake.leaves.set(dbTabId, encodedTree({ dirty: false }));

    const result = await restoreWorkspaceSessionAtStart({
        native: fake.native,
        warn: () => undefined,
        sampleFresh: () => ({ fresh: true, unreadable: false }),
    });
    expect(result).toEqual({ kind: "restored", tabCount: 2, skippedCount: 0 });

    const owners = collectOriginalPathOwners(localStorage, sessionStorage);
    const retainedIds = owners.retainedIds.map((entry) => entry.id);
    expect(retainedIds).toContain("file-handle-1");
    expect(retainedIds).toContain("db-handle-1");
    expect(owners.trustedFamilies).toContain("sessionWorkspace");

    const jotai = createJotaiStore();
    jotai.set(tabsAtom, [fileTab, dbTab]);
    const mirror = new WorkspaceSessionMirror({
        native: fake.native,
        jotaiStore: jotai,
        notify: vi.fn(),
        warn: () => undefined,
        treeStoreFor: () => null,
    });
    mirror.start();
    jotai.set(pageTabsAtom, () => ["settings"]);
    await mirror.drain();
    expect(fake.leaves.get(PAGE_TABS_LEAF_KEY)).toBe(sessionStorage.getItem(PAGE_TABS_STORAGE_KEY));
    mirror.stop();
});
