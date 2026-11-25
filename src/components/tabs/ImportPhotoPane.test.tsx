import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSummary, ModelInfo, ScoresheetGame } from "@/bindings";
import { CoachCommandError } from "@/platform/coach";
import { tabFamily, tabsAtom } from "@/state/atoms";
import {
  clearAllScoresheetPhotosForTests,
  formatScoresheetIntakeCounts,
  getScoresheetPhotos,
  scoresheetNoticeAcceptedAtom,
} from "@/state/scoresheetPhotos";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import { defaultTree } from "@/utils/treeReducer";
import ImportPhotoPane from "./ImportPhotoPane";

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);

const CONNECTION: ConnectionSummary = {
  handle: "conn-1",
  kind: "api",
  label: "Local model",
  address: "http://localhost:11434/v1",
  hasKey: false,
  account: null,
  status: "ready",
};

const MODEL: ModelInfo = {
  id: "vision-model",
  name: "Vision Model",
  effortLevels: [],
  defaultEffort: null,
  supportsTools: false,
};

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  warnSafely: vi.fn(),
  coachAvailable: vi.fn(),
  coachHasConnection: vi.fn(),
  coachConnections: vi.fn(),
  coachModels: vi.fn(),
  scoresheetPickPhotos: vi.fn(),
  scoresheetPastePhoto: vi.fn(),
  scoresheetTakeDroppedPhotos: vi.fn(),
  scoresheetRead: vi.fn(),
  buildScoresheetTree: vi.fn(),
  modelSelection: {
    connection: null as ConnectionSummary | null,
    model: null as ModelInfo | null,
    effort: null as string | null,
    hint: null as string | null,
  },
  dropRegistrationError: null as Error | null,
  dropListeners: new Set<(event: { payload: { drop: string } }) => void>(),
  unlistenCount: 0,
}));

vi.mock("@/platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/errors")>()),
  warnSafely: (message: string) => mocks.warnSafely(message),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    coachAvailable: () => mocks.coachAvailable(),
    coachHasConnection: () => mocks.coachHasConnection(),
    coachConnections: () => mocks.coachConnections(),
    coachModels: (handle: string) => mocks.coachModels(handle),
    scoresheetPickPhotos: () => mocks.scoresheetPickPhotos(),
    scoresheetPastePhoto: () => mocks.scoresheetPastePhoto(),
    scoresheetTakeDroppedPhotos: (drop: string) => mocks.scoresheetTakeDroppedPhotos(drop),
    scoresheetRead: (read: unknown, opts?: unknown) => mocks.scoresheetRead(read, opts),
  },
  tauriSubscriptions: {
    scoresheetPhotosDropped: async (callback: (event: { payload: { drop: string } }) => void) => {
      if (mocks.dropRegistrationError) {
        throw mocks.dropRegistrationError;
      }
      mocks.dropListeners.add(callback);
      return () => {
        mocks.dropListeners.delete(callback);
        mocks.unlistenCount += 1;
      };
    },
  },
}));

vi.mock("@/utils/scoresheet", () => ({
  buildScoresheetTree: (game: unknown, opts?: unknown) => mocks.buildScoresheetTree(game, opts),
}));

vi.mock("@/components/panels/coach/AiModelSelection", () => ({
  useAiModelSelection: () => ({
    connectionsState: {
      status: "ready",
      connections: mocks.modelSelection.connection ? [mocks.modelSelection.connection] : [],
    },
    reloadConnections: vi.fn(),
    connections: mocks.modelSelection.connection ? [mocks.modelSelection.connection] : [],
    connection: mocks.modelSelection.connection?.handle ?? null,
    modelsState: {
      status: "ready",
      connection: mocks.modelSelection.connection?.handle ?? null,
      models: mocks.modelSelection.model ? [mocks.modelSelection.model] : [],
    },
    models: mocks.modelSelection.model ? [mocks.modelSelection.model] : [],
    chosen: {
      connection: mocks.modelSelection.connection,
      model: mocks.modelSelection.model,
      effort: mocks.modelSelection.effort,
    },
    selection: {
      connection: mocks.modelSelection.connection?.handle ?? null,
      model: mocks.modelSelection.model?.id ?? null,
      effort: mocks.modelSelection.effort,
    },
    setSelection: vi.fn(),
  }),
  aiSelectionHint: () => mocks.modelSelection.hint,
  AiModelButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="ai-model-button" disabled={disabled}>
      {mocks.modelSelection.model?.name ?? "Coach.ChooseModel"}
    </button>
  ),
}));

