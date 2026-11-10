import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tabStorage } from "@/state/store/tabStorage";
import { defaultTree } from "@/utils/treeReducer";
import { hasFileOpenInFlight } from "@/state/fileStructureChange";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";

const fixtures = vi.hoisted(() => ({
  atoms: {
    addRecentFile: Symbol("add-recent-file"),
  },
  file: {
    type: "file",
    handle: { id: { id: "selected-pgn" }, kind: "fileWorkspace" as const },
    name: "selected.pgn",
    numGames: 2,
    metadata: { type: "game", tags: [] },
    lastModified: 1,
  },
  createFile: vi.fn(),
  ensureFileWorkspace: vi.fn(),
  getChesscomGame: vi.fn(),
  getLichessGame: vi.fn(),
  loadFileGame: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  parsePGN: vi.fn(),
  pickPgnFile: vi.fn(),
  replaceNewTab: vi.fn(),
  store: {
    tag: "import-modal-store",
    activeTabId: "owner-tab",
    set: (...args: unknown[]) => fixtures.storeSet(...args),
  },
  storeSet: vi.fn(),
  setTabs: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock("@/state/atoms", () => ({ addRecentFileAtom: fixtures.atoms.addRecentFile }));
vi.mock("jotai", async (original) => ({
  ...(await original<typeof import("jotai")>()),
  useStore: () => fixtures.store,
}));
vi.mock("@/utils/chess", () => ({ parsePGN: fixtures.parsePGN }));
vi.mock("@/utils/chess.com/api", () => ({ getChesscomGame: fixtures.getChesscomGame }));
vi.mock("@/utils/lichess/api", () => ({ getLichessGame: fixtures.getLichessGame }));
vi.mock("@/utils/tabs", () => ({ replaceNewTab: fixtures.replaceNewTab }));
vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  createFile: fixtures.createFile,
  ensureFileWorkspace: fixtures.ensureFileWorkspace,
  loadFileGame: fixtures.loadFileGame,
  openFile: fixtures.openFile,
  pickPgnFile: fixtures.pickPgnFile,
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: fixtures.notifyUnlessCancelled,
  runUnlessCancelled: async (_title: string, action: () => Promise<void>) => action(),
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
vi.mock("../common/AppModal", () => ({
  default: ({
    children,
    opened,
    pending,
  }: {
    children: React.ReactNode;
    opened: boolean;
    pending?: boolean;
  }) => (
    <div data-testid="modal" data-opened={String(opened)} data-pending={String(Boolean(pending))}>
      {children}
    </div>
  ),
}));
vi.mock("../common/GenericCard", () => ({
  default: ({
    id,
    Header,
    setSelected,
  }: {
    id: string;
    Header: React.ReactNode;
    setSelected?: (id: string) => void;
  }) => (
    <button type="button" data-testid={`mode-${id}`} onClick={() => setSelected?.(id)}>
      {Header}
    </button>
  ),
}));
vi.mock("@mantine/core", () => ({
  Button: ({
    children,
    loading,
    fullWidth: _fullWidth,
    mt: _mt,
    radius: _radius,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    fullWidth?: boolean;
    mt?: string;
    radius?: string;
  }) => (
    <button type="button" aria-busy={loading} {...props}>
      {children}
    </button>
  ),
  Checkbox: ({
    checked,
    onChange,
  }: {
    checked: boolean;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <input type="checkbox" data-testid="save-to-collection" checked={checked} onChange={onChange} />
  ),
  Divider: () => <hr />,
  FileInput: ({ onClick }: { onClick: () => void }) => (
    <button type="button" data-testid="choose-file" onClick={onClick}>
      Choose file
    </button>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  TextInput: ({
    label,
    error,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: React.ReactNode }) => (
    <label>
      {label}
      <input aria-label={label} {...props} />
      {error && <span data-testid={`error-${label}`}>{error}</span>}
    </label>
  ),
}));

import ImportModal from "./ImportModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const link = "https://www.chess.com/game/live/123";
const linkPgn = '[Event "Online game"]\n\n1. e4 *';

let host: HTMLDivElement;
let root: Root;
let rootMounted: boolean;

function modalElement() {
  return host.querySelector<HTMLDivElement>('[data-testid="modal"]')!;
}

function submitButton() {
  return Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Home.Card.ImportGame.Button",
  )!;
}

function input(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

async function renderModal(ownerId = "owner-tab", setOpenModal = vi.fn()) {
  await act(async () => {
    root.render(
      <ImportModal
        ownerId={ownerId}
        openModal
        setOpenModal={setOpenModal}
        setTabs={fixtures.setTabs}
      />,
    );
  });
  rootMounted = true;
  return setOpenModal;
}

async function chooseFile() {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="choose-file"]')!.click();
  });
  await vi.waitFor(() => expect(fixtures.pickPgnFile).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(submitButton().disabled).toBe(false));
}

async function chooseType(type: "Link" | "FEN") {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(`[data-testid="mode-${type}"]`)!.click();
  });
}

