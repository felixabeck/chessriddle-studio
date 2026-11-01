import { describe, expect, it, vi } from "vitest";
import { inspectEngineOwnerValue } from "@/state/engineOwnerStorage";

const installMocks = vi.hoisted(() => ({
    downloadEngineArchive: vi.fn(),
    engineArchiveDestination: vi.fn(),
    getEngineConfig: vi.fn(),
    getEngineWorkspace: vi.fn(),
    registerInstalledEngine: vi.fn(),
    installEngineWorkflow: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            installEngineWorkflow: installMocks.installEngineWorkflow,
            downloadEngineArchive: installMocks.downloadEngineArchive,
            engineArchiveDestination: installMocks.engineArchiveDestination,
            getEngineConfig: installMocks.getEngineConfig,
            getEngineWorkspace: installMocks.getEngineWorkspace,
            registerInstalledEngine: installMocks.registerInstalledEngine,
        },
    };
});
import {
    bundledEngineImagePath,
    defaultEngineManifestSchema,
    defaultEngineProgressId,
    engineMultiPv,
    engineSchema,
    isEngineResourcePathOptionName,
    isManifestEngineInstalled,
    installDefaultEngine,
    installCatalogEngine,
    installedEngineFromCompletion,
    requiredEngineSettingsDefaults,
    manifestEngineInstallCard,
    parsePersistedEngineJson,
    type LocalEngine,
} from "./engines";

const manifestEntry = {
    type: "local" as const,
    name: "Stockfish",
    version: "17",
    downloadLink: "https://example.com/engines/stockfish.zip",
    sha256: "a".repeat(64),
    signature: "minisign signature",
    os: "linux" as const,
    bmi2: true,
};

function parseManifestPath(path: string) {
    return defaultEngineManifestSchema.safeParse({ ...manifestEntry, path });
}

function parseManifestPortrait(field: "image" | "imageUrl", value: string) {
    return defaultEngineManifestSchema.safeParse({
        ...manifestEntry,
        path: "stockfish",
        [field]: value,
    });
}

describe("default engine manifest paths", () => {
    it("accepts single- and multi-component engine paths", () => {
        const accepted = ["stockfish", "stockfish-17/stockfish-ubuntu-x86-64-bmi2"];
        // Compared as a whole so a failure names the offending path; `expect` takes no message
        // argument under oxlint's `valid-expect`.
        expect(accepted.map((path) => [path, parseManifestPath(path).success])).toStrictEqual(
            accepted.map((path) => [path, true]),
        );
    });

    it("rejects paths the backend cannot safely resolve", () => {
        const rejected = [
            ["/etc/passwd", "leading slash"],
            ["../../evil", "parent-directory segment"],
            ["a//b", "empty segment from a doubled slash"],
            ["a/./b", "current-directory segment"],
            ["a/", "trailing empty segment"],
            ["/a", "leading slash"],
            ["a\0b", "NUL"],
            ["C:\\Windows\\system32", "backslash"],
            ["C:/Windows/system32", "Windows drive prefix"],
            ["C:evil", "Windows drive prefix"],
        ] as const;

        expect(
            rejected.map(([path, reason]) => [
                `${path}: ${reason}`,
                parseManifestPath(path).success,
            ]),
        ).toStrictEqual(rejected.map(([path, reason]) => [`${path}: ${reason}`, false]));
    });

    it("accepts only bundled same-origin engine portraits", () => {
        const accepted = ["/engines/stockfish.png", "/engines/lc0.svg"];
        expect(
            accepted.flatMap((image) =>
                (["image", "imageUrl"] as const).map((field) => [
                    `${field}:${image}`,
                    parseManifestPortrait(field, image).success,
                ]),
            ),
        ).toStrictEqual(
            accepted.flatMap((image) =>
                (["image", "imageUrl"] as const).map((field) => [`${field}:${image}`, true]),
            ),
        );
        expect(accepted.every((image) => bundledEngineImagePath.safeParse(image).success)).toBe(
            true,
        );
    });

    it("rejects remote and traversal portrait URLs on both catalog fields", () => {
        const rejected = [
            "https://upload.wikimedia.org/wikipedia/commons/3/3a/NewLogoSF.png",
            "https://images.chesscomfiles.com/chess-themes/computer_chess_championship/avatars/lrg_rubi.png",
            "https://lczero.org/images/logo.svg",
            "/board/wood.png",
            "/engines/../logo.png",
            "engines/stockfish.png",
        ];
        expect(
            rejected.flatMap((image) =>
                (["image", "imageUrl"] as const).map((field) => [
                    `${field}:${image}`,
                    parseManifestPortrait(field, image).success,
                ]),
            ),
        ).toStrictEqual(
            rejected.flatMap((image) =>
                (["image", "imageUrl"] as const).map((field) => [`${field}:${image}`, false]),
            ),
        );
    });
});

