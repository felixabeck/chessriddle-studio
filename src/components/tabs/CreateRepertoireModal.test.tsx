import { act, type HTMLAttributes, type InputHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tauri, TauriCommandError } from "@/platform/tauri";

const fixtures = vi.hoisted(() => ({
  createFile: vi.fn(),
  ensureFileWorkspace: vi.fn(),
  navigate: vi.fn(),
  openFile: vi.fn(),
  setTabs: vi.fn(),
  storeSet: vi.fn(),
}));

vi.mock("@/state/atoms", () => ({
  activeTabAtom: Symbol("active-tab"),
  addRecentFileAtom: Symbol("add-recent-file"),
  tabFamily: () => Symbol("tab-family"),
  tabsAtom: Symbol("tabs"),
}));
vi.mock("@/utils/chess", () => ({ headersToPGN: () => '[Event "White"]\n\n*' }));
vi.mock("@/utils/files", () => ({
  createFile: fixtures.createFile,
  ensureFileWorkspace: fixtures.ensureFileWorkspace,
  openFile: fixtures.openFile,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixtures.navigate }));
vi.mock("jotai", () => ({
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
vi.mock("../common/AppModal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mantine/core", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  SegmentedControl: () => <div />,
  Stack: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
  TextInput: ({ error, ...props }: InputHTMLAttributes<HTMLInputElement> & { error?: string }) => (
    <label>
      <input {...props} />
      {error && <span role="alert">{error}</span>}
    </label>
  ),
}));

import CreateRepertoireModal from "./CreateRepertoireModal";

// Load the real recovery facade before a test starts, so its module loading cannot outlive a test.
const actualFiles = await vi.importActual<typeof import("@/utils/files")>("@/utils/files");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const setOpened = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

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