async function setInputValue(target: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pastePgn(pgn: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, pgn);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

async function pressEnter(target: HTMLInputElement) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

async function clickSubmit() {
  await act(async () => submitButton().click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  fixtures.store.activeTabId = "owner-tab";
  fixtures.replaceNewTab.mockReturnValue({ kind: "committed", id: "imported-tab" });
  fixtures.pickPgnFile.mockResolvedValue(fixtures.file);
  fixtures.loadFileGame.mockImplementation(async () => {
    const tree = defaultTree();
    tree.headers.event = "Fresh from disk";
    tree.sourceStamp = "f".repeat(64);
    return {
      pgn: '[Event "Fresh from disk"]\n\n1. d4 *',
      stamp: tree.sourceStamp,
      revision: "r-fresh",
      present: true,
      tree,
    };
  });
  fixtures.parsePGN.mockImplementation(async () => {
    const tree = defaultTree();
    tree.headers.event = "Online game";
    return tree;
  });
  fixtures.getChesscomGame.mockResolvedValue(linkPgn);
  fixtures.getLichessGame.mockResolvedValue(linkPgn);
  fixtures.storeSet.mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rootMounted = false;
});

afterEach(async () => {
  if (rootMounted) {
    await act(async () => root.unmount());
    rootMounted = false;
  }
  vi.restoreAllMocks();
  host.remove();
});

test("file import passes the fresh file tree and file origin to its owner", async () => {
  const seed = vi.spyOn(tabStorage, "seed");
  fixtures.replaceNewTab.mockReturnValue({ kind: "refused", stage: "workspace" });
  const ownerTreeBytes = "existing-owner-tree-bytes";
  sessionStorage.setItem("owner-tab", ownerTreeBytes);
  const setOpenModal = vi.fn();
  await renderModal("owner-tab", setOpenModal);
  await chooseFile();
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  const loaded = await fixtures.loadFileGame.mock.results[0].value;
  expect(fixtures.loadFileGame).toHaveBeenCalledWith(fixtures.file.handle, 0);
  expect(fixtures.loadFileGame).toHaveBeenCalledOnce();
  expect(fixtures.replaceNewTab).toHaveBeenCalledWith({
    store: fixtures.store,
    ownerId: "owner-tab",
    tab: {
      name: "Fresh from disk",
      gameOrigin: {
        kind: "file",
        file: expect.objectContaining({ handle: fixtures.file.handle }),
        gameNumber: 0,
      },
      type: "analysis",
    },
    tree: loaded.tree,
  });
  expect(loaded.tree).toMatchObject({
    sourceStamp: "f".repeat(64),
    headers: { event: "Fresh from disk" },
  });
  expect(seed).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("owner-tab")).toBe(ownerTreeBytes);
  expect(fixtures.storeSet).toHaveBeenCalledWith(
    fixtures.atoms.addRecentFile,
    expect.objectContaining({ handle: fixtures.file.handle }),
  );
  expect(setOpenModal).not.toHaveBeenCalled();
});