describe("default-engine installed identity", () => {
    const stockfish: LocalEngine = {
        type: "local",
        id: "installed-1",
        name: "Stockfish",
        version: "17",
        filename: "stockfish",
        handle: { id: { id: "capability-1" }, kind: "engine" },
        downloadLink: "https://example.com/engines/stockfish.zip",
    };

    it("does not treat a distinct download as installed just because the names match", () => {
        expect(
            isManifestEngineInstalled([stockfish], {
                downloadLink: "https://example.com/engines/stockfish-dev.zip",
            }),
        ).toBe(false);
    });

    it("treats a renamed engine as installed when the download URL still matches", () => {
        expect(
            isManifestEngineInstalled([{ ...stockfish, name: "My Fish" }], {
                downloadLink: stockfish.downloadLink,
            }),
        ).toBe(true);
    });

    it("does not match a locally added engine that has no download URL", () => {
        expect(
            isManifestEngineInstalled([{ ...stockfish, downloadLink: undefined }], {
                downloadLink: stockfish.downloadLink,
            }),
        ).toBe(false);
    });

    it("keys progress and installed state by download URL, not name or array index", () => {
        const renamed = { ...stockfish, name: "My Fish" };
        const card = manifestEngineInstallCard([renamed], {
            downloadLink: stockfish.downloadLink,
        });
        expect(card).toEqual({
            progressId: defaultEngineProgressId(stockfish.downloadLink!),
            initInstalled: true,
        });
        expect(card.progressId).not.toBe("engine_0");
        expect(
            manifestEngineInstallCard([stockfish], {
                downloadLink: "https://example.com/engines/stockfish-dev.zip",
            }).initInstalled,
        ).toBe(false);
    });

    it("treats NalimovPath as a resource path option like SyzygyPath", () => {
        expect(isEngineResourcePathOptionName("NalimovPath")).toBe(true);
        expect(isEngineResourcePathOptionName("SyzygyPath")).toBe(true);
        expect(isEngineResourcePathOptionName("MultiPV")).toBe(false);
    });
});

