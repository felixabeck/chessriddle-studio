import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogVerificationError } from "@/utils/signedCatalog";
import { defaultPuzzleDatabaseProgressId } from "@/utils/db";
import AddPuzzle from "./AddPuzzle";
import {
  expectRestoredDownloadCancellation,
  resetProgressButtonTestHarness,
} from "@/tests/progressButtonTestHarness";

const mocks = await vi.hoisted(async () => {
  const { createProgressButtonTestHarness } = await import("@/tests/progressButtonTestHarness");
  return Object.assign(createProgressButtonTestHarness(), {
    catalogError: undefined as unknown,
    choosePuzzleDatabase: vi.fn(),
    getPuzzleDatabases: vi.fn(),
    notify: vi.fn(),
    defaultDatabases: undefined as unknown,
    issueDownloadDestination: vi.fn(),
    downloadFile: vi.fn(),
    withDownloadTicket: vi.fn((run: (ticket: string) => Promise<unknown>) =>
      run("prepared-ticket"),
    ),
  });
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("swr/immutable", () => ({
  default: () => ({ data: mocks.defaultDatabases, error: mocks.catalogError }),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("@/utils/puzzles", () => ({
  choosePuzzleDatabase: mocks.choosePuzzleDatabase,
  getPuzzleDatabases: mocks.getPuzzleDatabases,
}));
vi.mock("@/platform/errors", async (original) => ({
  ...(await original<typeof import("@/platform/errors")>()),
  normalizeError: () => ({ category: "unexpected", message: "Safe error" }),
  errorUnlessCancelled: (error: unknown) =>
    error instanceof Error && error.message === "Cancellation"
      ? null
      : {
          category: "unexpected",
          message: "Safe error",
          ...(typeof error === "object" && error !== null && "rootFailure" in error
            ? { rootFailure: error.rootFailure }
            : {}),
        },
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    issuePuzzleDownloadDestination: mocks.issueDownloadDestination,
    downloadFile: mocks.downloadFile,
    cancelDownload: mocks.cancelDownload,
    cancelDownloadForProgress: mocks.cancelDownloadForProgress,
    clearProgress: mocks.clearProgress,
    getProgress: mocks.getProgress,
  },
  tauriSubscriptions: {
    progress: mocks.subscribeProgress,
  },
  withDownloadTicket: mocks.withDownloadTicket,
}));
vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return {
    ...actual,
    getDefaultPuzzleDatabases: vi.fn(),
  };
});
vi.mock("@/utils/format", () => ({
  formatBytes: (value: number) => `${value} B`,
  formatNumber: String,
}));
vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  ScrollArea: { Autosize: ({ children }: any) => <div>{children}</div> },
  Stack: ({ children }: any) => <div>{children}</div>,
  Alert: ({ children }: any) => <div>{children}</div>,
  Box: ({ children }: any) => <div>{children}</div>,
  Divider: () => <hr />,
  Group: ({ children }: any) => <div>{children}</div>,
  Paper: ({ children }: any) => <div>{children}</div>,
  Progress: ({ value }: { value: number }) => <output data-progress>{value}</output>,
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ children, opened }: any) => (opened ? <div>{children}</div> : null),
}));
vi.mock("../common/ProgressButton", async (original) => {
  const { mockProgressButton } = await import("@/tests/progressButtonTestHarness");
  return mockProgressButton(mocks, await original<typeof import("../common/ProgressButton")>());
});
vi.mock("../common/IconAction", () => ({
  default: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tacticsManifest = {
  title: "Lichess",
  description: "Tactics",
  storageSize: 42,
  puzzleCount: 3,
  downloadLink: "https://example.test/tactics.db3",
  sha256: "a".repeat(64),
  signature: "signature",
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalogError = undefined;
  mocks.defaultDatabases = undefined;
  resetProgressButtonTestHarness(mocks);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

async function render() {
  const setOpened = vi.fn();
  const publish = vi.fn();
  const refreshPuzzleDbs = vi.fn(async (signal?: AbortSignal) => {
    const databases = await mocks.getPuzzleDatabases(signal);
    if (!signal?.aborted) publish(databases);
  });
  const onWorkspaceChanged = vi.fn();
  await act(async () =>
    root.render(
      <AddPuzzle
        opened
        setOpened={setOpened}
        puzzleDbs={[]}
        refreshPuzzleDbs={refreshPuzzleDbs}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    ),
  );
  return { setOpened, publish, refreshPuzzleDbs, onWorkspaceChanged };
}

test("refreshes puzzle databases and closes after choosing a workspace", async () => {
  mocks.choosePuzzleDatabase.mockResolvedValue(undefined);
  mocks.getPuzzleDatabases.mockResolvedValue([{ title: "Tactics.db3" }]);
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.choosePuzzleDatabase).toHaveBeenCalledOnce();
  expect(actions.onWorkspaceChanged).toHaveBeenCalledOnce();
  expect(actions.publish).toHaveBeenCalledWith([{ title: "Tactics.db3" }]);
  expect(actions.setOpened).toHaveBeenCalledWith(false);
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("keeps the modal open and shows a normalized non-cancelled picker failure", async () => {
  mocks.choosePuzzleDatabase.mockRejectedValue(new Error("native failure"));
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  expect(actions.onWorkspaceChanged).not.toHaveBeenCalled();
  expect(actions.setOpened).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "Safe error",
  });
});

test("keeps the modal open silently when choosing a workspace is cancelled", async () => {
  mocks.choosePuzzleDatabase.mockRejectedValue(new Error("Cancellation"));
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  expect(actions.setOpened).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("surfaces an ordinary preview-list failure after workspace selection", async () => {
  mocks.choosePuzzleDatabase.mockResolvedValue(undefined);
  mocks.getPuzzleDatabases.mockRejectedValue(new Error("listing failed"));
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  expect(actions.publish).not.toHaveBeenCalled();
  expect(actions.setOpened).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "Safe error",
  });
});

test("wires progress id from the download URL, not the manifest index", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  await render();
  expect(mocks.progressButtonProps?.id).toBe(
    defaultPuzzleDatabaseProgressId("https://example.test/tactics.db3"),
  );
  expect(mocks.progressButtonProps?.id).not.toBe("puzzle_db_0");
});

test("a running puzzle download with no local job renders Cancel and calls native lookup", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  mocks.realProgressButton = true;
  await render();
  await expectRestoredDownloadCancellation(
    mocks,
    host,
    defaultPuzzleDatabaseProgressId(tacticsManifest.downloadLink),
  );
});

test("keeps a cancelled download destination silent", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  mocks.issueDownloadDestination.mockRejectedValue(new Error("Cancellation"));
  const actions = await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  expect(actions.publish).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("installs a downloaded database and refreshes the visible collection", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  mocks.issueDownloadDestination.mockResolvedValue({ id: { id: "destination" }, kind: "path" });
  mocks.downloadFile.mockResolvedValue(undefined);
  mocks.getPuzzleDatabases.mockResolvedValue([{ title: "Lichess.db3" }]);
  const actions = await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  expect(mocks.downloadFile).toHaveBeenCalledOnce();
  expect(mocks.downloadFile).toHaveBeenCalledWith(
    defaultPuzzleDatabaseProgressId("https://example.test/tactics.db3"),
    tacticsManifest.downloadLink,
    { id: { id: "destination" }, kind: "path" },
    "Lichess.db3",
    null,
    "prepared-ticket",
    { sha256: tacticsManifest.sha256, signature: tacticsManifest.signature },
  );
  expect(mocks.progressButtonProps?.clearOnCancel).toBe(false);
  expect(actions.publish).toHaveBeenCalledWith([{ title: "Lichess.db3" }]);
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("reports a failed download without replacing the installed database list", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  mocks.issueDownloadDestination.mockRejectedValue(new Error("native failure"));
  const actions = await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  expect(actions.publish).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "Safe error",
  });
});