test("file import holds its open lease from the first read through tab admission", async () => {
  const tree = defaultTree();
  const loaded = {
    pgn: '[Event "Import"]\n\n*',
    stamp: "import-stamp",
    revision: "import-revision",
    present: true,
    tree,
  };
  const request = deferred<typeof loaded>();
  const key = fileWorkspaceKey(fixtures.file.handle);
  let heldAtRead = false;
  let heldAtAdmission = false;
  fixtures.loadFileGame.mockImplementationOnce(() => {
    heldAtRead = hasFileOpenInFlight(key);
    return request.promise;
  });
  fixtures.replaceNewTab.mockImplementationOnce(() => {
    heldAtAdmission = hasFileOpenInFlight(key);
    return { kind: "committed", id: "imported-tab" };
  });
  await renderModal();
  await chooseFile();
  await clickSubmit();
  try {
    expect(heldAtRead).toBe(true);
    expect(hasFileOpenInFlight(key)).toBe(true);
    expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
  } finally {
    await act(async () => request.resolve(loaded));
  }
  expect(fixtures.replaceNewTab).toHaveBeenCalledOnce();
  expect(heldAtAdmission).toBe(true);
  expect(hasFileOpenInFlight(key)).toBe(false);
});

test("saving an imported PGN copies its source before submitting the reloaded file tree", async () => {
  const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
  const savedFile = {
    ...fixtures.file,
    handle: { id: { id: "saved-pgn" }, kind: "fileWorkspace" as const },
  };
  const sourceTree = defaultTree();
  sourceTree.headers.event = "Source preflight";
  const savedTree = defaultTree();
  savedTree.headers.event = "Saved file";
  const sourceKey = fileWorkspaceKey(fixtures.file.handle);
  const savedKey = fileWorkspaceKey(savedFile.handle);
  const leasesAtReads: boolean[] = [];
  let leasesAtAdmission: boolean[] = [];
  fixtures.loadFileGame
    .mockImplementationOnce(async () => {
      leasesAtReads.push(hasFileOpenInFlight(sourceKey));
      return {
        pgn: '[Event "Source preflight"]\n\n1. e4 *',
        stamp: "source-stamp",
        revision: "source-revision",
        present: true,
        tree: sourceTree,
      };
    })
    .mockImplementationOnce(async () => {
      leasesAtReads.push(hasFileOpenInFlight(savedKey));
      return {
        pgn: '[Event "Saved file"]\n\n1. d4 *',
        stamp: "saved-stamp",
        revision: "saved-revision",
        present: true,
        tree: savedTree,
      };
    });
  fixtures.replaceNewTab.mockImplementationOnce(() => {
    leasesAtAdmission = [hasFileOpenInFlight(sourceKey), hasFileOpenInFlight(savedKey)];
    return { kind: "committed", id: "imported-tab" };
  });
  fixtures.ensureFileWorkspace.mockResolvedValue(workspace);
  fixtures.createFile.mockResolvedValue({ isErr: false, value: savedFile });
  await renderModal();
  await chooseFile();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
  );
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.createFile).toHaveBeenCalledWith({
    filename: "selected.pgn",
    filetype: "game",
    content: {
      kind: "copy",
      source: fixtures.file.handle,
      revision: "source-revision",
    },
    workspace,
    parent: workspace,
    listingCache: expect.objectContaining({
      cache: expect.anything(),
      mutate: expect.any(Function),
    }),
  });
  expect(fixtures.loadFileGame).toHaveBeenCalledTimes(2);
  expect(fixtures.loadFileGame).toHaveBeenNthCalledWith(1, fixtures.file.handle, 0);
  expect(fixtures.loadFileGame).toHaveBeenNthCalledWith(2, savedFile.handle, 0);
  expect(fixtures.replaceNewTab).toHaveBeenCalledWith(
    expect.objectContaining({
      tab: expect.objectContaining({
        gameOrigin: { kind: "file", file: savedFile, gameNumber: 0 },
      }),
      tree: savedTree,
    }),
  );
  expect(leasesAtReads).toEqual([true, true]);
  expect(leasesAtAdmission).toEqual([true, true]);
  expect(hasFileOpenInFlight(sourceKey)).toBe(false);
  expect(hasFileOpenInFlight(savedKey)).toBe(false);
});