describe("engine persistence", () => {
    it("admits one immutable native workflow with the preallocated Add UUID and ticket", async () => {
        const root = { id: { id: "root" }, kind: "engineRoot" };
        installMocks.getEngineWorkspace.mockReset().mockResolvedValue(root);
        installMocks.installEngineWorkflow
            .mockReset()
            .mockResolvedValue({ state: "native-result" });
        const intent = { kind: "add" as const, engine_id: "logical-engine-id" };
        const result = await installCatalogEngine(
            { ...manifestEntry, path: "stockfish/engine" } as never,
            "progress",
            "ticket",
            intent,
            "operation-id",
        );
        expect(result).toEqual({ state: "native-result" });
        expect(installMocks.installEngineWorkflow).toHaveBeenCalledExactlyOnceWith(
            "operation-id",
            {
                root,
                intent,
                progressId: "progress",
                url: manifestEntry.downloadLink,
                relativePath: "stockfish/engine",
                sha256: manifestEntry.sha256,
                signature: manifestEntry.signature,
                name: "Stockfish",
                version: "17",
                elo: null,
                downloadSize: null,
            },
            "ticket",
        );
        expect(installMocks.downloadEngineArchive).not.toHaveBeenCalled();
        expect(installMocks.registerInstalledEngine).not.toHaveBeenCalled();
        expect(installMocks.getEngineConfig).not.toHaveBeenCalled();
    });

    it("propagates admission errors and captures an Add identity before the transfer", async () => {
        installMocks.getEngineWorkspace.mockResolvedValue({
            id: { id: "root" },
            kind: "engineRoot",
        });
        const error = new Error("Cancellation");
        installMocks.installEngineWorkflow.mockReset().mockRejectedValue(error);
        await expect(
            installDefaultEngine(
                { ...manifestEntry, path: "stockfish" } as never,
                "progress",
                "ticket",
            ),
        ).rejects.toBe(error);
        expect(installMocks.installEngineWorkflow.mock.calls[0][1].intent).toMatchObject({
            kind: "add",
            engine_id: expect.any(String),
        });
    });

    it("shares required defaults and excludes button and non-required options", () => {
        expect(
            requiredEngineSettingsDefaults({
                name: "Engine",
                options: [
                    { type: "spin", value: { name: "Threads", default: 4n, min: 1n, max: 128n } },
                    { type: "spin", value: { name: "Hash", default: 32n, min: 1n, max: 1024n } },
                    { type: "button", value: { name: "MultiPV" } },
                    { type: "check", value: { name: "Ponder", default: false } },
                ],
            }),
        ).toEqual([
            { type: "string", name: "Threads", value: "4" },
            { type: "string", name: "Hash", value: "32" },
        ]);
    });

    it("builds an owner-valid engine from retained public metadata without another UUID", () => {
        const installed = installedEngineFromCompletion(
            "logical-id",
            {
                name: "Stockfish",
                version: "19",
                elo: 3635,
                downloadSize: 100,
                downloadLink: manifestEntry.downloadLink,
            },
            {
                handle: { id: { id: "installed" }, kind: "engine" },
                filename: "stockfish",
                config: { name: "Stockfish 19", options: [] },
            },
        );
        expect(installed.id).toBe("logical-id");
        expect(inspectEngineOwnerValue("engines", [installed])).toEqual({
            capabilityIds: ["installed"],
            attachmentIds: [],
        });
        expect(engineSchema.parse(installed)).toStrictEqual(installed);
    });

    it("accepts public metadata with an opaque native handle", () => {
        expect(
            engineSchema.safeParse({
                type: "local",
                id: "engine-1",
                name: "Stockfish",
                version: "17",
                filename: "stockfish",
                handle: { id: { id: "capability-1" }, kind: "engine" },
            }).success,
        ).toBe(true);
    });

    it("rejects a handle that is not an opaque capability object", () => {
        expect(
            engineSchema.safeParse({
                type: "local",
                id: "engine-1",
                name: "Stockfish",
                version: "17",
                filename: "stockfish",
                handle: "/usr/bin/stockfish",
            }).success,
        ).toBe(false);
    });

    it("parsePersistedEngineJson rejects invalid JSON instead of throwing", () => {
        expect(parsePersistedEngineJson("{")).toEqual({ success: false });
        expect(
            parsePersistedEngineJson(
                JSON.stringify({
                    type: "local",
                    id: "engine-1",
                    name: "Stockfish",
                    version: "17",
                    filename: "stockfish",
                    handle: { id: { id: "capability-1" }, kind: "engine" },
                }),
            ).success,
        ).toBe(true);
    });

    it("rejects legacy physical-path engine state", () => {
        expect(
            engineSchema.safeParse({
                type: "local",
                id: "engine-1",
                name: "Stockfish",
                version: "17",
                path: "/usr/bin/stockfish",
            }).success,
        ).toBe(false);
    });

    it("scrubs legacy renderer-visible image paths instead of persisting them", () => {
        const parsed = engineSchema.parse({
            type: "local",
            id: "engine-1",
            name: "Stockfish",
            version: "17",
            filename: "stockfish",
            handle: { id: { id: "capability-1" }, kind: "engine" },
            image: "/home/felix/private.png",
        });
        expect(parsed).not.toHaveProperty("image");
        expect(parsed.imageHandle).toBeUndefined();
    });

    it("persists only opaque native engine-image handles", () => {
        expect(
            engineSchema.safeParse({
                type: "local",
                id: "engine-1",
                name: "Stockfish",
                version: "17",
                filename: "stockfish",
                handle: { id: { id: "capability-1" }, kind: "engine" },
                imageHandle: { id: { id: "image-capability-1" }, kind: "engineImage" },
            }).success,
        ).toBe(true);
    });

    it("scrubs legacy raw UCI resource paths and retains opaque resource descriptors", () => {
        const base = {
            type: "local" as const,
            id: "engine-1",
            name: "Stockfish",
            version: "17",
            filename: "stockfish",
            handle: { id: { id: "capability-1" }, kind: "engine" as const },
        };
        const legacy = engineSchema.parse({
            ...base,
            settings: [{ type: "string", name: "SyzygyPath", value: "/private/tables" }],
        });
        expect(legacy.settings).toEqual([]);

        const current = engineSchema.parse({
            ...base,
            settings: [
                {
                    type: "resource",
                    name: "SyzygyPath",
                    resources: [
                        {
                            id: { id: "resource-capability" },
                            kind: "directory",
                            displayName: "tables",
                        },
                    ],
                },
            ],
        });
        expect(current.settings?.[0]).toMatchObject({
            type: "resource",
            resources: [{ displayName: "tables" }],
        });

        const lastLegacyValue = engineSchema.parse({
            ...base,
            settings: [
                current.settings![0],
                { type: "string", name: "SyzygyPath", value: "/private/tables" },
            ],
        });
        expect(lastLegacyValue.settings).toEqual([]);
    });

    it("collapses duplicate persisted options by name with the last value winning", () => {
        const parsed = engineSchema.parse({
            type: "local",
            id: "engine-1",
            name: "Stockfish",
            version: "17",
            filename: "stockfish",
            handle: { id: { id: "capability-1" }, kind: "engine" },
            settings: [
                { type: "string", name: "MultiPV", value: "2" },
                { type: "string", name: "Threads", value: "8" },
                { type: "string", name: "MultiPV", value: "4" },
            ],
        });

        expect(parsed.settings).toEqual([
            { type: "string", name: "MultiPV", value: "4" },
            { type: "string", name: "Threads", value: "8" },
        ]);
    });
});

describe("engineMultiPv", () => {
    const multiPv = (value: string) => [{ type: "string" as const, name: "MultiPV", value }];

    it("reads the last MultiPV option and falls back to one line", () => {
        expect(engineMultiPv([])).toBe(1);
        expect(engineMultiPv(multiPv("4"))).toBe(4);
        expect(engineMultiPv([...multiPv("2"), ...multiPv("5")])).toBe(5);
        for (const invalid of ["", "abc", "0", "-3"])
            expect(engineMultiPv(multiPv(invalid))).toBe(1);
        expect(engineMultiPv([{ type: "resource", name: "MultiPV", resources: [] }])).toBe(1);
    });
});
