import { describe, expect, test } from "vitest";
import type { CollectionDescriptor } from "@/bindings";
import type { Entry, FileMetadata } from "@/components/files/file";
import type { ManagedDatabaseInfo } from "@/utils/db";
import { fileWorkspaceKey, capabilityKey } from "@/utils/pathCapabilities";
import {
    collectionFiles,
    joinLibraryCollections,
    projectLibrary,
    standaloneDatabases,
} from "./libraryData";

function file(id: string, type: "game" | "repertoire" = "game"): FileMetadata {
    return {
        type: "file",
        name: id,
        handle: { kind: "fileWorkspace", id: { id } },
        numGames: 1,
        metadata: { type, tags: [] },
        lastModified: 100,
    };
}
function collection(
    id: string,
    status: CollectionDescriptor["status"] = "ready",
): CollectionDescriptor {
    return {
        id,
        name: id,
        file: file(id).handle,
        database: { kind: "database", id: { id: `db-${id}` } },
        status,
        generation: "1",
        account: null,
        retiredDatabase: null,
        omitted: 0,
        fetchSinceMs: null,
    };
}
function database(id: string): ManagedDatabaseInfo {
    return {
        type: "error",
        file: { kind: "database", id: { id } },
        filename: id,
        indexed: false,
        error: "unavailable",
    };
}

describe("Library projection", () => {
    test("flattens nested repertoires, joins one linked row, excludes retired and trashed collections and conversion targets, and keeps external recents", () => {
        const nested = file("twelfth", "repertoire");
        const linked = collection("linked");
        const retired = collection("retired", "retired");
        const trashed = collection("trashed", "trashed");
        const converting = collection("converting");
        const entries: Entry[] = [
            {
                type: "directory",
                name: "folder",
                handle: file("folder").handle,
                lastModified: 0,
                children: [
                    nested,
                    file("linked"),
                    file("retired"),
                    file("trashed"),
                    file("converting"),
                ],
            },
        ];
        const outside = file("outside");
        const standalone = database("standalone");
        const target = database("target");
        const result = projectLibrary({
            entries,
            collections: [linked, retired, trashed, converting],
            databases: [standalone, target, { ...database("linked-db"), collection: linked }],
            conversions: [{ targetDatabase: converting.database }, { targetDatabase: target.file }],
            recents: [
                { handle: outside.handle, name: outside.name, type: "repertoire", lastOpened: 500 },
            ],
        });
        expect(result.rows.map((row) => row.name).sort()).toEqual([
            "linked",
            "outside",
            "retired",
            "standalone",
            "twelfth",
        ]);
        expect(result.rows.filter((row) => row.kind === "collection")).toHaveLength(1);
        expect(collectionFiles(entries)).toHaveLength(5);
    });

    test("keeps a listed PGN as a file row when its only collection descriptor is retired", () => {
        const source = file("retired-source");
        const result = projectLibrary({
            entries: [source],
            collections: [collection("retired-source", "retired")],
        });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            kind: "file",
            key: fileWorkspaceKey(source.handle),
            file: source,
        });
        expect(result.rows.filter((row) => row.kind === "collection")).toEqual([]);
    });

    test("recorded opens outside the ten recents and game-table opens outrank newer never-opened files", () => {
        const outsideTen = file("outside-ten");
        const never = { ...file("never"), lastModified: 99999999 };
        const table = database("table");
        const recents = Array.from({ length: 10 }, (_, index) => ({
            name: `recent-${index}`,
            handle: file(`recent-${index}`).handle,
            type: "game" as const,
            lastOpened: index + 1,
        }));
        const result = projectLibrary({
            entries: [never, outsideTen],
            databases: [table],
            recents,
            lastOpened: {
                [fileWorkspaceKey(outsideTen.handle)]: 100,
                [capabilityKey(table.file)]: 200,
            },
        });
        expect(result.rows.slice(0, 2).map((row) => row.name)).toEqual(["table", "outside-ten"]);
        expect(result.rows.at(-1)?.name).toBe("never");
    });

    test("seeds opened sorting with the newest of recents and the record", () => {
        const first = file("first");
        const second = file("second");
        const result = projectLibrary({
            entries: [first, second],
            lastOpened: {
                [fileWorkspaceKey(first.handle)]: 10,
                [fileWorkspaceKey(second.handle)]: 20,
            },
            recents: [{ handle: first.handle, name: first.name, type: "game", lastOpened: 30 }],
        });
        expect(result.rows.map((row) => row.name)).toEqual(["first", "second"]);
    });

    test("preserves unreadable children, failed file metadata, and root failures", () => {
        const unread = {
            type: "unreadable" as const,
            name: "denied",
            key: "unread",
            category: "permission" as const,
        };
        const failure = new Error("listing unavailable");
        const result = projectLibrary({
            entries: [unread, { ...file("failed"), readError: "permission" }],
            listingError: failure,
        });
        expect(result.unread).toEqual([unread]);
        expect(result.failedFiles.map((entry) => entry.name)).toEqual(["failed"]);
        expect(result.listingError).toBe(failure);
    });

    test("shares Library missing classification and standalone filtering", () => {
        const descriptors = [
            collection("ready"),
            collection("missing", "stale"),
            collection("retired", "retired"),
            collection("trash", "trashed"),
            collection("preserved", "preservedOriginal"),
        ];
        expect(
            joinLibraryCollections([file("ready")], descriptors).missing.map((item) => item.id),
        ).toEqual(["missing"]);
        expect(
            joinLibraryCollections([file("missing")], descriptors).byFile.get(
                fileWorkspaceKey(file("missing").handle),
            )?.id,
        ).toBe("missing");
        const target = database("target");
        expect(
            standaloneDatabases(
                [
                    target,
                    database("visible"),
                    { ...database("linked"), collection: descriptors[0] },
                ],
                [{ targetDatabase: target.file }],
            ).map((item) => item.filename),
        ).toEqual(["visible"]);
        expect(
            projectLibrary({ entries: [file("preserved")], collections: descriptors }).rows.some(
                (row) => row.kind === "file" && row.name === "preserved",
            ),
        ).toBe(true);
    });
});