test.each([
  { white: "Dragon System", event: "fertig", name: "Dragon System" },
  { white: "?", event: "Legacy", name: "Legacy" },
  { white: "?", event: "?", name: "selected" },
])("a PGN file saved as Repertoire opens with $name", async ({ white, event, name }) => {
  const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
  const savedFile = { ...fixtures.file, metadata: { type: "repertoire", tags: [] } };
  const tree = defaultTree();
  tree.headers = { ...tree.headers, white, event, black: "6...Dc7 plan" };
  fixtures.loadFileGame.mockResolvedValue({
    tree,
    pgn: "*",
    revision: "r1",
    stamp: "s1",
    present: true,
  });
  fixtures.ensureFileWorkspace.mockResolvedValue(workspace);
  fixtures.createFile.mockResolvedValue({ isErr: false, value: savedFile });
  await renderModal();
  await chooseFile();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="mode-repertoire"]')!.click(),
  );
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());
  expect(fixtures.createFile).toHaveBeenCalledWith(
    expect.objectContaining({ filetype: "repertoire" }),
  );
  expect(fixtures.replaceNewTab).toHaveBeenCalledWith(
    expect.objectContaining({
      tab: expect.objectContaining({
        name,
        gameOrigin: { kind: "file", file: savedFile, gameNumber: 0 },
      }),
      tree,
    }),
  );
});

test("a rejected game-0 preflight creates no copied file", async () => {
  fixtures.loadFileGame.mockRejectedValueOnce(new Error("game 0 is too large"));
  await renderModal();
  await chooseFile();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
  );
  await clickSubmit();

  expect(fixtures.loadFileGame).toHaveBeenCalledTimes(1);
  expect(fixtures.loadFileGame).toHaveBeenCalledWith(fixtures.file.handle, 0);
  expect(fixtures.ensureFileWorkspace).not.toHaveBeenCalled();
  expect(fixtures.createFile).not.toHaveBeenCalled();
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
  expect(hasFileOpenInFlight(fileWorkspaceKey(fixtures.file.handle))).toBe(false);
});

test.each([
  {
    saveState: "unsaved",
    nameInput: null,
    fieldError: null,
    submitError: expect.objectContaining({ textContent: "Name already used" }),
  },
  {
    saveState: "saved",
    nameInput: expect.objectContaining({ value: "Najdorf repertoire" }),
    fieldError: expect.objectContaining({ textContent: "Name already used" }),
    submitError: null,
  },
])(
  "$saveState pasted PGN conflict retains input and shows Name already used",
  async ({ saveState, nameInput, fieldError, submitError }) => {
    const { tauri, TauriCommandError } = await import("@/platform/tauri");
    const create = vi.spyOn(tauri, "createWorkspaceFile").mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "conflict",
        nameTaken: true,
        message: "unrelated diagnostic",
      }),
    );
    fixtures.ensureFileWorkspace.mockResolvedValue({
      id: { id: "workspace" },
      kind: "fileWorkspace",
    });
    fixtures.createFile.mockImplementation(
      (await vi.importActual<typeof import("@/utils/files")>("@/utils/files")).createFile,
    );
    const setOpen = await renderModal();
    const textarea = await pastePgn(linkPgn);
    if (saveState === "saved") {
      await act(async () =>
        host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
      );
      await setInputValue(input("Common.Name"), "Najdorf repertoire");
    }
    await clickSubmit();

    expect(host.textContent).toContain("Name already used");
    expect(host.querySelector('input[aria-label="Common.Name"]')).toEqual(nameInput);
    expect(host.querySelector('[data-testid="error-Common.Name"]')).toEqual(fieldError);
    expect(submitButton().nextElementSibling).toEqual(submitError);
    expect(textarea.value).toBe(linkPgn);
    expect(fixtures.loadFileGame).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("unrelated diagnostic");
    expect(modalElement().dataset.opened).toBe("true");
    expect(create).toHaveBeenCalledOnce();
    expect(fixtures.openFile).not.toHaveBeenCalled();
    expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
    expect(fixtures.storeSet).not.toHaveBeenCalled();
    expect(fixtures.setTabs).not.toHaveBeenCalled();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  },
);