test("offers cancellation while setup is pending and keeps cancellation silent", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  let rejectDestination!: (error: unknown) => void;
  mocks.issueDownloadDestination.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectDestination = reject;
    }),
  );
  await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));

  const onCancel = mocks.progressButtonProps!.onCancel!;
  mocks.cancelDownload.mockImplementation(async (ticket: string) => {
    expect(ticket).toBe("prepared-ticket");
    rejectDestination(new Error("Cancellation"));
    return true;
  });
  await act(async () => onCancel());

  expect(mocks.cancelDownload).toHaveBeenCalledWith("prepared-ticket");
  expect(mocks.progressButtonProps?.clearOnCancel).toBe(false);
  expect(mocks.downloadFile).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("reports a job failure once when cancellation is followed by that failure", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  const failure = new Error("download failed after cancel");
  let rejectDestination!: (error: unknown) => void;
  mocks.issueDownloadDestination.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectDestination = reject;
    }),
  );
  await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockImplementation(async () => {
    rejectDestination(failure);
    return true;
  });

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toBe(failure);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
});

test("does not notify when cancellation loses the completed-job race", async () => {
  mocks.defaultDatabases = [tacticsManifest];
  let resolveDestination!: (value: unknown) => void;
  mocks.issueDownloadDestination.mockReturnValue(
    new Promise((resolve) => {
      resolveDestination = resolve;
    }),
  );
  mocks.downloadFile.mockResolvedValue(undefined);
  mocks.getPuzzleDatabases.mockResolvedValue([]);
  await render();
  await act(async () => host.querySelectorAll("button")[1].click());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockImplementation(async () => {
    resolveDestination({ id: { id: "destination" } });
    return false;
  });

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toMatchObject({ reason: "lost" });
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("unmount cancels a held workspace preview and refuses its stale database list", async () => {
  mocks.choosePuzzleDatabase.mockResolvedValue(undefined);
  let signal!: AbortSignal;
  let resolve!: (value: Array<{ title: string }>) => void;
  mocks.getPuzzleDatabases.mockImplementation(
    (nextSignal: AbortSignal) =>
      new Promise((done) => {
        signal = nextSignal;
        resolve = done;
      }),
  );
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  await vi.waitFor(() => expect(mocks.getPuzzleDatabases).toHaveBeenCalledOnce());
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  resolve([{ title: "Stale.db3" }]);
  await act(async () => Promise.resolve());
  expect(actions.publish).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("unmount during the accepted picker prevents a later preview", async () => {
  let finishPicker!: () => void;
  mocks.choosePuzzleDatabase.mockReturnValue(
    new Promise<void>((resolve) => {
      finishPicker = resolve;
    }),
  );
  const actions = await render();
  await act(async () => host.querySelector("button")!.click());
  await act(async () => root.unmount());
  await act(async () => finishPicker());
  expect(actions.onWorkspaceChanged).toHaveBeenCalledOnce();
  expect(mocks.getPuzzleDatabases).not.toHaveBeenCalled();
  expect(actions.publish).not.toHaveBeenCalled();
  expect(actions.setOpened).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("shows the catalog verification error instead of the fetch error", async () => {
  mocks.catalogError = new CatalogVerificationError(new Error("bad signature"));
  await render();
  expect(host.textContent).toContain("Databases.Add.ErrorCatalog");
  expect(host.textContent).not.toContain("Databases.Add.ErrorFetch");
});

test("keeps the fetch error for other catalog failures", async () => {
  mocks.catalogError = new Error("offline");
  await render();
  expect(host.textContent).toContain("Databases.Add.ErrorFetch");
  expect(host.textContent).not.toContain("Databases.Add.ErrorCatalog");
});

test.each(["picker", "destination"] as const)(
  "%s root refusal shows the puzzle sentence",
  async (surface) => {
    const failure = {
      tag: "backend-error",
      category: "io",
      message: "native failure",
      rootFailure: "missing",
    };
    if (surface === "picker") mocks.choosePuzzleDatabase.mockRejectedValue(failure);
    else {
      mocks.defaultDatabases = [tacticsManifest];
      mocks.issueDownloadDestination.mockRejectedValue(failure);
    }
    const actions = await render();
    await act(async () => host.querySelectorAll("button")[surface === "picker" ? 0 : 1].click());
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: "This puzzle folder is no longer available. Choose another in Settings.",
    });
    expect(actions.publish).not.toHaveBeenCalled();
    expect(actions.setOpened).not.toHaveBeenCalled();
  },
);
