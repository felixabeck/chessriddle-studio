import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import bundledCatalog from "@/catalogs/engines.json";
import EngineSelection from "@/components/panels/analysis/EngineSelection";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { EngineCatalogVerificationError, type Engine, type LocalEngine } from "@/utils/engines";
import EnginesPage from "./EnginesPage";
import { cleanupPortraitTest, settlePortraitCatalog } from "./tests/portraitCatalog";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  image: vi.fn(),
  readImage: vi.fn(),
  notify: vi.fn(),
  selected: 0,
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    fileExists: vi.fn().mockResolvedValue(true),
    getEngineConfig: vi.fn().mockResolvedValue({ name: "Engine", options: [] }),
    verifySignedBytes: mocks.verify,
    issueEngineImage: mocks.image,
    readEngineImage: mocks.readImage,
    reconcileEngineAttachments: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  warn: vi.fn(),
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notify,
  runUnlessCancelled: async (_title: string, action: () => Promise<unknown>) => {
    try {
      return await action();
    } catch (error) {
      mocks.notify(error);
      return undefined;
    }
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: () => null }));
vi.mock("@/routes/engines", () => ({
  Route: { useSearch: () => ({ selected: mocks.selected }) },
}));
vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));
vi.mock("../common/AppModal", () => ({ default: () => null }));
vi.mock("../common/ConfirmModal", () => ({ default: () => null }));
vi.mock("../common/GoModeInput", () => ({ default: () => null }));
vi.mock("../common/OpenFolderButton", () => ({ default: () => null }));
vi.mock("../panels/analysis/LinesSlider", () => ({ default: () => null }));
vi.mock("./AddEngine", () => ({ default: () => null }));
vi.mock("./UpgradeEngineModal", () => ({ default: () => null }));

let records: Engine[];
const save = vi.fn();
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [records, save],
  useStore: () => ({ get: () => records }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const first = bundledCatalog[0];
const second = bundledCatalog.find((entry) => entry.image !== first.image)!;
function installed(overrides: Partial<LocalEngine> = {}): LocalEngine {
  return {
    type: "local",
    id: "installed",
    name: "Renamed installed engine",
    version: "old version",
    handle: { id: { id: "binary" }, kind: "engine" },
    filename: "my-engine",
    downloadLink: first.downloadLink,
    settings: [],
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
let cache: Cache<unknown>;
async function render(surface: "page" | "picker" = "page") {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <SWRConfig value={{ provider: () => cache }}>
          {surface === "picker" ? <EngineSelection /> : <EnginesPage />}
        </SWRConfig>
      </MantineProvider>,
    );
  });
  await settlePortraitCatalog();
}
const selectImage = () =>
  host.querySelector<HTMLButtonElement>('[aria-label="Engines.Settings.SelectImage"]')!;
const card = () => host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;
async function expectPortraits(src: string) {
  await settlePortraitCatalog();
  expect(card().querySelector("img")?.getAttribute("src")).toBe(src);
  expect(selectImage().querySelector("img")?.getAttribute("src")).toBe(src);
}
function expectFallbacks() {
  expect(card().querySelector("img")).toBeNull();
  expect(card().querySelector(".lucide-brain")).not.toBeNull();
  expect(selectImage().querySelector("img")).toBeNull();
  expect(selectImage().querySelector(".lucide-image-plus")).not.toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue({ saved: true });
  mocks.selected = 0;
  mocks.verify.mockReset().mockResolvedValue(undefined);
  mocks.image.mockReset().mockRejectedValue(new Error("Cancellation"));
  mocks.readImage.mockReset().mockResolvedValue({ bytes: [1, 2, 3], mimeType: "image/png" });
  records = [installed()];
  cache = new Map();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await cleanupPortraitTest(root, host);
});

test("an installed record resolves its exact URL in both card and editor through one authenticated catalog", async () => {
  // This Windows BMI2 entry must display without consulting this machine's platform or CPU.
  expect(first.os).toBe("windows");
  expect(first.bmi2).toBe(true);
  expect(records[0]).not.toHaveProperty("imageUrl");
  expect(records[0]).not.toHaveProperty("imageHandle");
  await render();
  await expectPortraits(first.image);
  await render();
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  await act(async () => selectImage().click());
  expect(mocks.image).toHaveBeenCalledTimes(1);
});

test("a custom image takes precedence in both locations and remains selectable", async () => {
  records = [installed({ imageHandle: { id: { id: "custom" }, kind: "engineImage" } })];
  await render();
  await expectPortraits("data:image/png;base64,AQID");
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.readImage).toHaveBeenCalledWith({ id: { id: "custom" }, kind: "engineImage" });
  await act(async () => selectImage().click());
  expect(mocks.image).toHaveBeenCalledTimes(1);
});