test.each(["saved file", "pasted PGN"])(
  "cleanup importing %s retains values and blocks success continuations",
  async (branch) => {
    const { tauri, TauriCommandError } = await import("@/platform/tauri");
    const cause = new TauriCommandError({
      tag: "backend-error",
      category: "operation-and-cleanup",
      message: "private diagnostic",
    });
    const create = vi.spyOn(tauri, "createWorkspaceFile").mockRejectedValueOnce(cause);
    const list = vi
      .spyOn(tauri, "listFileWorkspace")
      .mockResolvedValueOnce({ entries: [], unread: [] });
    fixtures.ensureFileWorkspace.mockResolvedValue({
      id: { id: "workspace" },
      kind: "fileWorkspace",
    });
    fixtures.createFile.mockImplementation(
      (await vi.importActual<typeof import("@/utils/files")>("@/utils/files")).createFile,
    );
    const setOpen = await renderModal();
    if (branch === "saved file") {
      await chooseFile();
      await act(async () =>
        host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
      );
    } else {
      await pastePgn(linkPgn);
    }
    await clickSubmit();
    expect(host.textContent).toContain(
      "The file operation failed, and cleanup also failed. Files or folders may remain. Check the collection before trying again.",
    );
    expect(host.textContent).not.toContain("private diagnostic");
    const retainedValue =
      branch === "saved file" ? input("Common.Name").value : host.querySelector("textarea")?.value;
    expect(retainedValue).toBe(branch === "saved file" ? "selected.pgn" : linkPgn);
    expect(create).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
    expect(fixtures.openFile).not.toHaveBeenCalled();
    expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
    expect(fixtures.storeSet).not.toHaveBeenCalled();
    expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  },
);

test.each([
  {
    nameTaken: true,
    message: "unrelated diagnostic",
    expected: "Name already used",
    hidden: "unrelated diagnostic",
  },
  {
    message: "Conflict: source PGN changed",
    expected: "Conflict: source PGN changed",
    hidden: "Name already used",
  },
])("saved file conflict $message retains input and shows $expected", async (failure) => {
  const { tauri, TauriCommandError } = await import("@/platform/tauri");
  const create = vi.spyOn(tauri, "createWorkspaceFile").mockRejectedValueOnce(
    new TauriCommandError({
      tag: "backend-error",
      category: "conflict",
      message: failure.message,
      ...("nameTaken" in failure ? { nameTaken: failure.nameTaken } : {}),
    }),
  );
  fixtures.ensureFileWorkspace.mockResolvedValue({
    id: { id: "workspace" },
    kind: "fileWorkspace",
  });
  fixtures.createFile.mockImplementation(
    (await vi.importActual<typeof import("@/utils/files")>("@/utils/files")).createFile,
  );
  const setOpen = await renderModal();
  await chooseFile();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
  );
  await setInputValue(input("Common.Name"), "Keep this name.pgn");
  await clickSubmit();

  expect(host.textContent).toContain(failure.expected);
  expect(host.querySelector('[data-testid="error-Common.Name"]')?.textContent).toBe(
    failure.expected,
  );
  expect(input("Common.Name").value).toBe("Keep this name.pgn");
  expect(fixtures.loadFileGame).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain(failure.hidden);
  expect(modalElement().dataset.opened).toBe("true");
  expect(create).toHaveBeenCalledOnce();
  expect(fixtures.openFile).not.toHaveBeenCalled();
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
  expect(fixtures.storeSet).not.toHaveBeenCalled();
  expect(fixtures.setTabs).not.toHaveBeenCalled();
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(setOpen).not.toHaveBeenCalled();
});

test.each(["saved file", "pasted PGN"])(
  "cleanup importing %s after unmount uses the files notification",
  async (branch) => {
    const { tauri, TauriCommandError } = await import("@/platform/tauri");
    const cause = new TauriCommandError({
      tag: "backend-error",
      category: "operation-and-cleanup",
      message: "private diagnostic",
    });
    const held = deferred<void>();
    const create = vi.spyOn(tauri, "createWorkspaceFile").mockImplementationOnce(async () => {
      await held.promise;
      throw cause;
    });
    vi.spyOn(tauri, "listFileWorkspace").mockResolvedValueOnce({ entries: [], unread: [] });
    fixtures.ensureFileWorkspace.mockResolvedValue({
      id: { id: "workspace" },
      kind: "fileWorkspace",
    });
    fixtures.createFile.mockImplementation(
      (await vi.importActual<typeof import("@/utils/files")>("@/utils/files")).createFile,
    );
    await renderModal();
    if (branch === "saved file") {
      await chooseFile();
      await act(async () =>
        host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
      );
    } else {
      await pastePgn(linkPgn);
    }
    await clickSubmit();
    expect(create).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    rootMounted = false;
    await act(async () => held.resolve());
    expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
      "Common.Error",
      cause,
      "files",
    );
    expect(fixtures.openFile).not.toHaveBeenCalled();
    expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
    expect(fixtures.storeSet).not.toHaveBeenCalled();
  },
);

