import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LexPgnGamesOutcome } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { defaultTree } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
  countPgnGames: vi.fn(),
  fileRevision: vi.fn(),
  lexPgn: vi.fn(),
  lexPgnGames: vi.fn(),
  notificationsShow: vi.fn(),
  pickPgnFile: vi.fn(),
  readGames: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));
vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  pickPgnFile: mocks.pickPgnFile,
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      countPgnGames: mocks.countPgnGames,
      fileRevision: mocks.fileRevision,
      lexPgn: mocks.lexPgn,
      lexPgnGames: mocks.lexPgnGames,
      readGames: mocks.readGames,
    },
  };
});
vi.mock("@/components/common/AppModal", async () => ({
  default: (await import("@/tests/appModal")).PendingAppModal,
}));
vi.mock("@mantine/core", () => ({
  Button: ({
    children,
    loading,
    fullWidth: _fullWidth,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    fullWidth?: boolean;
    variant?: string;
  }) => (
    <button {...props} disabled={props.disabled || loading} aria-busy={loading}>
      {children}
    </button>
  ),
  Divider: () => <hr />,
  FileInput: ({ onClick, disabled }: { onClick?: () => void; disabled?: boolean }) => (
    <button type="button" data-testid="choose-file" disabled={disabled} onClick={onClick}>
      Choose file
    </button>
  ),
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children, role }: { children: React.ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

import { ImportIntoRepertoireModal } from "./ImportIntoRepertoireModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fileRevision.mockResolvedValue("r1");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderModal(store: TreeStore, onClose = vi.fn()) {
  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <ImportIntoRepertoireModal opened onClose={onClose} />
      </TreeStateContext.Provider>,
    );
  });
  return onClose;
}

async function pastePgn(pgn: string) {
  const textarea = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, pgn);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitButton() {
  return [...host.querySelectorAll("button")].find(
    (btn) =>
      btn.textContent === "Home.Card.ImportGame.Button" || btn.textContent === "Import.Importing",
  )!;
}

test("merges pasted PGN into open repertoire using its orientation, notifies counts, and closes", async () => {
  const tree = defaultTree();
  tree.headers.orientation = "black";
  const store = createTreeStore(undefined, tree);
  store.getState().makeMoves({ payload: ["e4", "c5"] });
  store.getState().save();

  mocks.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [
      {
        status: "ok",
        tokens: [
          { type: "San", value: "e4" },
          { type: "San", value: "e5" },
        ],
      },
    ],
  } satisfies LexPgnGamesOutcome);

  const onClose = await renderModal(store);
  await pastePgn("1. e4 e5 *");
  await act(async () => submitButton().click());

  const children = store.getState().root.children[0].children;
  expect(children.map((c) => c.san)).toEqual(["c5", "e5"]);
  expect(children[1].reviewMark).toBe(true);
  expect(mocks.notificationsShow).toHaveBeenCalledWith(
    expect.objectContaining({
      color: "success",
      title: "Repertoire.Import.SuccessTitle",
      message: "Repertoire.Import.SuccessSummary",
    }),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

test("inline refusal keeps modal open with error and preserves input", async () => {
  const store = createTreeStore();
  mocks.lexPgnGames.mockResolvedValueOnce({ status: "games", games: [] });

  const onClose = await renderModal(store);
  await pastePgn("bad");
  await act(async () => submitButton().click());

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Repertoire.Import.Error.NoUsableGames",
  );
  expect(host.querySelector("textarea")?.value).toBe("bad");
  expect(onClose).not.toHaveBeenCalled();
});

