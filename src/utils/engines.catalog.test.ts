import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import { CatalogVerificationError } from "./signedCatalog";
import {
    EngineCapabilityQueryError,
    EngineCatalogVerificationError,
    loadCompatibleEngineCatalog,
    loadStockfishCatalogEntry,
    useDefaultEngines,
} from "./engines";

const mocks = vi.hoisted(() => ({ bmi2: vi.fn(), catalog: vi.fn(), swr: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: { isBmi2Compatible: mocks.bmi2 } }));
vi.mock("./signedCatalog", async (original) => ({
    ...(await original<typeof import("./signedCatalog")>()),
    loadSignedCatalog: mocks.catalog,
}));
vi.mock("swr", () => ({ default: mocks.swr }));

const catalog = [
    { name: "Stockfish", os: "linux", bmi2: true, version: "bmi2" },
    { name: "stockfish", os: "linux", bmi2: false, version: "lowercase" },
    { name: "Stockfish dev", os: "linux", bmi2: false, version: "dev" },
    { name: "Other", os: "linux", bmi2: false, version: "other" },
    { name: "Stockfish", os: "windows", bmi2: false, version: "windows" },
    { name: "Stockfish", os: "linux", bmi2: false, version: "compatible" },
];
beforeEach(() => {
    vi.resetAllMocks();
    mocks.bmi2.mockResolvedValue(false);
    mocks.catalog.mockResolvedValue(catalog);
    mocks.swr.mockReturnValue({ data: undefined, error: undefined, isLoading: false });
});

test.each([true, false])(
    "the shared catalog filters OS and BMI2 exactly: bmi2=%s",
    async (bmi2) => {
        mocks.bmi2.mockResolvedValue(bmi2);
        expect(await loadCompatibleEngineCatalog("linux")).toEqual(
            catalog.filter((entry) => entry.os === "linux" && entry.bmi2 === bmi2),
        );
        expect(mocks.bmi2).toHaveBeenCalledOnce();
    },
);

test("Stockfish selection uses the exact name within the compatible catalog", async () => {
    expect(await loadStockfishCatalogEntry("linux")).toEqual(catalog.at(-1));
    mocks.bmi2.mockResolvedValue(true);
    expect(await loadStockfishCatalogEntry("linux")).toEqual(catalog[0]);
    expect(await loadStockfishCatalogEntry("macos")).toBeUndefined();
});

test("the Add dialog hook uses the shared loader and retains its open gate", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    function Probe({ opened }: { opened: boolean }) {
        useDefaultEngines("linux", opened);
        return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
        await act(async () => root.render(createElement(Probe, { opened: true })));
        expect(mocks.swr).toHaveBeenLastCalledWith("linux", loadCompatibleEngineCatalog);
        await act(async () => root.render(createElement(Probe, { opened: false })));
        expect(mocks.swr).toHaveBeenLastCalledWith(null, loadCompatibleEngineCatalog);
    } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
    }
});

test("a failed capability query offers no entry and never loads a catalog", async () => {
    mocks.bmi2.mockRejectedValue(new Error("capability failed"));
    await expect(loadStockfishCatalogEntry("linux")).rejects.toBeInstanceOf(
        EngineCapabilityQueryError,
    );
    expect(mocks.catalog).not.toHaveBeenCalled();
});

test("a rejected catalog signature offers no entry", async () => {
    mocks.catalog.mockRejectedValue(new CatalogVerificationError(new Error("bad signature")));
    await expect(loadStockfishCatalogEntry("linux")).rejects.toBeInstanceOf(
        EngineCatalogVerificationError,
    );
});