test("Link import parses and submits its tree once with the owner and analysis fields", async () => {
  const seed = vi.spyOn(tabStorage, "seed");
  const tree = defaultTree();
  tree.headers.event = "Parsed online game";
  fixtures.parsePGN.mockResolvedValue(tree);
  await renderModal("link-owner");
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), link);
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.getChesscomGame).toHaveBeenCalledWith(link);
  expect(fixtures.parsePGN).toHaveBeenCalledWith(linkPgn);
  expect(fixtures.replaceNewTab).toHaveBeenCalledWith({
    store: fixtures.store,
    ownerId: "link-owner",
    tab: {
      name: "Parsed online game",
      gameOrigin: { kind: "none" },
      type: "analysis",
    },
    tree,
  });
  expect(seed).not.toHaveBeenCalled();
});

test("FEN import submits a tree with the normalized FEN and owner fields", async () => {
  const seed = vi.spyOn(tabStorage, "seed");
  const normalizedFen = "8/8/8/8/8/8/8/K6k w - - 0 1";
  await renderModal("fen-owner");
  await chooseType("FEN");
  await setInputValue(input("FEN"), ` ${normalizedFen} `);
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.replaceNewTab).toHaveBeenCalledWith({
    store: fixtures.store,
    ownerId: "fen-owner",
    tab: {
      name: "Home.Card.AnalysisBoard.Title",
      gameOrigin: { kind: "none" },
      type: "analysis",
    },
    tree: expect.objectContaining({ headers: expect.objectContaining({ fen: normalizedFen }) }),
  });
  expect(seed).not.toHaveBeenCalled();
});

test("an invalid FEN shows its catalogue error and submits nothing", async () => {
  await renderModal("fen-invalid-owner");
  await chooseType("FEN");
  await setInputValue(input("FEN"), "8/8/8/8/8/8/8/K6k w - - x 1");
  await clickSubmit();

  expect(host.querySelector('[data-testid="error-FEN"]')?.textContent).toBe(
    "Errors.InvalidHalfmoves",
  );
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
});

test("a refused import keeps its inputs and modal open for a full retry", async () => {
  fixtures.replaceNewTab
    .mockReturnValueOnce({ kind: "refused", stage: "workspace" })
    .mockReturnValueOnce({ kind: "committed", id: "retried-import" });
  const setOpenModal = vi.fn();
  await renderModal("retry-owner", setOpenModal);
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), link);
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(modalElement().dataset.opened).toBe("true");
  expect(input("Import.GameURL").value).toBe(link);
  expect(setOpenModal).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("transaction failed");

  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledTimes(2));
  expect(input("Import.GameURL").value).toBe(link);
  expect(setOpenModal).not.toHaveBeenCalled();
});

const fileRecentOutcomes = [
  { name: "committed", result: { kind: "committed", id: "imported" }, addRecent: true },
  { name: "superseded", result: { kind: "superseded" }, addRecent: true },
  {
    name: "workspace-refused",
    result: { kind: "refused", stage: "workspace" },
    addRecent: true,
  },
  { name: "tree-refused", result: { kind: "refused", stage: "tree" }, addRecent: false },
  { name: "thrown", result: undefined, addRecent: false },
] as const;

test.each(fileRecentOutcomes)(
  "keeps a recent file for the $name import result according to the existing rule",
  async (outcome) => {
    fixtures.replaceNewTab.mockImplementationOnce(() => {
      if (outcome.name === "thrown") throw new Error("transaction failed");
      return outcome.result;
    });
    await renderModal();
    await chooseFile();
    await clickSubmit();
    await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

    const recentFileCall = [
      fixtures.atoms.addRecentFile,
      expect.objectContaining({ handle: fixtures.file.handle }),
    ];
    expect(fixtures.storeSet.mock.calls).toEqual(outcome.addRecent ? [recentFileCall] : []);
    expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledTimes(outcome.name === "thrown" ? 1 : 0);
    expect(hasFileOpenInFlight(fileWorkspaceKey(fixtures.file.handle))).toBe(false);
  },
);