vi.mock("@/components/panels/coach/AiNoticeModal", async () => {
  const { AppModal } = await import("@/components/common/AppModal");
  return {
    AiNoticeModal: ({
      title,
      body,
      acceptLabel,
      onCancel,
      onAccept,
    }: {
      title: string;
      body: string;
      acceptLabel: string;
      onCancel: () => void;
      onAccept: () => void;
    }) => (
      <AppModal opened onClose={onCancel} title={title}>
        <div data-testid="ai-notice-modal">
          <div>{title}</div>
          <div>{body}</div>
          <button type="button" onClick={onCancel}>
            NoticeCancel
          </button>
          <button type="button" onClick={onAccept}>
            {acceptLabel}
          </button>
        </div>
      </AppModal>
    ),
  };
});

vi.mock("@mantine/core", () => ({
  Anchor: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Button: ({ children, leftSection, rightSection, fullWidth: _fw, radius: _r, ...props }: any) => (
    <button type="button" {...props}>
      {leftSection}
      {children}
      {rightSection}
    </button>
  ),
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Modal: ({ opened, children }: any) => (opened ? <div data-mock-modal>{children}</div> : null),
  Text: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const parts = Object.entries(options)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      return `${key}(${parts})`;
    },
  }),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => null;
  return {
    ...(await importOriginal<typeof import("lucide-react")>()),
    Clipboard: Icon,
    ImagePlus: Icon,
    X: Icon,
  };
});

vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, ...props }: any) => (
    <button type="button" aria-label={label} {...props}>
      {children}
    </button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PHOTO_1 = "data:image/jpeg;base64,AAAA";
const PHOTO_2 = "data:image/jpeg;base64,BBBB";
const PHOTO_3 = "data:image/jpeg;base64,CCCC";
const PHOTO_4 = "data:image/jpeg;base64,DDDD";
const PHOTO_5 = "data:image/jpeg;base64,EEEE";

const SAMPLE_GAME: ScoresheetGame = {
  headers: {
    white: "Alice",
    black: "Bob",
    event: "Club",
    site: "",
    date: "2026.11.24",
    round: "",
    result: "1-0",
    whiteElo: "",
    blackElo: "",
  },
  moves: [
    { san: "e4", unsure: false },
    { san: "e5", unsure: true },
  ],
  stopped: null,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  clearAllScoresheetPhotosForTests();
  mocks.dropRegistrationError = null;
  mocks.dropListeners.clear();
  mocks.unlistenCount = 0;
  mocks.coachAvailable.mockResolvedValue(true);
  mocks.coachHasConnection.mockResolvedValue(true);
  mocks.modelSelection = {
    connection: CONNECTION,
    model: MODEL,
    effort: null,
    hint: null,
  };
  mocks.buildScoresheetTree.mockImplementation(async () => {
    const tree = defaultTree();
    tree.headers.white = "Alice";
    tree.headers.black = "Bob";
    tree.scoresheetReview = {};
    tree.dirty = true;
    return tree;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderPane(options?: {
  hasConnection?: boolean;
  ownerId?: string;
  onClose?: () => void;
  replaceImportedTab?: any;
  onReadingChange?: (reading: boolean) => void;
  noticeAccepted?: string[];
  tabs?: { value: string; name: string; type: "new" | "analysis"; gameOrigin: { kind: "none" } }[];
}) {
  mocks.coachAvailable.mockResolvedValue(true);
  mocks.coachHasConnection.mockResolvedValue(options?.hasConnection ?? true);
  const store = createStore();
  if (options?.noticeAccepted) {
    store.set(scoresheetNoticeAcceptedAtom, options.noticeAccepted);
  }
  if (options?.tabs) {
    store.set(tabsAtom, options.tabs as never);
  }
  await act(async () => {
    root.render(
      <Provider store={store}>
        <ImportPhotoPane
          ownerId={options?.ownerId ?? "owner-tab"}
          onClose={options?.onClose}
          replaceImportedTab={options?.replaceImportedTab}
          onReadingChange={options?.onReadingChange}
        />
      </Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return store;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

async function addOnePhoto() {
  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }],
    skipped: 0,
    failed: 0,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
}

test("without a connection shows hint, navigates to AI settings, and subscribes to no drop events", async () => {
  const onClose = vi.fn();
  const store = await renderPane({ hasConnection: false, onClose });

  expect(host.querySelector("[data-scoresheet-no-connection]")?.textContent).toContain(
    "Scoresheet.Intake.NeedsConnection",
  );
  expect(host.querySelector("[data-scoresheet-intake-pane]")).toBeNull();
  expect(mocks.dropListeners.size).toBe(0);

  await act(async () => {
    buttonByText("Scoresheet.Intake.OpenAiSettings").click();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(store.get(settingsNavigationRequestAtom)).toMatchObject({
    target: {
      kind: "category",
      category: "coach",
    },
  });
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings" });
});

test("choosing photos appends thumbnails in order, removes one, caps at 4, and reports skipped/failed", async () => {
  await renderPane({ hasConnection: true });

  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }, { dataUrl: PHOTO_2 }],
    skipped: 0,
    failed: 1,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });

  let images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([PHOTO_1, PHOTO_2]);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Failed(count=1)",
  );

  const removeBtn = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Scoresheet.Intake.RemovePhoto(number=1)"]',
  )!;
  await act(async () => {
    removeBtn.click();
  });
  images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([PHOTO_2]);

  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [
      { dataUrl: PHOTO_1 },
      { dataUrl: PHOTO_3 },
      { dataUrl: PHOTO_4 },
      { dataUrl: PHOTO_5 },
    ],
    skipped: 1,
    failed: 0,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });

  images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([
    PHOTO_2,
    PHOTO_1,
    PHOTO_3,
    PHOTO_4,
  ]);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Skipped(count=2)",
  );
});

