import { createStore } from "jotai";
import { expect, test, vi } from "vitest";

vi.mock("@/platform/tauri", () => ({ tauri: {} }));

const file = {
    name: "File",
    handle: { id: { id: "file" }, kind: "fileWorkspace" as const },
    type: "game" as const,
    lastOpened: 1,
};
const database = {
    kind: "database" as const,
    name: "White - Black",
    database: { id: { id: "file" }, kind: "database" as const },
    gameId: 1,
    lastOpened: 2,
};
const seed = [file, database];

// Seed storage before ./atoms is first evaluated so the document snapshot hydrates on first get.
localStorage.setItem("recent-files", JSON.stringify(seed));

const { patchRecentFilesSidecar, recentFileKey, recentFilesAtom, updateRecentFilesAtom } =
    await import("./atoms");

test("recent files hydrate from localStorage on init without mounting a subscription", () => {
    const store = createStore();
    expect(store.get(recentFilesAtom)).toEqual(seed);
    patchRecentFilesSidecar({
        setRecentFiles: (update) => store.set(updateRecentFilesAtom, update),
        fileKey: recentFileKey(file),
        name: "Renamed",
        type: "repertoire",
    });
    const patched = [database, { ...file, name: "Renamed", type: "repertoire" }];
    expect(store.get(recentFilesAtom)).toEqual(patched);
    expect(JSON.parse(localStorage.getItem("recent-files")!)).toEqual(patched);
});