test("keeps AppModal pending until both overlapping submissions settle", async () => {
  const requests: Array<ReturnType<typeof deferred<string>>> = [];
  fixtures.getChesscomGame.mockImplementation(() => {
    const request = deferred<string>();
    requests.push(request);
    return request.promise;
  });
  fixtures.replaceNewTab.mockReturnValue({ kind: "superseded" });
  await renderModal();
  await chooseType("Link");
  const linkInput = input("Import.GameURL");
  await setInputValue(linkInput, link);
  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledOnce());
  expect(modalElement().dataset.pending).toBe("true");

  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledTimes(2));
  expect(modalElement().dataset.pending).toBe("true");

  await act(async () => requests[0].resolve(linkPgn));
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());
  expect(modalElement().dataset.pending).toBe("true");

  await act(async () => requests[1].resolve(linkPgn));
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledTimes(2));
  expect(modalElement().dataset.pending).toBe("false");
});

test("captures the original owner when the active tab changes during a deferred Link import", async () => {
  const request = deferred<string>();
  fixtures.getChesscomGame.mockReturnValue(request.promise);
  fixtures.replaceNewTab.mockReturnValue({ kind: "superseded" });
  await renderModal("original-owner");
  await chooseType("Link");
  const linkInput = input("Import.GameURL");
  await setInputValue(linkInput, link);
  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledOnce());

  fixtures.store.activeTabId = "another-tab";
  await act(async () => {
    request.resolve(linkPgn);
    await request.promise;
  });
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.replaceNewTab.mock.calls[0][0].ownerId).toBe("original-owner");
  expect(fixtures.replaceNewTab.mock.calls[0][0].store.activeTabId).toBe("another-tab");
  expect(host.textContent).not.toContain("transaction failed");
});

test("captures the original owner when it is replaced during a deferred Link import", async () => {
  const request = deferred<string>();
  fixtures.getChesscomGame.mockReturnValue(request.promise);
  fixtures.replaceNewTab.mockReturnValue({ kind: "superseded" });
  await renderModal("original-owner");
  await chooseType("Link");
  const linkInput = input("Import.GameURL");
  await setInputValue(linkInput, link);
  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledOnce());

  await act(async () => {
    root.render(
      <ImportModal
        ownerId="replacement-owner"
        openModal
        setOpenModal={vi.fn()}
        setTabs={fixtures.setTabs}
      />,
    );
  });
  await act(async () => {
    request.resolve(linkPgn);
    await request.promise;
  });
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.replaceNewTab.mock.calls[0][0].ownerId).toBe("original-owner");
  expect(host.textContent).not.toContain("transaction failed");
});

test("reports a thrown transaction once without rendering submitError while mounted", async () => {
  const error = new Error("transaction failed");
  fixtures.replaceNewTab.mockImplementationOnce(() => {
    throw error;
  });
  await renderModal();
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), link);
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledOnce());

  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", error);
  expect(host.textContent).not.toContain("transaction failed");
});

test("reports a thrown transaction after the modal unmounts", async () => {
  const request = deferred<string>();
  const error = new Error("transaction failed after unmount");
  fixtures.getChesscomGame.mockReturnValue(request.promise);
  fixtures.replaceNewTab.mockImplementationOnce(() => {
    throw error;
  });
  await renderModal();
  await chooseType("Link");
  const linkInput = input("Import.GameURL");
  await setInputValue(linkInput, link);
  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledOnce());
  await act(async () => root.unmount());
  rootMounted = false;

  await act(async () => {
    request.resolve(linkPgn);
    await request.promise;
  });
  await vi.waitFor(() => expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledOnce());
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", error);
  expect(fixtures.replaceNewTab).toHaveBeenCalledOnce();
});