test("paste button and Ctrl/Cmd+V paste when no text field is focused, and respect quiet/error codes", async () => {
  await renderPane({ hasConnection: true });

  const input = document.createElement("input");
  host.append(input);
  input.focus();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).not.toHaveBeenCalled();
  input.blur();

  mocks.scoresheetPastePhoto.mockResolvedValueOnce({ dataUrl: PHOTO_1 });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll("img")).toHaveLength(1);

  mocks.scoresheetPastePhoto.mockRejectedValueOnce(new CoachCommandError("clipboardEmpty"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.PasteFromClipboard").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Coach.Error.ClipboardEmpty",
  );

  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("cancelled"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();

  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("unavailable"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Error.Unavailable",
  );

  mocks.scoresheetPastePhoto.mockRejectedValueOnce(new CoachCommandError("network"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.PasteFromClipboard").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Coach.Error.Network",
  );

  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_2 }, { dataUrl: PHOTO_3 }, { dataUrl: PHOTO_4 }],
    skipped: 0,
    failed: 0,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelectorAll("img")).toHaveLength(4);
  mocks.scoresheetPastePhoto.mockClear();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).not.toHaveBeenCalled();
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Skipped(count=1)",
  );

  const t = (key: string, options?: Record<string, unknown>) =>
    `${key}(${Object.entries(options ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",")})`;
  expect(formatScoresheetIntakeCounts({ skipped: 2, failed: 1 }, t)).toBe(
    "Scoresheet.Intake.Skipped(count=2) Scoresheet.Intake.Failed(count=1)",
  );
});

