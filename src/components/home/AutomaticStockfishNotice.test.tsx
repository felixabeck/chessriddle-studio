import { MantineProvider, getDefaultZIndex } from "@mantine/core";
import { atom, createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { automaticStockfishJobAtom } from "@/state/firstLaunchStockfish";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DefaultEngine } from "@/utils/engines";
import { AutomaticStockfishNotice } from "./AutomaticStockfishNotice";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  running: false,
  cancel: vi.fn(),
  suspended: false,
  progressWait: new Promise<never>(() => {}),
}));
vi.mock("@/state/firstLaunchStockfish", () => ({
  automaticStockfishJobAtom: atom(null),
  startFirstLaunchStockfish: mocks.start,
}));
vi.mock("@/utils/files", () => ({ usePlatform: () => ({ os: "linux" }) }));
vi.mock("@/hooks/downloadJobs", () => ({
  useDownloadJob: () => mocks.running,
  cancelDownloadJob: mocks.cancel,
}));
vi.mock("@/hooks/useProgress", () => ({
  useProgress: () => {
    if (mocks.suspended) throw mocks.progressWait;
    return {
      progress: 37,
      isActive: true,
      finished: false,
      fence: vi.fn(),
      item: null,
    };
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let store: ReturnType<typeof createStore>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  mocks.start.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockReset();
  mocks.cancel.mockReset().mockResolvedValue({ clearedGeneration: null });
  mocks.running = false;
  mocks.suspended = false;
  store = createStore();
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
      <Provider store={store}>
        <MantineProvider>
          <AutomaticStockfishNotice key={String(mocks.running)} />
        </MantineProvider>
      </Provider>,
    ),
  );

test("starts from the effect without blocking the shell and disposes the prerequisite wait on unmount", async () => {
  await render();
  expect(mocks.start).toHaveBeenCalledWith("linux", store);
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => root.render(null));
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

test("shows only a running automatic job, names it, and routes cancel to the shared job", async () => {
  const job = {
    engine: { name: "Stockfish", version: "17" } as DefaultEngine,
    progressId: "engine:stockfish",
  };
  store.set(automaticStockfishJobAtom, job);
  await render();
  expect(host.querySelector('[role="status"]')).toBeNull();
  mocks.running = true;
  await render();
  expect(host.textContent).toContain("Stockfish 17");
  expect(host.textContent).toContain("Common.Downloading");
  expect(host.querySelector<HTMLElement>('[role="status"]')!.style.zIndex).toBe(
    String(getDefaultZIndex("modal") - 1),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Common.Cancel"]')!.click(),
  );
  expect(mocks.cancel).toHaveBeenCalledWith(job.progressId, "Common.Error");
  await act(async () => store.set(automaticStockfishJobAtom, null));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test("a suspended progress control leaves the app shell available and starts the owned effect", async () => {
  mocks.running = true;
  mocks.suspended = true;
  store.set(automaticStockfishJobAtom, {
    engine: { name: "Stockfish", version: "17" } as DefaultEngine,
    progressId: "engine:stockfish",
  });
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <div data-testid="shell" />
          <AutomaticStockfishNotice />
        </MantineProvider>
      </Provider>,
    ),
  );
  expect(host.querySelector('[data-testid="shell"]')).not.toBeNull();
  expect(mocks.start).toHaveBeenCalledWith("linux", store);
});