test.each(["bundled", "custom"])(
  "the analysis picker displays the %s portrait and toggles only the clicked engine's loaded flag",
  async (source) => {
    const loaded = source === "bundled";
    const imageHandle =
      source === "custom" ? { id: { id: "custom" }, kind: "engineImage" as const } : undefined;
    records = [
      installed({ loaded, imageHandle }),
      installed({ id: "same-name-and-path", loaded, downloadLink: null }),
    ];
    await render("picker");
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      source === "bundled" ? first.image : "data:image/png;base64,AQID",
    );
    const image = host.querySelector("img")!;
    expect(image.alt).toBe(records[0].name);
    const checkboxes = () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes()).toHaveLength(2);
    expect(checkboxes()[0].checked).toBe(loaded);
    expect(checkboxes()[1].checked).toBe(loaded);
    expect(host.querySelector(".lucide-brain")).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    await act(async () => image.click());
    expect(save).toHaveBeenCalledOnce();
    const next = await save.mock.calls[0][0](Promise.resolve(records));
    expect(next).toEqual([{ ...records[0], loaded: !loaded }, records[1]]);
    expect(next[1]).toBe(records[1]);
    expect(mocks.verify).toHaveBeenCalledTimes(source === "bundled" ? 1 : 0);
    expect(mocks.readImage.mock.calls).toEqual(source === "custom" ? [[imageHandle]] : []);
  },
);

test.each([
  undefined,
  null,
  "",
  "https://unknown.invalid/engine.zip",
  `${first.downloadLink}?other=1`,
])(
  "missing or non-exact URL %s keeps the card and selectable editor fallbacks",
  async (downloadLink) => {
    records = [installed({ downloadLink })];
    await render();
    expect(mocks.verify).toHaveBeenCalledTimes(downloadLink ? 1 : 0);
    expectFallbacks();
    await act(async () => selectImage().click());
    expect(mocks.image).toHaveBeenCalledTimes(1);
  },
);

test("a matching catalog entry without an image keeps the fallback usable", async () => {
  const catalog = bundledCatalog.map(({ image: _image, ...entry }) => entry);
  const engines = await import("@/utils/engines");
  const loaded = await engines.loadDefaultEngineCatalog(JSON.stringify(catalog), "signature");
  const load = vi.spyOn(engines, "loadDefaultEngineCatalog").mockResolvedValue(loaded);
  try {
    await render();
    expect(load).toHaveBeenCalledTimes(1);
    expectFallbacks();
    await act(async () => selectImage().click());
    expect(mocks.image).toHaveBeenCalledTimes(1);
  } finally {
    load.mockRestore();
  }
});

test("catalog verification rejection is handled once and leaves selection usable", async () => {
  vi.useFakeTimers();
  try {
    mocks.verify.mockRejectedValue(new EngineCatalogVerificationError("invalid signature"));
    await render();
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    records = [installed({ id: "after-verification-failure" })];
    await render();
    expectFallbacks();
    await act(async () => selectImage().click());
    expect(mocks.image).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["selection", "link"])(
  "a current-engine %s change during verification cannot reuse the previous portrait",
  async (change) => {
    let resolve!: () => void;
    const verification = new Promise<void>((done) => (resolve = done));
    mocks.verify.mockReturnValue(verification);
    try {
      await render();
      expect(mocks.verify).toHaveBeenCalledTimes(1);
      expectFallbacks();
      await act(async () => selectImage().click());
      expect(mocks.image).toHaveBeenCalledTimes(1);
      const next = installed({
        id: change === "selection" ? "second" : "installed",
        downloadLink: second.downloadLink,
      });
      if (change === "selection") {
        records = [records[0], next];
        mocks.selected = 1;
      } else {
        records = [next];
      }
      await render();
      await act(async () => {
        resolve();
        await verification;
      });
      await expectPortraits(second.image);
      expect(mocks.verify).toHaveBeenCalledTimes(1);
      records = [installed({ downloadLink: "https://unknown.invalid/engine.zip" })];
      mocks.selected = 0;
      await render();
      expectFallbacks();
    } finally {
      await act(async () => {
        resolve();
        await verification;
      });
      await settlePortraitCatalog();
    }
  },
);

test("cloud engines retain their cloud fallback without catalog resolution", async () => {
  records = [{ type: "lichess", id: "cloud", name: "Cloud", url: "https://lichess.org" }];
  await render();
  expect(card().querySelector("img")).toBeNull();
  expect(card().querySelector(".lucide-cloud")).not.toBeNull();
  expect(mocks.verify).not.toHaveBeenCalled();
});