test("drop subscription takes dropped photos while open, shows visible errors, stays quiet on notFound, and unsubscribes on unmount", async () => {
  await renderPane({ hasConnection: true });
  expect(mocks.dropListeners.size).toBe(1);

  mocks.scoresheetTakeDroppedPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }],
    skipped: 0,
    failed: 0,
  });
  const [listener] = [...mocks.dropListeners];
  await act(async () => {
    listener({ payload: { drop: "drop-1" } });
    await Promise.resolve();
  });
  expect(mocks.scoresheetTakeDroppedPhotos).toHaveBeenCalledWith("drop-1");
  expect(host.querySelectorAll("img")).toHaveLength(1);

  mocks.scoresheetTakeDroppedPhotos.mockRejectedValueOnce(new CoachCommandError("unavailable"));
  await act(async () => {
    listener({ payload: { drop: "drop-error" } });
    await Promise.resolve();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Error.Unavailable",
  );

  mocks.scoresheetTakeDroppedPhotos.mockRejectedValueOnce(new CoachCommandError("notFound"));
  await act(async () => {
    listener({ payload: { drop: "drop-stale" } });
    await Promise.resolve();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();

  await act(async () => {
    root.unmount();
  });
  expect(mocks.dropListeners.size).toBe(0);
  expect(mocks.unlistenCount).toBe(1);
  mocks.scoresheetTakeDroppedPhotos.mockClear();
  listener({ payload: { drop: "drop-after-unmount" } });
  expect(mocks.scoresheetTakeDroppedPhotos).not.toHaveBeenCalled();
});

test("failed drop listener registration logs through warnSafely without showing an intake error", async () => {
  mocks.dropRegistrationError = new Error("ipc listen refused");
  await renderPane({ hasConnection: true });
  expect(mocks.warnSafely).toHaveBeenCalledWith(
    "Scoresheet photo drop listener failed: ipc listen refused",
  );
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();
});

test("first-use notice blocks sending until accepted, then reads, builds tree, stores photos, selects Photo panel and closes", async () => {
  const onClose = vi.fn();
  const replaceImportedTab = vi.fn(() => ({ kind: "committed" as const, id: "review-tab-1" }));
  const store = await renderPane({ hasConnection: true, onClose, replaceImportedTab });

  await addOnePhoto();
  mocks.scoresheetRead.mockResolvedValueOnce(SAMPLE_GAME);

  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  // First use opens notice and sends nothing yet.
  expect(host.querySelector('[data-testid="ai-notice-modal"]')).not.toBeNull();
  expect(mocks.scoresheetRead).not.toHaveBeenCalled();

  await act(async () => {
    buttonByText("Scoresheet.Notice.Accept").click();
  });

  expect(store.get(scoresheetNoticeAcceptedAtom)).toContain(CONNECTION.handle);
  expect(mocks.scoresheetRead).toHaveBeenCalledOnce();
  expect(replaceImportedTab).toHaveBeenCalledOnce();
  expect(getScoresheetPhotos("review-tab-1")).toEqual([PHOTO_1]);
  expect(store.get(tabFamily("review-tab-1"))).toBe("photo");
  expect(onClose).toHaveBeenCalledOnce();
});

test("cancel, owner tab close, and unmount abort the read signal and a cancelled or superseded read shows nothing", async () => {
  const onReadingChange = vi.fn();
  const replaceImportedTab = vi.fn(() => ({ kind: "committed" as const, id: "review-tab-2" }));
  let capturedSignal: AbortSignal | undefined;
  let resolveFirst!: (g: ScoresheetGame) => void;
  mocks.scoresheetRead.mockImplementationOnce(
    (_input: unknown, opts: { signal: AbortSignal }) =>
      new Promise<ScoresheetGame>((resolve) => {
        capturedSignal = opts.signal;
        resolveFirst = resolve;
      }),
  );

  const store = await renderPane({
    hasConnection: true,
    ownerId: "owner-1",
    noticeAccepted: [CONNECTION.handle],
    replaceImportedTab,
    onReadingChange,
    tabs: [{ value: "owner-1", name: "New tab", type: "new", gameOrigin: { kind: "none" } }],
  });
  await addOnePhoto();

  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector("[data-scoresheet-reading]")?.textContent).toContain(
    "Scoresheet.Read.PendingHint",
  );
  expect(onReadingChange).toHaveBeenCalledWith(true);

  // Cancel aborts signal and shows nothing.
  await act(async () => {
    buttonByText("Common.Cancel").click();
  });
  expect(capturedSignal?.aborted).toBe(true);
  expect(host.querySelector("[data-scoresheet-read-error]")).toBeNull();

  // Start Read 2 while Read 1 is still pending (overlapping superseded read).
  let resolveSecond!: (g: ScoresheetGame) => void;
  mocks.scoresheetRead.mockImplementationOnce(
    () =>
      new Promise<ScoresheetGame>((resolve) => {
        resolveSecond = resolve;
      }),
  );
  onReadingChange.mockClear();
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(onReadingChange).toHaveBeenCalledWith(true);
  expect(host.querySelector("[data-scoresheet-reading]")).not.toBeNull();

  // Read 1 settles late while Read 2 is active: Read 1's result is ignored and Read 2 stays pending.
  await act(async () => {
    resolveFirst(SAMPLE_GAME);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(replaceImportedTab).not.toHaveBeenCalled();
  expect(host.querySelector("[data-scoresheet-reading]")).not.toBeNull();
  expect(onReadingChange).not.toHaveBeenCalledWith(false);

  // Settle Read 2 cleanly before testing owner-tab close.
  await act(async () => {
    resolveSecond(SAMPLE_GAME);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(replaceImportedTab).toHaveBeenCalledTimes(1);

  // Closing the owner tab aborts an in-flight read.
  let secondSignal: AbortSignal | undefined;
  mocks.scoresheetRead.mockImplementationOnce(
    (_input: unknown, opts: { signal: AbortSignal }) =>
      new Promise<ScoresheetGame>(() => {
        secondSignal = opts.signal;
      }),
  );
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(secondSignal?.aborted).toBe(false);
  await act(async () => {
    store.set(tabsAtom, [
      { value: "other-tab", name: "Other", type: "new", gameOrigin: { kind: "none" } },
    ]);
  });
  expect(secondSignal?.aborted).toBe(true);

  // Unmount aborts an in-flight read as well.
  let thirdSignal: AbortSignal | undefined;
  mocks.scoresheetRead.mockImplementationOnce(
    (_input: unknown, opts: { signal: AbortSignal }) =>
      new Promise<ScoresheetGame>(() => {
        thirdSignal = opts.signal;
      }),
  );
  await act(async () => {
    buttonByText("Common.Cancel").click();
  });
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(thirdSignal?.aborted).toBe(false);
  await act(async () => {
    root.unmount();
  });
  expect(thirdSignal?.aborted).toBe(true);
});

test("provider failure, parse mismatch, and non-committed tab result show the right message and keep photos", async () => {
  const onClose = vi.fn();
  const replaceImportedTab = vi.fn(() => ({ kind: "superseded" as const }));
  await renderPane({
    hasConnection: true,
    onClose,
    replaceImportedTab,
    noticeAccepted: [CONNECTION.handle],
  });
  await addOnePhoto();

  // Provider error shows the feature's error message under the button; photos stay.
  mocks.scoresheetRead.mockRejectedValueOnce(new CoachCommandError("imagesUnsupported"));
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector("[data-scoresheet-read-error]")?.textContent).toBe(
    "Coach.Error.ImagesUnsupported",
  );
  expect(host.querySelectorAll("img")).toHaveLength(1);

  // Parse/length mismatch shows pane's own "could not open" message, never a provider error.
  mocks.scoresheetRead.mockResolvedValueOnce(SAMPLE_GAME);
  mocks.buildScoresheetTree.mockRejectedValueOnce(new Error("Scoresheet move count mismatch"));
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector("[data-scoresheet-read-error]")?.textContent).toBe(
    "Scoresheet.Read.CouldNotOpen",
  );
  expect(host.querySelectorAll("img")).toHaveLength(1);

  // Non-committed replaceImportedTab result shows "could not open", keeps photos, does not close.
  mocks.scoresheetRead.mockResolvedValueOnce(SAMPLE_GAME);
  mocks.buildScoresheetTree.mockResolvedValueOnce(defaultTree());
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector("[data-scoresheet-read-error]")?.textContent).toBe(
    "Scoresheet.Read.CouldNotOpen",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelectorAll("img")).toHaveLength(1);
  // Build failure was logged via warnSafely.
  expect(mocks.warnSafely).toHaveBeenCalledWith(
    expect.stringContaining("Scoresheet tree build failed:"),
  );

  // Throwing during tab opening logs via warnSafely, shows "could not open", and keeps photos.
  mocks.warnSafely.mockClear();
  replaceImportedTab.mockImplementationOnce(() => {
    throw new Error("tab storage quota exceeded");
  });
  mocks.scoresheetRead.mockResolvedValueOnce(SAMPLE_GAME);
  mocks.buildScoresheetTree.mockResolvedValueOnce(defaultTree());
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector("[data-scoresheet-read-error]")?.textContent).toBe(
    "Scoresheet.Read.CouldNotOpen",
  );
  expect(mocks.warnSafely).toHaveBeenCalledWith(
    expect.stringContaining("Scoresheet tab open failed:"),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelectorAll("img")).toHaveLength(1);
});