test("Cancel aborts in-flight read without error", async () => {
  const { cancellationError } = await import("@/platform/tauri");
  const store = createTreeStore();
  let capturedSignal: AbortSignal | undefined;
  mocks.lexPgnGames.mockImplementationOnce(
    (_pgn: string, _max: number, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(cancellationError()));
      });
    },
  );

  const onClose = await renderModal(store);
  await pastePgn("1. e4 e5 *");
  await act(async () => submitButton().click());

  expect(capturedSignal?.aborted).toBe(false);
  const cancelBtn = [...host.querySelectorAll("button")].find(
    (btn) => btn.textContent === "Common.Cancel",
  )!;
  await act(async () => cancelBtn.click());

  expect(capturedSignal?.aborted).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test("drops read result silently when the document changes while reading", async () => {
  const store = createTreeStore();
  const initialDoc = store.getState().documentId;
  let resolveRead!: (value: unknown) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );

  const onClose = await renderModal(store);
  await pastePgn("1. e4 e5 *");
  await act(async () => submitButton().click());

  // Simulate another game/document replacing the store while the read is in flight.
  store.setState({ ...store.getState(), documentId: initialDoc + 1 });
  const spy = vi.spyOn(store.getState(), "applyRepertoireImport");

  await act(async () => {
    resolveRead({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    } satisfies LexPgnGamesOutcome);
  });

  expect(spy).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("drops read result silently when the tree root is edited while reading (same documentId)", async () => {
  const store = createTreeStore();
  let resolveRead!: (value: unknown) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );

  const onClose = await renderModal(store);
  await pastePgn("1. e4 e5 *");
  await act(async () => submitButton().click());

  // Edit the tree while reading (same documentId, new root object).
  store.getState().makeMove({ payload: "d4" });
  const spy = vi.spyOn(store.getState(), "applyRepertoireImport");

  await act(async () => {
    resolveRead({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    } satisfies LexPgnGamesOutcome);
  });

  expect(spy).not.toHaveBeenCalled();
  expect(store.getState().root.children.map((c) => c.san)).toEqual(["d4"]);
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("unmounting during read drops result silently without merging or notifying", async () => {
  const store = createTreeStore();
  let resolveRead!: (value: unknown) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );

  const onClose = await renderModal(store);
  await pastePgn("1. e4 e5 *");
  await act(async () => submitButton().click());

  const spy = vi.spyOn(store.getState(), "applyRepertoireImport");
  await act(async () => root.unmount());
  await act(async () => {
    resolveRead({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    } satisfies LexPgnGamesOutcome);
  });

  expect(spy).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("whitespace-only pasted PGN with no file keeps Import button disabled", async () => {
  const store = createTreeStore();
  await renderModal(store);

  await pastePgn("   \t\n  ");
  expect(submitButton().disabled).toBe(true);

  await act(async () => submitButton().click());
  expect(mocks.lexPgnGames).not.toHaveBeenCalled();
});

test("imports PGN file source into open repertoire", async () => {
  const store = createTreeStore();
  mocks.pickPgnFile.mockResolvedValueOnce({
    type: "file",
    name: "source.pgn",
    handle: { id: { id: "src" }, kind: "fileWorkspace" },
    numGames: 1,
    metadata: { type: "game", tags: [] },
    lastModified: 1,
  });
  mocks.countPgnGames.mockResolvedValueOnce(1);
  mocks.readGames.mockResolvedValueOnce([
    { pgn: "1. d4 d5 *", stamp: "s0", revision: "r1", present: true },
  ]);
  mocks.lexPgn.mockResolvedValueOnce([
    { type: "San", value: "d4" },
    { type: "San", value: "d5" },
  ]);

  const onClose = await renderModal(store);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="choose-file"]')!.click();
  });
  await vi.waitFor(() => expect(mocks.pickPgnFile).toHaveBeenCalledOnce());
  await act(async () => submitButton().click());

  expect(store.getState().root.children.map((c) => c.san)).toEqual(["d4"]);
  expect(mocks.notificationsShow).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("streaming reader depth refusal (too-large with max-depth) shows inline error and leaves tree unchanged", async () => {
  const store = createTreeStore();
  const applySpy = vi.spyOn(store.getState(), "applyRepertoireImport");
  const tooDeepMoves = Array.from({ length: 513 }, () => ["Nf3", "Nf6", "Ng1", "Ng8"]).flat();
  mocks.lexPgnGames.mockResolvedValueOnce({
    status: "games",
    games: [
      {
        status: "ok",
        tokens: tooDeepMoves.map((value) => ({ type: "San", value })),
      },
    ],
  } satisfies LexPgnGamesOutcome);

  const onClose = await renderModal(store);
  await pastePgn("1. Nf3 Nf6 *");
  await act(async () => submitButton().click());

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Repertoire.Import.Error.MaxDepth",
  );
  expect(applySpy).not.toHaveBeenCalled();
  expect(store.getState().root.children).toHaveLength(0);
  expect(onClose).not.toHaveBeenCalled();
});

test("drops a read refusal silently when the document or root changes while reading", async () => {
  const store = createTreeStore();
  let resolveRead!: (value: LexPgnGamesOutcome) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise<LexPgnGamesOutcome>((resolve) => {
        resolveRead = resolve;
      }),
  );

  const onClose = await renderModal(store);
  await pastePgn("bad");
  await act(async () => submitButton().click());

  // Mutate the tree root while reading so the snapshot becomes stale before readRepertoireSource throws.
  store.getState().makeMove({ payload: "d4" });
  await act(async () => {
    resolveRead({ status: "games", games: [] });
  });

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(store.getState().root.children.map((c) => c.san)).toEqual(["d4"]);
  expect(onClose).not.toHaveBeenCalled();
});

