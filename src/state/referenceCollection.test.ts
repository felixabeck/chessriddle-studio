import { expect, test, vi } from "vitest";
import type { CollectionDescriptor } from "@/bindings";
// Warms the transforms at collection for the dynamic imports in the reload test (f-20261102-04).
import "./atoms";
import "@/hooks/useDatabaseList";

const mocks = vi.hoisted(() => ({ getDatabases: vi.fn() }));
vi.mock("@/utils/db", () => ({ getDatabases: mocks.getDatabases }));

test("reference ownership survives reload and ignores stale or foreign workspace reconciliation", async () => {
    const atoms = await import("./atoms");
    const { getDefaultStore } = await import("jotai");
    const { fetchDatabaseList } = await import("@/hooks/useDatabaseList");
    const store = getDefaultStore();
    const controller = new AbortController();
    const owner = {
        run: <T>(request: (signal: AbortSignal) => Promise<T>) => request(controller.signal),
        supersede: async () => {},
    };
    const workspace = { id: { id: "reference-library" }, kind: "fileWorkspace" as const };
    const database = { id: { id: "reference-index" }, kind: "database" as const };
    const collection: CollectionDescriptor = {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Games",
        file: workspace,
        database,
        account: null,
        status: "trashed",
        generation: "",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
    };
    store.set(atoms.fileWorkspaceAtom, workspace);
    store.set(atoms.referenceDbAtom, database);
    mocks.getDatabases.mockResolvedValue({ collections: [collection] });
    await fetchDatabaseList(owner);
    expect(store.get(atoms.referenceDbAtom)).toEqual(database);
    vi.resetModules();
    const reloaded = await import("./atoms");
    const { getDefaultStore: reloadedStore } = await import("jotai");
    const { fetchDatabaseList: reloadList } = await import("@/hooks/useDatabaseList");
    const next = reloadedStore();
    const unmount = next.sub(reloaded.referenceDbAtom, () => {});
    next.set(reloaded.fileWorkspaceAtom, workspace);
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    await reloadList(owner);
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    let finish!: (value: { collections: CollectionDescriptor[] }) => void;
    mocks.getDatabases.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const foreign = reloadList(owner);
    next.set(reloaded.fileWorkspaceAtom, { ...workspace, id: { id: "foreign" } });
    finish({ collections: [] });
    await foreign;
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    next.set(reloaded.fileWorkspaceAtom, workspace);
    next.set(reloaded.referenceDbAtom, { ...database, id: { id: "stale" } });
    mocks.getDatabases.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const stale = reloadList(owner);
    next.set(reloaded.referenceDbAtom, database);
    finish({ collections: [] });
    await stale;
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    await reloadList(owner);
    mocks.getDatabases.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const aborted = reloadList(owner);
    controller.abort();
    finish({ collections: [] });
    await aborted;
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    mocks.getDatabases.mockResolvedValue({ collections: undefined });
    const liveOwner = {
        ...owner,
        run: <T>(request: (signal: AbortSignal) => Promise<T>) =>
            request(new AbortController().signal),
    };
    await reloadList(liveOwner);
    expect(next.get(reloaded.referenceDbAtom)).toEqual(database);
    mocks.getDatabases.mockResolvedValue({ collections: [] });
    await reloadList(liveOwner);
    expect(next.get(reloaded.referenceDbAtom)).toBeNull();
    unmount();
});