test("missing model or connection shows selection hint and disables Read game", async () => {
  mocks.modelSelection = {
    connection: CONNECTION,
    model: null,
    effort: null,
    hint: "Coach.Hint.ChooseModel",
  };
  await renderPane({ hasConnection: true });
  await addOnePhoto();
  expect(host.querySelector("[data-scoresheet-selection-hint]")?.textContent).toBe(
    "Coach.Hint.ChooseModel",
  );
  expect(buttonByText("Scoresheet.Read.Button").disabled).toBe(true);

  mocks.modelSelection = {
    connection: null,
    model: null,
    effort: null,
    hint: "Coach.Hint.ChooseConnection",
  };
  await renderPane({ hasConnection: true });
  await addOnePhoto();
  expect(host.querySelector("[data-scoresheet-selection-hint]")?.textContent).toBe(
    "Coach.Hint.ChooseConnection",
  );
  expect(buttonByText("Scoresheet.Read.Button").disabled).toBe(true);
});

test("Escape on the first-use notice closes only the notice and keeps the enclosing dialog and photos", async () => {
  const { AppModal } = await import("@/components/common/AppModal");
  const { dispatchEscape } = await import("@/tests/keyboard");
  const onOuterClose = vi.fn();
  const store = createStore();

  await act(async () => {
    root.render(
      <Provider store={store}>
        <AppModal opened onClose={onOuterClose} title="Import">
          <ImportPhotoPane ownerId="owner-tab" onClose={onOuterClose} />
        </AppModal>
      </Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await addOnePhoto();
  await act(async () => {
    buttonByText("Scoresheet.Read.Button").click();
  });
  expect(host.querySelector('[data-testid="ai-notice-modal"]')).not.toBeNull();

  // First Escape closes only the notice; outer dialog stays open and photos remain.
  await act(async () => {
    dispatchEscape(document.body);
  });
  expect(host.querySelector('[data-testid="ai-notice-modal"]')).toBeNull();
  expect(onOuterClose).not.toHaveBeenCalled();
  expect(host.querySelectorAll("img")).toHaveLength(1);
});

test.each(Object.entries(catalogues))(
  "ships scoresheet intake, read, notice, and error copy in %s with fallback disabled",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    const cases: readonly (readonly [string, Record<string, string | number> | undefined])[] = [
      ["Coach.Error.PhotoUnreadable", undefined],
      ["Coach.Error.ClipboardEmpty", undefined],
      ["Coach.Error.ImagesUnsupported", undefined],
      ["Coach.Error.ScoresheetUnreadable", undefined],
      ["Import.FromPhoto", undefined],
      ["Scoresheet.Error.Busy", undefined],
      ["Scoresheet.Error.LimitExceeded", undefined],
      ["Scoresheet.Error.Unavailable", undefined],
      ["Scoresheet.Error.InvalidInput", undefined],
      ["Scoresheet.LoadPhotoAgain", undefined],
      ["Scoresheet.Intake.NeedsConnection", undefined],
      ["Scoresheet.Intake.OpenAiSettings", undefined],
      ["Scoresheet.Intake.ChoosePhotos", undefined],
      ["Scoresheet.Intake.PasteFromClipboard", undefined],
      ["Scoresheet.Intake.DropHint", undefined],
      ["Scoresheet.Intake.RemovePhoto", { number: 1 }],
      ["Scoresheet.Intake.Skipped", { count: 1 }],
      ["Scoresheet.Intake.Skipped", { count: 3 }],
      ["Scoresheet.Intake.Failed", { count: 1 }],
      ["Scoresheet.Intake.Failed", { count: 2 }],
      ["Scoresheet.Read.Button", undefined],
      ["Scoresheet.Read.PendingHint", undefined],
      ["Scoresheet.Read.CouldNotOpen", undefined],
      ["Scoresheet.Notice.Title", undefined],
      ["Scoresheet.Notice.Body", { provider: "Local model" }],
      ["Scoresheet.Notice.Accept", undefined],
    ];
    for (const [key, opts] of cases) {
      const value = String(opts ? i18n.t(key, opts) : i18n.t(key));
      expect(value.trim()).toBeTruthy();
      expect(value).not.toBe(key);
    }
  },
);
