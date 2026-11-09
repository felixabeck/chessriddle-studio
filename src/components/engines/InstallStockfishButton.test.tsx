import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DefaultEngine } from "@/utils/engines";
import InstallStockfishButton from "./InstallStockfishButton";

const mocks = vi.hoisted(() => ({
  entries: [] as DefaultEngine[],
  error: undefined as unknown,
  install: vi.fn(),
  cancel: vi.fn(),
  running: false,
  pending: undefined as
    | undefined
    | { completion: { outcome: { state: string } }; applying: boolean },
}));
vi.mock("@/utils/files", () => ({ usePlatform: () => ({ os: "linux" }) }));
vi.mock("@/utils/engines", async (original) => ({
  ...(await original<typeof import("@/utils/engines")>()),
  useDefaultEngines: () => ({ defaultEngines: mocks.entries, error: mocks.error }),
}));
vi.mock("@/state/catalogEngineCompletion", () => ({
  installCatalogEngineJob: mocks.install,
  usePendingEngineCompletion: () => mocks.pending,
}));
vi.mock("@/hooks/downloadJobs", () => ({
  useDownloadJob: () => mocks.running,
  cancelDownloadJob: mocks.cancel,
}));
vi.mock("@/hooks/useProgress", () => ({
  useProgress: () => ({
    progress: 37,
    isActive: mocks.running,
    finished: false,
    fence: vi.fn(),
    item: null,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const stockfish = {
  id: "stockfish",
  name: "Stockfish",
  version: "17",
  downloadLink: "https://example.com/stockfish.zip",
} as DefaultEngine;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  mocks.entries = [stockfish];
  mocks.error = undefined;
  mocks.running = false;
  mocks.pending = undefined;
  mocks.install.mockReset().mockResolvedValue(false);
  mocks.cancel.mockReset().mockResolvedValue({ clearedGeneration: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <MantineProvider>
        <InstallStockfishButton key={String(mocks.pending?.applying)} />
      </MantineProvider>,
    ),
  );

test("offers the exact Stockfish entry through the shared install action and allows retry after failure", async () => {
  mocks.entries = [{ ...stockfish, name: "Stockfish derivative" }, stockfish];
  await render();
  expect(host.textContent).toContain("Engines.InstallStockfish");
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.install).toHaveBeenCalledWith(
    stockfish,
    `engine:${stockfish.downloadLink}`,
    undefined,
    expect.anything(),
  );
  expect(host.querySelector("button")!.disabled).toBe(false);
  mocks.install.mockResolvedValue(true);
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Common.Installed");
});

test("joins the running job and cancels that job", async () => {
  mocks.running = true;
  await render();
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Common.Cancel"]')!.click(),
  );
  expect(mocks.cancel).toHaveBeenCalledWith(`engine:${stockfish.downloadLink}`, "Common.Error");
  expect(mocks.install).not.toHaveBeenCalled();
});

test("retries a completed native install whose owner save failed without showing cancel", async () => {
  mocks.pending = { completion: { outcome: { state: "succeeded" } }, applying: false };
  await render();
  expect(host.querySelectorAll("button")).toHaveLength(1);
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.install).toHaveBeenCalledOnce();
  mocks.pending.applying = true;
  await render();
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect(host.textContent).toContain("Common.Extracting");
});

test.each(["missing", "error"])("renders nothing for catalog %s", async (condition) => {
  if (condition === "missing") mocks.entries = [{ ...stockfish, name: "Stockfish derivative" }];
  else mocks.error = new Error("catalog rejected");
  await render();
  expect(host.querySelector("button")).toBeNull();
});
