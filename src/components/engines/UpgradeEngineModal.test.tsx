import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EngineCompletion } from "@/bindings";
import type { DefaultEngine, LocalEngine } from "@/utils/engines";
import UpgradeEngineModal from "./UpgradeEngineModal";

const mocks = vi.hoisted(() => ({
  installJob: vi.fn(),
  cancel: vi.fn(),
  pending: undefined as { completion: EngineCompletion; applying: boolean } | undefined,
  catalogError: undefined as unknown,
  hasJob: false,
  catalogs: [] as DefaultEngine[],
}));
vi.mock("@/state/catalogEngineCompletion", () => ({
  installCatalogEngineJob: mocks.installJob,
  usePendingEngineCompletion: () => mocks.pending,
}));
vi.mock("@/hooks/downloadJobs", () => ({
  useDownloadJob: () => mocks.hasJob,
  useRunningDownloadJob: (ids: readonly string[]) =>
    mocks.hasJob ? (ids.find((id) => id === progressId) ?? null) : null,
  cancelDownloadJob: mocks.cancel,
}));
vi.mock("@/utils/files", () => ({ usePlatform: () => ({ os: "linux" }) }));
vi.mock("@/utils/engines", async (original) => ({
  ...(await original<typeof import("@/utils/engines")>()),
  useDefaultEngines: () => ({
    defaultEngines: mocks.catalogs,
    error: mocks.catalogError,
    isLoading: false,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../common/AppModal", () => ({
  default: ({ children, onClose }: { children: React.ReactNode; onClose: () => void }) => (
    <div>
      <button data-testid="close" onClick={onClose} />
      {children}
    </div>
  ),
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
    inProgress,
    onClick,
    onCancel,
    labels,
  }: {
    initInstalled: boolean;
    recovery?: { busy: boolean; retry: () => void };
    disabled?: boolean;
    inProgress: boolean;
    onClick: () => void;
    onCancel?: () => void;
    labels: { completed: string; action: string; inProgress: string };
  }) => (
    <>
      <button
        data-testid="install"
        data-in-progress={inProgress}
        disabled={recovery ? recovery.busy : disabled || initInstalled}
        onClick={recovery ? recovery.retry : onClick}
      >
        {recovery
          ? recovery.busy
            ? "Common.Extracting"
            : "Common.Install"
          : initInstalled
            ? labels.completed
            : inProgress
              ? labels.inProgress
              : labels.action}
      </button>
      {onCancel ? (
        <button data-testid="cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </>
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
  mocks.installJob.mockReset().mockResolvedValue(true);
  mocks.cancel.mockReset();
  mocks.pending = undefined;
  mocks.catalogError = undefined;
  mocks.hasJob = false;
  mocks.catalogs = [catalog];
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
const installButton = (index = 0) =>
  host.querySelectorAll<HTMLButtonElement>('[data-testid="install"]')[index] ?? null;
const click = async () => act(async () => installButton()!.click());

test("submits the immutable engine target and becomes current after full application", async () => {
  let finish!: (result: boolean) => void;
  mocks.installJob.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await click();
  expect(mocks.installJob).toHaveBeenCalledExactlyOnceWith(
    catalog,
    progressId,
    old,
    expect.anything(),
  );
  expect(installButton()!.dataset.inProgress).toBe("true");
  expect(host.textContent).toContain("Common.Downloading");
  expect(host.textContent).not.toContain("Engines.Upgrade.Current");
  expect(installButton()!.disabled).toBe(true);
  await act(async () => finish(true));
  expect(host.textContent).toContain("Engines.Upgrade.Current");
  expect(installButton()!.disabled).toBe(true);
  expect(installButton()!.dataset.inProgress).toBe("false");
  expect(old.downloadLink).toBe("https://example.com/old.zip");
});

test("an unsuccessful shared action clears progress and keeps the original catalog choice available", async () => {
  let finish!: (result: boolean) => void;
  mocks.installJob.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await click();
  expect(installButton()!.dataset.inProgress).toBe("true");
  await act(async () => finish(false));
  expect(host.textContent).toContain("Common.Install");
  expect(installButton()!.disabled).toBe(false);
  expect(installButton()!.dataset.inProgress).toBe("false");
  expect(old.downloadLink).toBe("https://example.com/old.zip");
});

const succeededPending = (): { completion: EngineCompletion; applying: boolean } => ({
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
});

test("a partially applied current binary still exposes Install to rejoin its original completion", async () => {
  mocks.pending = succeededPending();
  const current = { ...old, downloadLink: catalog.downloadLink };
  await render(current);
  expect(host.textContent).toContain("Common.Install");
  expect(installButton()!.disabled).toBe(false);
  await click();
  expect(mocks.installJob).toHaveBeenCalledExactlyOnceWith(
    catalog,
    progressId,
    current,
    expect.anything(),
  );
});

test("the current catalog choice remains disabled with no pending completion", async () => {
  await render({ ...old, downloadLink: catalog.downloadLink });
  expect(host.textContent).toContain("Engines.Upgrade.Current");
  expect(installButton()!.disabled).toBe(true);
});

test("catalog failures use the existing localized load error", async () => {
  mocks.catalogError = new Error("catalog unavailable");
  await render();
  expect(host.textContent).toContain("Engines.Upgrade.ErrorLoad");
  expect(installButton()).toBeNull();
});

test("inherited job cancel from the card uses the card progress id", async () => {
  mocks.hasJob = true;
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="cancel"]')!.click());
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(progressId, "Common.Error");
});

test("closing the modal cancels an inherited job for a card id", async () => {
  mocks.hasJob = true;
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="close"]')!.click());
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(progressId, "Common.Error");
});

test("closing does not cancel when a succeeded completion is pending", async () => {
  mocks.hasJob = true;
  mocks.pending = succeededPending();
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="close"]')!.click());
  expect(mocks.cancel).not.toHaveBeenCalled();
});

test("closing does not cancel when no job is running", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="close"]')!.click());
  expect(mocks.cancel).not.toHaveBeenCalled();
});

test("a remounted modal disables other cards while an inherited job runs", async () => {
  mocks.catalogs = [catalog, { ...catalog, downloadLink: "https://example.com/other.zip" }];
  mocks.hasJob = true;
  await render();
  const other = installButton(1);
  expect(other).not.toBeNull();
  expect(other!.disabled).toBe(true);
  await act(async () => other!.click());
  expect(mocks.installJob).not.toHaveBeenCalled();
});
