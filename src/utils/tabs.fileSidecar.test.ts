import { expect, test } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { isRepertoireTab, patchFileTabsSidecar, type Tab } from "./tabs";

const handle = { id: { id: "sidecar-file" }, kind: "fileWorkspace" } as const;
const otherHandle = { id: { id: "other-file" }, kind: "fileWorkspace" } as const;

function file(overrides: Partial<FileMetadata> = {}): FileMetadata {
    return {
        type: "file",
        handle,
        name: "sample.pgn",
        numGames: 2,
        metadata: { type: "game", tags: ["keep"] },
        lastModified: 1,
        ...overrides,
    };
}

function tab(value: string, origin: Tab["gameOrigin"]): Tab {
    return { value, name: value, type: "analysis", gameOrigin: origin };
}

test("patchFileTabsSidecar updates matching file, fileDraft and temp_file origins and leaves others", () => {
    const source = file();
    const other = file({ handle: otherHandle, name: "other.pgn" });
    let tabs: Tab[] = [
        tab("file", { kind: "file", file: source, gameNumber: 0 }),
        tab("draft", { kind: "fileDraft", file: source }),
        tab("temp", { kind: "temp_file", file: source, gameNumber: 1 }),
        tab("other", { kind: "file", file: other, gameNumber: 0 }),
        tab("none", { kind: "none" }),
    ];
    const saved = patchFileTabsSidecar({
        setTabs: (update) => {
            tabs = typeof update === "function" ? update(tabs) : update;
            return true;
        },
        fileKey: fileWorkspaceKey(handle),
        name: "renamed.pgn",
        metadata: { type: "repertoire", tags: ["keep"] },
    });
    expect(saved).toBe(true);
    expect(tabs[0]!.gameOrigin).toEqual({
        kind: "file",
        gameNumber: 0,
        file: { ...source, name: "renamed.pgn", metadata: { type: "repertoire", tags: ["keep"] } },
    });
    expect(tabs[1]!.gameOrigin).toEqual({
        kind: "fileDraft",
        file: { ...source, name: "renamed.pgn", metadata: { type: "repertoire", tags: ["keep"] } },
    });
    expect(tabs[2]!.gameOrigin).toEqual({
        kind: "temp_file",
        gameNumber: 1,
        file: { ...source, name: "renamed.pgn", metadata: { type: "repertoire", tags: ["keep"] } },
    });
    expect(tabs[3]!.gameOrigin).toEqual({ kind: "file", file: other, gameNumber: 0 });
    expect(tabs[4]!.gameOrigin).toEqual({ kind: "none" });
    expect(isRepertoireTab(tabs[0])).toBe(true);
    expect(isRepertoireTab(tabs[1])).toBe(true);
    expect(isRepertoireTab(tabs[3])).toBe(false);
});

test("patchFileTabsSidecar keeps identical sidecar tabs by identity", () => {
    const source = file({ name: "same.pgn", metadata: { type: "puzzle", tags: ["a", "b"] } });
    const owner = tab("same", { kind: "file", file: source, gameNumber: 0 });
    let tabs: Tab[] = [owner];
    patchFileTabsSidecar({
        setTabs: (update) => {
            tabs = typeof update === "function" ? update(tabs) : update;
            return true;
        },
        fileKey: fileWorkspaceKey(handle),
        name: "same.pgn",
        metadata: { type: "puzzle", tags: ["a", "b"] },
    });
    expect(tabs[0]).toBe(owner);
});

test("patchFileTabsSidecar updates when only tags change", () => {
    const source = file({ metadata: { type: "game", tags: ["old"] } });
    let tabs: Tab[] = [tab("file", { kind: "file", file: source, gameNumber: 0 })];
    patchFileTabsSidecar({
        setTabs: (update) => {
            tabs = typeof update === "function" ? update(tabs) : update;
            return true;
        },
        fileKey: fileWorkspaceKey(handle),
        name: source.name,
        metadata: { type: "game", tags: ["old", "extra"] },
    });
    expect(tabs[0]!.gameOrigin).toEqual({
        kind: "file",
        gameNumber: 0,
        file: { ...source, metadata: { type: "game", tags: ["old", "extra"] } },
    });
});

test("patchFileTabsSidecar updates when tags change at equal length", () => {
    const source = file({ metadata: { type: "game", tags: ["old"] } });
    let tabs: Tab[] = [tab("file", { kind: "file", file: source, gameNumber: 0 })];
    patchFileTabsSidecar({
        setTabs: (update) => {
            tabs = typeof update === "function" ? update(tabs) : update;
            return true;
        },
        fileKey: fileWorkspaceKey(handle),
        name: source.name,
        metadata: { type: "game", tags: ["new"] },
    });
    expect(tabs[0]!.gameOrigin).toEqual({
        kind: "file",
        gameNumber: 0,
        file: { ...source, metadata: { type: "game", tags: ["new"] } },
    });
});
