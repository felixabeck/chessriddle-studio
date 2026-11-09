import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EngineCompletion } from "@/bindings";
import type { DefaultEngine, LocalEngine } from "@/utils/engines";
import UpgradeEngineModal from "./UpgradeEngineModal";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  installJob: vi.fn(),
  cancel: vi.fn(),
  notify: vi.fn(),
  pending: undefined as { completion: EngineCompletion; applying: boolean } | undefined,
  catalogError: undefined as unknown,
}));
vi.mock("@/state/catalogEngineCompletion", () => ({
  installCatalogEngineJob: mocks.installJob,
  usePendingEngineCompletion: () => mocks.pending,
}));
vi.mock("@/hooks/downloadJobs", () => ({
  runDownloadJob: (_id: string, run: (ticket: string) => Promise<void>) => run("ticket"),
  useDownloadJob: () => false,
  cancelDownloadJob: mocks.cancel,
}));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("@/utils/files", () => ({ usePlatform: () => ({ os: "linux" }) }));
vi.mock("@/utils/engines", async (original) => ({
  ...(await original<typeof import("@/utils/engines")>()),
  useDefaultEngines: () => ({
    defaultEngines: [catalog],
    error: mocks.catalogError,
    isLoading: false,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../common/AppModal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mantine/core", () => {
  const Container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Alert: Container,
    Center: Container,
    Loader: Container,
    SimpleGrid: Container,
    ScrollArea: { Autosize: Container },
  };
});
vi.mock("./CatalogEngineCard", () => ({
  default: ({
    initInstalled,
    recovery,
    disabled,
    onClick,
    labels,
  }: {
    initInstalled: boolean;
    recovery?: { busy: boolean; retry: () => void };
    disabled?: boolean;
    onClick: () => void;
    labels: { completed: string; action: string };
  }) => (
    <button
      disabled={recovery ? recovery.busy : disabled || initInstalled}
      onClick={recovery ? recovery.retry : onClick}
    >
      {recovery
        ? recovery.busy
          ? "Common.Extracting"
          : "Common.Install"
        : initInstalled
          ? labels.completed
          : labels.action}
    </button>
  ),
}));

const old: LocalEngine = {
  id: "engine-id",
  type: "local",
  name: "Old",
  version: "1",
  filename: "old",
  handle: { id: { id: "old" }, kind: "engine" },
  downloadLink: "https://example.com/old.zip",
};
const catalog: DefaultEngine = {
  id: "catalog-id",
  type: "local",
  name: "New",
  version: "2",
  path: "engine",
  os: "linux",
  bmi2: false,
  sha256: "a".repeat(64),
  signature: "signature",
  downloadLink: "https://example.com/new.zip",
};
const progressId = `engine-upgrade:${old.id}:${catalog.downloadLink}`;
let root: Root;
let host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue(undefined);
  mocks.installJob.mockReset().mockImplementation(async (entry, id, upgrade, store) => {
    try {
      await mocks.complete(entry, id, "ticket", upgrade, store);
      return true;
    } catch (error) {
      mocks.notify("Common.Error", error, "engine");
      return false;
    }
  });
  mocks.notify.mockReset();
  mocks.pending = undefined;
  mocks.catalogError = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async (engine = old) =>
  act(async () =>
    root.render(<UpgradeEngineModal engine={engine} opened setOpened={() => undefined} />),
  );
const click = async () => act(async () => host.querySelector("button")!.click());

test("submits the immutable engine target and becomes current after full application", async () => {
  await render();
  await click();
  expect(mocks.installJob).toHaveBeenCalledExactlyOnceWith(
    catalog,
    progressId,
    old,
    expect.anything(),
  );
  expect(mocks.complete).toHaveBeenCalledWith(
    catalog,
    progressId,
    "ticket",
    old,
    expect.anything(),
  );
  expect(host.textContent).toContain("Engines.Upgrade.Current");
  expect(host.querySelector("button")!.disabled).toBe(true);
});

test("application failure keeps Install available and uses the localized error path", async () => {
  const failure = new Error("Engines.Upgrade.SnapshotSaveError");
  mocks.complete.mockRejectedValue(failure);
  await render();
  await click();
  expect(mocks.notify).toHaveBeenCalledWith("Common.Error", failure, "engine");
  expect(host.textContent).toContain("Common.Install");
  expect(host.querySelector("button")!.disabled).toBe(false);
});

test("a partially applied current binary still exposes Install to rejoin its original completion", async () => {
  mocks.pending = {
    applying: false,
    completion: {
      id: crypto.randomUUID(),
      retired: false,
      request: {
        intent: { kind: "upgrade", engine_id: old.id, expected: old.handle },
        root: { id: { id: "root" }, kind: "engineRoot" },
        progressId,
        url: catalog.downloadLink!,
        sha256: catalog.sha256,
        signature: catalog.signature,
        relativePath: catalog.path,
        name: catalog.name,
        version: catalog.version,
        elo: null,
        downloadSize: null,
      },
      outcome: {
        state: "succeeded",
        result: {
          handle: { id: { id: "new" }, kind: "engine" },
          filename: "new",
          config: { name: "New", options: [] },
        },
      },
    },
  };
  await render({ ...old, downloadLink: catalog.downloadLink });
  expect(host.textContent).toContain("Common.Install");
  expect(host.querySelector("button")!.disabled).toBe(false);
  await click();
  expect(mocks.complete).toHaveBeenCalledOnce();
});

test("the current catalog choice remains disabled with no pending completion", async () => {
  await render({ ...old, downloadLink: catalog.downloadLink });
  expect(host.textContent).toContain("Engines.Upgrade.Current");
  expect(host.querySelector("button")!.disabled).toBe(true);
});

test("catalog failures use the existing localized load error", async () => {
  mocks.catalogError = new Error("catalog unavailable");
  await render();
  expect(host.textContent).toContain("Engines.Upgrade.ErrorLoad");
  expect(host.querySelector("button")).toBeNull();
});
