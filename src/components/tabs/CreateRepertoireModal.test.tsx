import { Result } from "@badrap/result";
import { act, type HTMLAttributes, type InputHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LexPgnGamesOutcome } from "@/bindings";
import { tauri, TauriCommandError } from "@/platform/tauri";

const fixtures = vi.hoisted(() => ({
  countPgnGames: vi.fn(),
  createFile: vi.fn(),
  ensureFileWorkspace: vi.fn(),
  fileRevision: vi.fn(),
  lexPgn: vi.fn(),
  lexPgnGames: vi.fn(),
  navigate: vi.fn(),
  notificationsShow: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  openFile: vi.fn(),
  pickPgnFile: vi.fn(),
  readGames: vi.fn(),
  setTabs: vi.fn(),
  storeSet: vi.fn(),
  warnSafely: vi.fn(),
}));

vi.mock("@/state/atoms", () => ({
  activeTabAtom: Symbol("active-tab"),
  addRecentFileAtom: Symbol("add-recent-file"),
  tabFamily: () => Symbol("tab-family"),
  tabsAtom: Symbol("tabs"),
}));
vi.mock("@/utils/chess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/chess")>();
  return {
    ...actual,
    headersToPGN: () => '[Event "White"]\n\n*',
  };
});
vi.mock("@/utils/files", () => ({
  createFile: fixtures.createFile,
  ensureFileWorkspace: fixtures.ensureFileWorkspace,
  pickPgnFile: fixtures.pickPgnFile,
}));
vi.mock("@/utils/openFile", () => ({
  openFile: fixtures.openFile,
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: fixtures.notifyUnlessCancelled,
  runUnlessCancelled: async (_title: string, action: () => Promise<void>) => action(),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: fixtures.notificationsShow },
}));
vi.mock("@/platform/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/errors")>();
  return {
    ...actual,
    warnSafely: fixtures.warnSafely,
  };
});
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      countPgnGames: fixtures.countPgnGames,
      fileRevision: fixtures.fileRevision,
      lexPgn: fixtures.lexPgn,
      lexPgnGames: fixtures.lexPgnGames,
      readGames: fixtures.readGames,
    },
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixtures.navigate }));
vi.mock("jotai", async (original) => ({
  ...(await original<typeof import("jotai")>()),
  useAtom: (atom: symbol) => (atom.description === "tabs" ? [[], fixtures.setTabs] : [[], vi.fn()]),
  useSetAtom: () => vi.fn(),
  useStore: () => ({ set: fixtures.storeSet }),
}));
vi.mock("react-i18next", async () => {
  const { default: catalogue } = await import("@/translation/en-US.json");
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) =>
        key === "Common.NameAlreadyUsed"
          ? catalogue.translation["Common.NameAlreadyUsed"]
          : (options?.defaultValue ?? key),
    }),
  };
});
vi.mock("../common/AppModal", async () => ({
  default: (await import("@/tests/appModal")).PendingAppModal,
}));
vi.mock("@mantine/core", () => ({
  Button: ({
    loading,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string }) => (
    <button {...props} disabled={props.disabled || loading} aria-busy={loading} />
  ),
  Divider: () => <hr />,
  FileInput: ({ onClick, disabled }: { onClick?: () => void; disabled?: boolean }) => (
    <button type="button" data-testid="choose-file" disabled={disabled} onClick={onClick}>
      Choose file
    </button>
  ),
  SegmentedControl: ({
    disabled,
    value,
    onChange,
    data,
  }: {
    disabled?: boolean;
    value?: string;
    onChange?: (value: string) => void;
    data?: { label: string; value: string }[];
  }) => (
    <fieldset aria-label="Color" disabled={disabled}>
      {(data ?? []).map((item) => (
        <button
          key={item.value}
          type="button"
          data-testid={`color-${item.value}`}
          aria-pressed={value === item.value}
          onClick={() => onChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  ),
  Stack: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  TextInput: ({ error, ...props }: InputHTMLAttributes<HTMLInputElement> & { error?: string }) => (
    <label>
      <input {...props} />
      {error && <span role="alert">{error}</span>}
    </label>
  ),
}));

import CreateRepertoireModal from "./CreateRepertoireModal";
import * as createRepertoireModule from "./createRepertoireFromPgn";
import {
  repertoireImportErrorMessage,
  repertoireMergeRefusalMessage,
} from "./createRepertoireFromPgn";
import { cancellationError } from "@/platform/tauri";
import { RepertoireImportError } from "@/utils/repertoireImport";

// Load the real recovery facade before a test starts, so its module loading cannot outlive a test.
const actualFiles = await vi.importActual<typeof import("@/utils/files")>("@/utils/files");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const setOpened = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.fileRevision.mockResolvedValue("rev1");
  fixtures.ensureFileWorkspace.mockResolvedValue({ id: { id: "workspace" } });
  fixtures.openFile.mockResolvedValue("tab-id");
  fixtures.createFile.mockResolvedValue({
    isErr: false,
    value: {
      type: "file",
      name: "White",
      handle: { id: { id: "file" }, kind: "fileWorkspace" },
      numGames: 1,
      metadata: { type: "repertoire", tags: [] },
      lastModified: 1,
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

async function submitRepertoire() {
  await act(async () => {
    root.render(<CreateRepertoireModal opened setOpened={setOpened} />);
  });
  const input = container.querySelector("input")!;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    valueSetter.call(input, "White");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => submitForm());
}

function submitForm() {
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("pending creation prevents dismissal and disables draft edits", async () => {
  const creation = deferred<Awaited<ReturnType<typeof actualFiles.createFile>>>();
  fixtures.createFile.mockReturnValueOnce(creation.promise);

  await submitRepertoire();

  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");
  expect(container.querySelector('[aria-label="Close dialog"]')).toBeNull();
  expect(container.querySelector("input")?.disabled).toBe(true);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  expect(container.querySelector('[type="submit"]')?.getAttribute("aria-busy")).toBe("true");
  expect(setOpened).not.toHaveBeenCalled();
});

test("repeated submits during creation are single-flight", async () => {
  const creation = deferred<Awaited<ReturnType<typeof actualFiles.createFile>>>();
  fixtures.createFile.mockReturnValue(creation.promise);

  await submitRepertoire();
  await act(async () => {
    submitForm();
    submitForm();
  });

  expect(fixtures.ensureFileWorkspace).toHaveBeenCalledOnce();
  expect(fixtures.createFile).toHaveBeenCalledOnce();
  expect(fixtures.openFile).not.toHaveBeenCalled();
});

test.each(["reject", "Err"])(
  "delayed creation %s clears pending, preserves the draft, and permits a successful retry",
  async (failure) => {
    const creation = deferred<Awaited<ReturnType<typeof actualFiles.createFile>>>();
    fixtures.createFile.mockReturnValueOnce(creation.promise);
    await submitRepertoire();
    expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");

    await act(async () => {
      const error = new Error("Creation failed");
      if (failure === "reject") creation.reject(error);
      else creation.resolve(Result.err(error));
    });

    expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("false");
    expect(container.querySelector('[aria-label="Close dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Creation failed");
    expect(container.querySelector("input")?.value).toBe("White");
    expect(container.querySelector("input")?.disabled).toBe(false);
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
    expect(fixtures.openFile).not.toHaveBeenCalled();
    expect(fixtures.navigate).not.toHaveBeenCalled();
    expect(setOpened).not.toHaveBeenCalled();

    await act(async () => submitForm());

    expect(fixtures.createFile).toHaveBeenCalledTimes(2);
    expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
    expect(setOpened).toHaveBeenCalledExactlyOnceWith(false);
  },
);

test("delayed creation success clears pending and completes exactly once", async () => {
  const result = await fixtures.createFile();
  fixtures.createFile.mockClear();
  const creation = deferred<typeof result>();
  fixtures.createFile.mockReturnValueOnce(creation.promise);
  await submitRepertoire();
  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");

  await act(async () => creation.resolve(result));

  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("false");
  expect(container.querySelector('[type="submit"]')?.getAttribute("aria-busy")).toBe("false");
  expect(container.querySelector("input")?.value).toBe("");
  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  expect(setOpened).toHaveBeenCalledExactlyOnceWith(false);
});

test("pending tab admission prevents dismissal and repeated creation until it completes once", async () => {
  const admission = deferred<string | null>();
  fixtures.openFile.mockReturnValueOnce(admission.promise);

  await submitRepertoire();

  expect(fixtures.createFile).toHaveBeenCalledOnce();
  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");
  expect(container.querySelector('[aria-label="Close dialog"]')).toBeNull();
  expect(container.querySelector('[type="submit"]')?.getAttribute("aria-busy")).toBe("true");
  expect(fixtures.navigate).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();

  await act(async () => {
    submitForm();
    submitForm();
  });

  expect(fixtures.ensureFileWorkspace).toHaveBeenCalledOnce();
  expect(fixtures.createFile).toHaveBeenCalledOnce();
  expect(fixtures.openFile).toHaveBeenCalledOnce();

  await act(async () => admission.resolve("tab-id"));

  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  expect(setOpened).toHaveBeenCalledExactlyOnceWith(false);
  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("false");
  expect(container.querySelector('[type="submit"]')?.getAttribute("aria-busy")).toBe("false");
});

test.each(["workspace", "creation", "admission", "rejection"])(
  "unmount during pending %s prevents late continuations and state-update warnings",
  async (stage) => {
    const result = await fixtures.createFile();
    fixtures.createFile.mockClear();
    const operation = deferred<unknown>();
    if (stage === "workspace") fixtures.ensureFileWorkspace.mockReturnValueOnce(operation.promise);
    else if (stage === "admission") fixtures.openFile.mockReturnValueOnce(operation.promise);
    else fixtures.createFile.mockReturnValueOnce(operation.promise);
    await submitRepertoire();
    const consoleError = vi.spyOn(console, "error");
    const consoleWarn = vi.spyOn(console, "warn");

    await act(async () => root.unmount());
    await act(async () => {
      if (stage === "rejection") operation.reject(new Error("Creation failed"));
      else if (stage === "workspace") operation.resolve({ id: { id: "workspace" } });
      else if (stage === "admission") operation.resolve("tab-id");
      else operation.resolve(result);
    });

    expect(fixtures.createFile).toHaveBeenCalledTimes(stage === "workspace" ? 0 : 1);
    expect(fixtures.openFile).toHaveBeenCalledTimes(stage === "admission" ? 1 : 0);
    expect(fixtures.navigate).not.toHaveBeenCalled();
    expect(setOpened).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  },
);

test("keeps the modal state and metadata untouched when tab admission is refused", async () => {
  fixtures.openFile.mockResolvedValueOnce(null);

  await submitRepertoire();

  expect(fixtures.storeSet).not.toHaveBeenCalled();
  expect(fixtures.navigate).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
});

test("opens the created repertoire without requesting Practice after successful admission", async () => {
  await submitRepertoire();

  expect(fixtures.createFile).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: "White",
      filetype: "repertoire",
      content: { kind: "text", pgn: '[Event "White"]\n\n*' },
    }),
  );
  expect(fixtures.openFile).toHaveBeenCalledWith(
    expect.objectContaining({ metadata: { type: "repertoire", tags: [] } }),
    fixtures.setTabs,
    { tabName: "White" },
  );
  expect(fixtures.storeSet).not.toHaveBeenCalled();
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(setOpened).toHaveBeenCalledWith(false);
});

test("cleanup creation preserves repertoire name and blocks all success continuations", async () => {
  const cause = new TauriCommandError({
    tag: "backend-error",
    category: "operation-and-cleanup",
    message: "private diagnostic",
  });
  const create = vi.spyOn(tauri, "createWorkspaceFile").mockRejectedValueOnce(cause);
  const list = vi
    .spyOn(tauri, "listFileWorkspace")
    .mockResolvedValueOnce({ entries: [], unread: [] });
  fixtures.createFile.mockImplementation(actualFiles.createFile);
  await submitRepertoire();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "The file operation failed, and cleanup also failed. Files or folders may remain. Check the collection before trying again.",
  );
  expect(container.querySelector("input")?.value).toBe("White");
  expect(create).toHaveBeenCalledOnce();
  expect(list).toHaveBeenCalledOnce();
  expect(fixtures.openFile).not.toHaveBeenCalled();
  expect(fixtures.storeSet).not.toHaveBeenCalled();
  expect(fixtures.navigate).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("private diagnostic");
});

test.each([
  {
    nameTaken: true,
    message: "unrelated diagnostic",
    expected: "Name already used",
    hidden: "unrelated diagnostic",
  },
  {
    message: "Conflict: workspace file already exists",
    expected: "Conflict: workspace file already exists",
    hidden: "Name already used",
  },
])("repertoire conflict $message preserves its name and shows $expected", async (failure) => {
  const create = vi.spyOn(tauri, "createWorkspaceFile").mockRejectedValueOnce(
    new TauriCommandError({
      tag: "backend-error",
      category: "conflict",
      message: failure.message,
      ...("nameTaken" in failure ? { nameTaken: failure.nameTaken } : {}),
    }),
  );
  fixtures.createFile.mockImplementation(actualFiles.createFile);
  await submitRepertoire();

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(failure.expected);
  expect(container.textContent).not.toContain(failure.hidden);
  expect(container.querySelector("input")?.value).toBe("White");
  expect(create).toHaveBeenCalledOnce();
  expect(fixtures.openFile).not.toHaveBeenCalled();
  expect(fixtures.storeSet).not.toHaveBeenCalled();
  expect(fixtures.navigate).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
});

async function renderCreateForm(name = "Sicilian", colour: "white" | "black" = "black", pgn = "") {
  await act(async () => {
    root.render(<CreateRepertoireModal opened setOpened={setOpened} />);
  });
  const input = container.querySelector("input")!;
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    inputSetter.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="color-${colour}"]`)!.click();
  });
  if (pgn) {
    const textarea = container.querySelector("textarea")!;
    const areaSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      areaSetter.call(textarea, pgn);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

test("creating a repertoire from pasted multi-game PGN as Black writes Orientation black and reports counts", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [
      {
        status: "ok",
        tokens: [
          { type: "San", value: "e4" },
          { type: "San", value: "c5" },
        ],
      },
      {
        status: "ok",
        tokens: [
          { type: "San", value: "e4" },
          { type: "San", value: "e5" },
        ],
      },
    ],
  } satisfies LexPgnGamesOutcome);

  await renderCreateForm("Black Repertoire", "black", "1. e4 c5 *\n\n1. e4 e5 *");
  await act(async () => submitForm());

  expect(fixtures.createFile).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: "Black Repertoire",
      filetype: "repertoire",
      content: {
        kind: "text",
        pgn: expect.stringContaining('[Orientation "black"]'),
      },
    }),
  );
  const writtenPgn = fixtures.createFile.mock.calls[0][0].content.pgn as string;
  expect(writtenPgn).toContain("[%crreview]");
  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(fixtures.notificationsShow).toHaveBeenCalledWith(
    expect.objectContaining({
      color: "success",
      title: "Repertoire.Import.SuccessTitle",
      message: "Repertoire.Import.SuccessSummary",
    }),
  );
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(setOpened).toHaveBeenCalledWith(false);
});

test("inline PGN refusal happens before createFile and keeps draft open", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({ status: "games", games: [] });
  await renderCreateForm("Empty Source", "white", "not a game");
  await act(async () => submitForm());

  expect(fixtures.createFile).not.toHaveBeenCalled();
  expect(fixtures.openFile).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Repertoire.Import.Error.NoUsableGames");
  expect(container.querySelector("input")?.value).toBe("Empty Source");
  expect(container.querySelector("textarea")?.value).toBe("not a game");
});

test("cancelling a pending PGN read aborts its signal without showing an error", async () => {
  const { cancellationError } = await import("@/platform/tauri");
  let capturedSignal: AbortSignal | undefined;
  let rejectRead!: (reason: unknown) => void;
  fixtures.lexPgnGames.mockImplementationOnce(
    (_pgn: string, _max: number, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        rejectRead = reject;
        options?.signal?.addEventListener("abort", () => reject(cancellationError()));
      });
    },
  );

  await renderCreateForm("Slow Import", "white", "1. e4 e5 *");
  await act(async () => submitForm());

  expect(capturedSignal?.aborted).toBe(false);
  const cancelButton = [...container.querySelectorAll("button")].find(
    (btn) => btn.textContent === "Common.Cancel",
  )!;
  expect(cancelButton).toBeDefined();
  await act(async () => cancelButton.click());
  await act(async () => {
    void rejectRead;
  });

  expect(capturedSignal?.aborted).toBe(true);
  expect(fixtures.createFile).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(setOpened).not.toHaveBeenCalled();
});

test("when createFile succeeds but openFile fails, modal closes and notifies created in Library", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
  } satisfies LexPgnGamesOutcome);
  fixtures.openFile.mockRejectedValueOnce(new Error("tab refused"));

  await renderCreateForm("Created Only", "white", "1. e4 *");
  await act(async () => submitForm());

  expect(fixtures.createFile).toHaveBeenCalledOnce();
  expect(fixtures.warnSafely).toHaveBeenCalledWith(expect.stringContaining("tab refused"));
  expect(fixtures.notificationsShow).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Repertoire.Import.CreatedInLibraryTitle",
      message: "Repertoire.Import.CreatedInLibraryBody",
    }),
  );
  expect(setOpened).toHaveBeenCalledWith(false);
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

test("when openFile rejects with cancellation after createFile, warns nothing and notifies created in Library", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
  } satisfies LexPgnGamesOutcome);
  fixtures.openFile.mockRejectedValueOnce(cancellationError());

  await renderCreateForm("Cancelled Open", "white", "1. e4 *");
  await act(async () => submitForm());

  expect(fixtures.createFile).toHaveBeenCalledOnce();
  expect(fixtures.warnSafely).not.toHaveBeenCalled();
  expect(fixtures.notificationsShow).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Repertoire.Import.CreatedInLibraryTitle",
    }),
  );
  expect(setOpened).toHaveBeenCalledWith(false);
});

test("whitespace-only pasted PGN creates an empty repertoire without calling lexPgnGames", async () => {
  await renderCreateForm("Whitespace Only", "white", "   \t\n  ");
  await act(async () => submitForm());

  expect(fixtures.lexPgnGames).not.toHaveBeenCalled();
  expect(fixtures.createFile).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: "Whitespace Only",
      filetype: "repertoire",
    }),
  );
});

test("file-source path creates repertoire with Orientation and opens it", async () => {
  const pickedFile = {
    type: "file" as const,
    name: "french.pgn",
    handle: { id: { id: "picked" }, kind: "fileWorkspace" as const },
    numGames: 1,
    metadata: { type: "game" as const, tags: [] },
    lastModified: 1,
  };
  fixtures.pickPgnFile.mockResolvedValueOnce(pickedFile);
  fixtures.countPgnGames.mockResolvedValueOnce(1);
  fixtures.readGames.mockResolvedValueOnce([
    { pgn: "1. e4 e6 *", stamp: "s0", revision: "rev1", present: true },
  ]);
  fixtures.lexPgn.mockResolvedValueOnce([
    { type: "San", value: "e4" },
    { type: "San", value: "e6" },
  ]);

  await renderCreateForm("French", "black");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="choose-file"]')!.click();
  });
  await vi.waitFor(() => expect(fixtures.pickPgnFile).toHaveBeenCalledOnce());
  await act(async () => submitForm());

  expect(fixtures.fileRevision).toHaveBeenCalledOnce();
  expect(fixtures.countPgnGames).toHaveBeenCalledOnce();
  expect(fixtures.createFile).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: "French",
      filetype: "repertoire",
      content: { kind: "text", pgn: expect.stringContaining('[Orientation "black"]') },
    }),
  );
  expect(fixtures.openFile).toHaveBeenCalledOnce();
});

test("streaming reader depth refusal during repertoire creation shows inline MaxDepth error without creating file", async () => {
  const tooDeepMoves = Array.from({ length: 513 }, () => ["Nf3", "Nf6", "Ng1", "Ng8"]).flat();
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [
      {
        status: "ok",
        tokens: tooDeepMoves.map((value) => ({ type: "San", value })),
      },
    ],
  } satisfies LexPgnGamesOutcome);

  await renderCreateForm("Too Deep", "white", "1. Nf3 Nf6 *");
  await act(async () => submitForm());

  expect(fixtures.createFile).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Repertoire.Import.Error.MaxDepth");
});

test("merger.finish() max-line-bytes refusal during repertoire creation shows inline error without creating file", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [
      {
        status: "ok",
        tokens: [
          { type: "San", value: "e4" },
          { type: "Comment", value: "a".repeat(600 * 1024) },
        ],
      },
      {
        status: "ok",
        tokens: [
          { type: "San", value: "e4" },
          { type: "Comment", value: "b".repeat(600 * 1024) },
        ],
      },
    ],
  } satisfies LexPgnGamesOutcome);

  await renderCreateForm("Too Long Line", "white", "1. e4 {a} * 1. e4 {b} *");
  await act(async () => submitForm());

  expect(fixtures.createFile).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Repertoire.Import.Error.MaxLineBytes");
});

test("repertoireImportErrorMessage and repertoireMergeRefusalMessage map every branch", () => {
  const t = ((key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key) as unknown as Parameters<
    typeof repertoireImportErrorMessage
  >[1];

  expect(
    repertoireImportErrorMessage(new RepertoireImportError("too-many-games", "ignored"), t),
  ).toBe('Repertoire.Import.Error.TooManyGames:{"max":2000}');
  expect(repertoireImportErrorMessage(new RepertoireImportError("too-large", "ignored"), t)).toBe(
    'Repertoire.Import.Error.MaxNodes:{"max":100000}',
  );
  expect(
    repertoireImportErrorMessage(
      new RepertoireImportError("too-large", "ignored", undefined, "max-depth"),
      t,
    ),
  ).toBe('Repertoire.Import.Error.MaxDepth:{"max":2048}');
  expect(
    repertoireImportErrorMessage(new RepertoireImportError("file-changed", "ignored"), t),
  ).toBe("Repertoire.Import.Error.FileChanged");
  expect(
    repertoireImportErrorMessage(new RepertoireImportError("no-usable-games", "ignored"), t),
  ).toBe("Repertoire.Import.Error.NoUsableGames");
  expect(repertoireImportErrorMessage(new RepertoireImportError("io", "disk failed"), t)).toBe(
    "disk failed",
  );
  expect(repertoireImportErrorMessage(new Error("raw failure"), t)).toBe("raw failure");

  expect(repertoireMergeRefusalMessage("max-nodes", t)).toBe(
    'Repertoire.Import.Error.MaxNodes:{"max":100000}',
  );
  expect(repertoireMergeRefusalMessage("max-depth", t)).toBe(
    'Repertoire.Import.Error.MaxDepth:{"max":2048}',
  );
  expect(repertoireMergeRefusalMessage("max-bytes", t)).toBe("Repertoire.Import.Error.MaxBytes");
  expect(repertoireMergeRefusalMessage("max-line-bytes", t)).toBe(
    "Repertoire.Import.Error.MaxLineBytes",
  );
});

test("mounted create-stage refusal in PGN path lands on the Name field, not the import-source error", async () => {
  const createError = new Error("Name already exists");
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
  } satisfies LexPgnGamesOutcome);
  fixtures.createFile.mockResolvedValueOnce(Result.err(createError));

  await renderCreateForm("Taken Name", "white", "1. e4 *");
  await act(async () => submitForm());

  const nameAlert = container.querySelector("label [role='alert']");
  expect(nameAlert?.textContent).toBe("Name already exists");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(setOpened).not.toHaveBeenCalled();
});

test.each(["Err", "reject"] as const)(
  "unmounted create-stage %s refusal notifies through notifyUnlessCancelled in CreateRepertoireModal",
  async (mode) => {
    const createError = new Error("create stage failed after unmount");
    const createDeferred = deferred<unknown>();
    fixtures.lexPgnGames.mockResolvedValueOnce({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    } satisfies LexPgnGamesOutcome);
    fixtures.createFile.mockReturnValueOnce(createDeferred.promise);

    await renderCreateForm("Unmount Create Refusal", "white", "1. e4 *");
    await act(async () => submitForm());
    await vi.waitFor(() => expect(fixtures.createFile).toHaveBeenCalledOnce());

    await act(async () => root.unmount());
    await act(async () => {
      if (mode === "Err") createDeferred.resolve(Result.err(createError));
      else createDeferred.reject(createError);
    });

    await vi.waitFor(() => expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledOnce());
    expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith(
      "Common.Error",
      createError,
      "files",
    );
    root = createRoot(container);
  },
);

test("unexpected throw from createRepertoireFromPgn reports inline when mounted and notifies when unmounted", async () => {
  const boom = new Error("unexpected helper throw");
  const spy = vi.spyOn(createRepertoireModule, "createRepertoireFromPgn");

  spy.mockRejectedValueOnce(boom);
  await renderCreateForm("Throws Mounted", "white", "1. e4 *");
  await act(async () => submitForm());
  expect(container.querySelector("label [role='alert']")?.textContent).toBe(
    "unexpected helper throw",
  );
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();

  const d = deferred<createRepertoireModule.CreateRepertoireFromPgnResult>();
  spy.mockReturnValueOnce(d.promise);
  await act(async () => submitForm());
  await act(async () => root.unmount());
  await act(async () => {
    d.reject(boom);
  });

  await vi.waitFor(() => expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledOnce());
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", boom, "files");
  root = createRoot(container);
});

test("createRepertoireFromPgn notifies created-in-library when openFile returns null (refused admission)", async () => {
  fixtures.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
  } satisfies LexPgnGamesOutcome);
  fixtures.openFile.mockResolvedValueOnce(null);

  const t = ((key: string) => key) as Parameters<
    typeof createRepertoireModule.createRepertoireFromPgn
  >[0]["t"];
  const result = await createRepertoireModule.createRepertoireFromPgn({
    name: "White",
    color: "white",
    source: { kind: "text", pgn: "1. e4 *" },
    listingCache: {
      entries: new Map(),
      refresh: vi.fn(),
    } as unknown as Parameters<
      typeof createRepertoireModule.createRepertoireFromPgn
    >[0]["listingCache"],
    setTabs: fixtures.setTabs,
    t,
  });

  expect(result).toEqual({ status: "created-in-library", fileName: "White" });
  expect(fixtures.notificationsShow).toHaveBeenCalledWith({
    color: "warning",
    title: "Repertoire.Import.CreatedInLibraryTitle",
    message: "Repertoire.Import.CreatedInLibraryBody",
  });
});