test.each([
  ["an unsupported host", "https://example.org/game/42"],
  ["a lichess URL without a game id", "https://lichess.org/"],
  [
    "a host that only contains chess.com in its path",
    "https://evil.invalid/chess.com/game/live/123",
  ],
  ["a host that only contains lichess in its name", "https://lichess.evil.invalid/abcdefgh"],
  ["text that is not a URL", "chess.com game 123"],
])("Link import rejects %s without replacing its owner", async (_case, url) => {
  await renderModal();
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), url);
  await clickSubmit();

  await vi.waitFor(() => expect(host.textContent).toContain("Import.UnsupportedGameUrl"));
  expect(fixtures.getChesscomGame).not.toHaveBeenCalled();
  expect(fixtures.getLichessGame).not.toHaveBeenCalled();
  expect(fixtures.parsePGN).not.toHaveBeenCalled();
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
});

test("Link import fetches a lichess game by the id in its URL", async () => {
  await renderModal("lichess-owner");
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), "https://lichess.org/abcdefgh/black");
  await clickSubmit();
  await vi.waitFor(() => expect(fixtures.replaceNewTab).toHaveBeenCalledOnce());

  expect(fixtures.getLichessGame).toHaveBeenCalledWith("abcdefgh");
  expect(fixtures.getChesscomGame).not.toHaveBeenCalled();
  expect(fixtures.parsePGN).toHaveBeenCalledWith(linkPgn);
  expect(fixtures.replaceNewTab).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: "lichess-owner" }),
  );
});

test("reports an import failure through a notification after the modal unmounts", async () => {
  const request = deferred<string>();
  const error = new Error("fetch failed after unmount");
  fixtures.getChesscomGame.mockReturnValue(request.promise);
  await renderModal();
  await chooseType("Link");
  const linkInput = input("Import.GameURL");
  await setInputValue(linkInput, link);
  await pressEnter(linkInput);
  await vi.waitFor(() => expect(fixtures.getChesscomGame).toHaveBeenCalledOnce());
  await act(async () => root.unmount());
  rootMounted = false;

  fixtures.parsePGN.mockRejectedValueOnce(error);
  await act(async () => {
    request.resolve(linkPgn);
    await request.promise;
  });
  await vi.waitFor(() => expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledOnce());
  expect(fixtures.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", error, "files");
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
});

test("shows an import failure inline while the modal is mounted", async () => {
  fixtures.parsePGN.mockRejectedValueOnce(new Error("unparseable game"));
  await renderModal();
  await chooseType("Link");
  await setInputValue(input("Import.GameURL"), link);
  await clickSubmit();

  await vi.waitFor(() => expect(host.textContent).toContain("unparseable game"));
  expect(fixtures.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
});

test.each([
  { saveState: "unsaved", filename: expect.stringMatching(/^import-/), filetype: "game" },
  { saveState: "saved", filename: "Najdorf repertoire", filetype: "repertoire" },
  {
    saveState: "unsaved after toggling Save",
    filename: expect.stringMatching(/^import-/),
    filetype: "game",
  },
])(
  "$saveState pasted PGN uses the text content variant and opens the created file",
  async ({ saveState, filename, filetype }) => {
    const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
    fixtures.ensureFileWorkspace.mockResolvedValue(workspace);
    fixtures.createFile.mockResolvedValue({ isErr: false, value: fixtures.file });
    await renderModal();

    const pgn = '[Event "Pasted"]\n\n1. e4 *';
    await pastePgn(pgn);
    if (saveState !== "unsaved") {
      await act(async () =>
        host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
      );
      await setInputValue(input("Common.Name"), "Najdorf repertoire");
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="mode-repertoire"]')!.click(),
      );
      if (saveState === "unsaved after toggling Save") {
        await act(async () =>
          host.querySelector<HTMLInputElement>('[data-testid="save-to-collection"]')!.click(),
        );
      }
    }
    await clickSubmit();

    expect(fixtures.createFile).toHaveBeenCalledWith({
      filename,
      listingCache: expect.objectContaining({
        cache: expect.anything(),
        mutate: expect.any(Function),
      }),
      filetype,
      content: { kind: "text", pgn },
      workspace,
      parent: workspace,
    });
    expect(fixtures.replaceNewTab).not.toHaveBeenCalled();
    expect(fixtures.openFile).toHaveBeenCalledExactlyOnceWith(fixtures.file, fixtures.setTabs);
  },
);