test("merger.finish() max-line-bytes refusal shows inline error and leaves tree unchanged", async () => {
  const store = createTreeStore();
  const applySpy = vi.spyOn(store.getState(), "applyRepertoireImport");
  mocks.lexPgnGames.mockResolvedValueOnce({
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

  const onClose = await renderModal(store);
  await pastePgn("1. e4 {a} * 1. e4 {b} *");
  await act(async () => submitButton().click());

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Repertoire.Import.Error.MaxLineBytes",
  );
  expect(applySpy).not.toHaveBeenCalled();
  expect(store.getState().root.children).toHaveLength(0);
  expect(onClose).not.toHaveBeenCalled();
});

test("drops both a read result and a read refusal silently when headers change while reading", async () => {
  // Case 1: successful read after setHeaders -> dropped silently, headers kept.
  const store1 = createTreeStore();
  let resolveSuccess!: (value: LexPgnGamesOutcome) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise<LexPgnGamesOutcome>((resolve) => {
        resolveSuccess = resolve;
      }),
  );

  const onClose1 = await renderModal(store1);
  await pastePgn("1. e4 *");
  await act(async () => submitButton().click());

  store1.getState().setHeaders({ ...store1.getState().headers, white: "Carlsen" });
  const spy1 = vi.spyOn(store1.getState(), "applyRepertoireImport");

  await act(async () => {
    resolveSuccess({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    });
  });

  expect(spy1).not.toHaveBeenCalled();
  expect(store1.getState().headers.white).toBe("Carlsen");
  expect(store1.getState().root.children).toHaveLength(0);
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  expect(onClose1).not.toHaveBeenCalled();

  // Case 2: read refusal after setHeaders -> dropped silently, no alert shown.
  const store2 = createTreeStore();
  let resolveRefusal!: (value: LexPgnGamesOutcome) => void;
  mocks.lexPgnGames.mockImplementationOnce(
    () =>
      new Promise<LexPgnGamesOutcome>((resolve) => {
        resolveRefusal = resolve;
      }),
  );

  const onClose2 = await renderModal(store2);
  await pastePgn("bad");
  await act(async () => submitButton().click());

  store2.getState().setHeaders({ ...store2.getState().headers, white: "Carlsen" });

  await act(async () => {
    resolveRefusal({ status: "games", games: [] });
  });

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(store2.getState().headers.white).toBe("Carlsen");
  expect(onClose2).not.toHaveBeenCalled();
});

test("submit button is disabled while read is pending and second submit is ignored", async () => {
  const store = createTreeStore();
  let resolveRead!: (value: LexPgnGamesOutcome) => void;
  mocks.lexPgnGames.mockImplementation(
    () =>
      new Promise<LexPgnGamesOutcome>((resolve) => {
        resolveRead = resolve;
      }),
  );

  await renderModal(store);
  await pastePgn("1. e4 e5 *");
  // Two synchronous clicks in one act test useSingleFlight before React disables the button.
  await act(async () => {
    const button = submitButton();
    button.click();
    button.click();
  });

  expect(mocks.lexPgnGames).toHaveBeenCalledOnce();
  expect(submitButton().disabled).toBe(true);

  await act(async () => {
    resolveRead({
      status: "games",
      games: [{ status: "ok", tokens: [{ type: "San", value: "e4" }] }],
    });
  });
});
