import { notifications } from "@mantine/notifications";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle } from "@/bindings";
import LineSectionEditor, { type LineSectionTarget } from "./LineSectionEditor";

const mocks = vi.hoisted(() => ({
  readFileGame: vi.fn(),
  writeFileGame: vi.fn(),
  scanBlockingTabs: vi.fn(),
  tabs: [] as unknown[],
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("jotai", async () => ({
  ...(await vi.importActual<typeof import("jotai")>("jotai")),
  useAtomValue: () => mocks.tabs,
}));
vi.mock("@/state/atoms", () => ({ tabsAtom: {} }));
vi.mock("@/state/quitGate", () => ({ scanBlockingTabs: mocks.scanBlockingTabs }));
vi.mock("@/utils/files", () => ({
  readFileGame: mocks.readFileGame,
  writeFileGame: mocks.writeFileGame,
}));
vi.mock("@/utils/tabs", () => ({
  isFileBackedTab: (tab: { gameOrigin?: { kind: string } }) => tab.gameOrigin?.kind === "file",
}));
vi.mock("@/components/library/presentation", () => ({ libraryButtonProps: {} }));
vi.mock("@/components/common/AppModal", () => ({
  default: ({ children, title }: any) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@mantine/core", () => {
  const Menu = ({ children }: any) => <div>{children}</div>;
  Menu.Target = ({ children }: any) => <>{children}</>;
  Menu.Dropdown = ({ children }: any) => <div>{children}</div>;
  Menu.Item = ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>;
  return {
    Menu,
    Button: ({ children, type, disabled }: any) => (
      <button type={type} disabled={disabled}>
        {children}
      </button>
    ),
    Stack: ({ children }: any) => <div>{children}</div>,
    TextInput: ({ value, onChange }: any) => <input value={value} onChange={onChange} />,
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const file: FileWorkspaceHandle = { id: { id: "file" }, kind: "fileWorkspace" };
const pgn = '[Event "A"]\n\n1. e4 *\n';
const target: LineSectionTarget = { index: 3, section: undefined, stamp: "s1", x: 1, y: 2 };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onSaved = vi.fn();
const onStale = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs = [];
  mocks.scanBlockingTabs.mockReturnValue([]);
  mocks.readFileGame.mockResolvedValue({ pgn, stamp: "s1", present: true });
  mocks.writeFileGame.mockResolvedValue({ stamp: "s2", revision: "r2" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(value: LineSectionTarget = target) {
  await act(async () => {
    root.render(
      <LineSectionEditor
        file={file}
        target={value}
        onClose={onClose}
        onSaved={onSaved}
        onStale={onStale}
      />,
    );
  });
}

async function clickItem(label: string) {
  const item = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

async function typeName(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}

test("a line without a section only offers starting one", async () => {
  await render();
  expect(host.textContent).toBe("Files.LineSection.Start");
});

test("a line with a section offers renaming and removal", async () => {
  await render({ ...target, section: "" });
  expect(host.textContent).toBe("Files.LineSection.RenameFiles.LineSection.Remove");
});

test("saving writes the tag against the stamp it read and reports the new identity", async () => {
  await render();
  await clickItem("Files.LineSection.Start");
  await typeName("mit g3");
  await submit();
  expect(mocks.writeFileGame).toHaveBeenCalledExactlyOnceWith(
    file,
    3,
    '[Event "A"]\n[Section "mit g3"]\n\n1. e4 *\n',
    { kind: "game", stamp: "s1" },
  );
  expect(onSaved).toHaveBeenCalledExactlyOnceWith(3, "mit g3", { stamp: "s2", revision: "r2" });
  expect(onClose).toHaveBeenCalledOnce();
});

test("an empty name saves an unnamed section", async () => {
  await render();
  await clickItem("Files.LineSection.Start");
  await submit();
  expect(mocks.writeFileGame.mock.calls[0][2]).toContain('[Section ""]');
  expect(onSaved.mock.calls[0][1]).toBe("");
});

test("removing rewrites the line without the tag", async () => {
  mocks.readFileGame.mockResolvedValue({
    pgn: '[Event "A"]\n[Section "x"]\n\n1. e4 *\n',
    stamp: "s1",
    present: true,
  });
  await render({ ...target, section: "x" });
  await clickItem("Files.LineSection.Remove");
  expect(mocks.writeFileGame.mock.calls[0][2]).toBe(pgn);
  expect(onSaved.mock.calls[0][1]).toBeUndefined();
});

test.each([
  ["a different line now at this position", { pgn, stamp: "other", present: true }],
  ["a line no longer in the file", { pgn: "", stamp: "s1", present: false }],
])("refuses %s without writing", async (_name, game) => {
  mocks.readFileGame.mockResolvedValue(game);
  await render();
  await clickItem("Files.LineSection.Start");
  await submit();
  expect(mocks.writeFileGame).not.toHaveBeenCalled();
  expect(onStale).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test("a stale refusal from the write refreshes the list", async () => {
  mocks.writeFileGame.mockRejectedValue({
    tag: "backend-error",
    category: "stale-game",
    message: "stale",
  });
  await render();
  await clickItem("Files.LineSection.Start");
  await submit();
  expect(onStale).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test("refuses while this line has unsaved changes in an open tab", async () => {
  const lineTab = {
    gameOrigin: { kind: "file", gameNumber: 3, file: { handle: file } },
  };
  const otherLineTab = {
    gameOrigin: { kind: "file", gameNumber: 4, file: { handle: file } },
  };
  mocks.tabs = [lineTab, otherLineTab];
  mocks.scanBlockingTabs.mockReturnValue([{ value: "tab" }]);
  await render();
  await clickItem("Files.LineSection.Start");
  await submit();
  expect(mocks.scanBlockingTabs).toHaveBeenCalledExactlyOnceWith([lineTab]);
  expect(mocks.readFileGame).not.toHaveBeenCalled();
  expect(mocks.writeFileGame).not.toHaveBeenCalled();
  expect(vi.mocked(notifications.show).mock.calls[0][0].message).toBe(
    "Files.LineSection.UnsavedTab",
  );
  expect(onClose).toHaveBeenCalledOnce();
});
