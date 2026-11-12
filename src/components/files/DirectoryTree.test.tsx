import { act, forwardRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { afterEach, expect, test, vi } from "vitest";
import { activeTabAtom, expandedDirectoriesAtom, fileWorkspaceAtom, tabsAtom } from "@/state/atoms";
import { workspaceListingToEntries, type Entry, type FileMetadata, type UsableEntry } from "./file";
import DirectoryTree, { childUnreadableMessage } from "./DirectoryTree";
import type { ErrorCategory } from "@/bindings";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), notify: vi.fn(), openFile: vi.fn() }));

vi.mock("@mantine/core", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Box: forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { pl?: number }>(
    ({ children, pl: _pl, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    ),
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({
    children,
    inherit: _inherit,
    fw: _fw,
    c: _c,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & { inherit?: boolean; fw?: number; c?: string }) => (
    <span {...props}>{children}</span>
  ),
}));
vi.mock("lucide-react", () => ({
  Database: () => null,
  FileText: () => null,
  Folder: () => null,
  FolderOpen: () => null,
  FolderSymlink: (props: { "aria-hidden"?: boolean }) => <svg aria-hidden={props["aria-hidden"]} />,
  Trash2: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({
    label,
    children,
    color: _color,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    color?: string;
    variant?: string;
    size?: string | number;
  }) => (
    <button aria-label={label} {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/utils/files", () => ({ openFile: mocks.openFile }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("verified count failures lose their row handles while counted sidecar failures stay openable", () => {
  const workspace = handle("count-root");
  const entries = workspaceListingToEntries(
    {
      entries: [
        {
          handle: handle("prepared-parent"),
          name: "Folder",
          kind: "directory",
          metadata: null,
          gameCount: null,
          lastModified: 0n,
          readError: null,
          children: [
            {
              handle: handle("failed-count"),
              name: "Failed",
              kind: "file",
              children: [],
              metadata: { type: "other", tags: [] },
              gameCount: null,
              lastModified: 0n,
              readError: "io",
            },
            {
              handle: handle("counted"),
              name: "Counted",
              kind: "file",
              children: [],
              metadata: { type: "other", tags: [] },
              gameCount: 1,
              lastModified: 0n,
              readError: "invalid-input",
            },
          ],
        },
      ],
      unread: [
        {
          name: "Unverified",
          kind: "file",
          category: "permission",
          parent: handle("prepared-parent"),
        },
      ],
    },
    workspace,
  );
  expect(entries[0].type).toBe("directory");
  if (entries[0].type !== "directory") throw new Error("Expected directory");
  expect(entries[0].children).toEqual([
    { type: "unreadable", name: "Failed", category: "io", key: "prepared-parent:unread:0" },
    expect.objectContaining({
      type: "file",
      handle: handle("counted"),
      numGames: 1,
      readError: "invalid-input",
    }),
    {
      type: "unreadable",
      name: "Unverified",
      category: "permission",
      key: "prepared-parent:unread:1",
    },
  ]);
});

test("unread siblings with colliding display names keep separate focus and no file actions", async () => {
  const workspace = handle("unread-root");
  const entries = workspaceListingToEntries(
    {
      entries: [],
      unread: [
        { name: "�.pgn", kind: "file", category: "permission", parent: null },
        { name: "�.pgn", kind: "file", category: "permission", parent: null },
      ],
    },
    workspace,
  );
  expect(entries.map((entry) => entry.type === "unreadable" && entry.key)).toEqual([
    "unread-root:unread:0",
    "unread-root:unread:1",
  ]);
  expect(entries.every((entry) => !("handle" in entry))).toBe(true);
  const store = createStore();
  store.set(expandedDirectoriesAtom, []);
  const selected = vi.fn();
  const moved = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <DirectoryTree
          files={[...entries, rootFile]}
          selectedFile={null}
          setSelectedFile={selected}
          onRequestDelete={vi.fn()}
          onRequestMove={moved}
          search=""
          filter=""
        />
      </Provider>,
    ),
  );
  const rows = treeitems();
  expect(rows).toHaveLength(3);
  for (const row of rows.slice(0, 2)) {
    expect(row.textContent).toContain("�.pgn");
    expect(row.textContent).toContain("Files.ChildUnreadable.Permission");
    expect(row.textContent).not.toContain("Common.ConfirmationError.unexpected");
    expect(row.draggable).toBe(false);
    expect(row.querySelector("button")).toBeNull();
    await key(row, "Enter");
    await key(row, "m");
    act(() => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  }
  expect(selected).not.toHaveBeenCalled();
  expect(moved).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
  act(() => rows[0].focus());
  await key(rows[0], "ArrowDown");
  expect(document.activeElement).toBe(rows[1]);
  await key(rows[1], "ArrowDown");
  expect(document.activeElement).toBe(rows[2]);
  await key(rows[2], "Enter");
  expect(mocks.openFile).toHaveBeenCalledWith(rootFile, expect.anything());
});

test.each<[ErrorCategory, string]>([
  ["permission", "Files.ChildUnreadable.Permission"],
  ["invalid-input", "Files.ChildUnreadable.Invalid"],
  ["parsing", "Files.ChildUnreadable.Invalid"],
  ["resource-limit", "Files.ChildUnreadable.TooLarge"],
  ["io", "Files.ChildUnreadable.Title"],
  ["durability", "Files.ChildUnreadable.Title"],
  ["missing-resource", "Files.ChildUnreadable.Title"],
])("file child category %s selects %s", (category, key) => {
  expect(childUnreadableMessage(category, (value) => value)).toBe(key);
});

test("an invalid sidecar shows the file-child sentence and keeps its file openable", async () => {
  const store = createStore();
  const file: Entry = { ...rootFile, readError: "invalid-input" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <DirectoryTree
          files={[file]}
          selectedFile={null}
          setSelectedFile={vi.fn()}
          onRequestDelete={vi.fn()}
          search=""
          filter=""
        />
      </Provider>,
    ),
  );
  const row = item("Root");
  expect(row.textContent).toContain("Files.ChildUnreadable.Invalid");
  expect(row.textContent).not.toContain("Common.ConfirmationError.unexpected");
  expect(row.draggable).toBe(true);
  await key(row, "Enter");
  expect(mocks.openFile).toHaveBeenCalledWith(file, expect.anything());
});

const handle = (id: string) => ({ id: { id }, kind: "fileWorkspace" }) as UsableEntry["handle"];
const directory: Entry = {
  type: "directory",
  handle: handle("opaque-folder"),
  name: "Folder",
  lastModified: 1,
  children: [
    {
      type: "file",
      handle: handle("opaque-child"),
      name: "Child",
      numGames: 1,
      metadata: { type: "game", tags: [] },
      lastModified: 1,
    },
  ],
};
const rootFile: FileMetadata = {
  type: "file",
  handle: handle("opaque-root-file"),
  name: "Root",
  numGames: 3,
  metadata: { type: "game", tags: [] },
  lastModified: 1,
};

let root: Root;
let container: HTMLDivElement;

function treeitems() {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}
function item(name: string) {
  return treeitems().find((element) => element.getAttribute("aria-label") === name)!;
}
async function key(element: HTMLElement, value: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  });
}

afterEach(async () => {
  vi.clearAllMocks();
  await act(async () => root?.unmount());
  container?.remove();
});

test("supports ARIA-tree roving focus, keyboard expansion, selection, and opaque handles", async () => {
  const store = createStore();
  store.set(fileWorkspaceAtom, handle("tree-workspace-one"));
  store.set(expandedDirectoriesAtom, []);
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const onRequestDelete = vi.fn();
  function Harness() {
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={[directory, rootFile]}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={onRequestDelete}
          search=""
          filter=""
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness />));

  expect(treeitems()).toHaveLength(2);
  expect(treeitems().map((element) => element.tabIndex)).toEqual([0, -1]);
  expect(container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("Files.Title");
  expect(container.querySelectorAll('button[aria-label="Common.Delete"]')).toHaveLength(2);
  act(() => {
    container.querySelectorAll<HTMLButtonElement>('button[aria-label="Common.Delete"]')[1].click();
  });
  expect(onRequestDelete).toHaveBeenCalledWith(rootFile);
  onRequestDelete.mockClear();
  const folderDelete = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Common.Delete"]',
  )[0];
  for (const keyName of ["Enter", " "]) {
    await key(folderDelete, keyName);
    act(() => folderDelete.click());
  }
  expect(onRequestDelete).toHaveBeenCalledTimes(2);
  expect(onRequestDelete).toHaveBeenLastCalledWith(directory);
  expect(item("Folder").getAttribute("aria-expanded")).toBe("false");
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("opaque-folder");
  expect(container.textContent).not.toContain("opaque-child");

  let folder = item("Folder");
  act(() => folder.focus());
  await key(folder, "ArrowRight");
  folder = item("Folder");
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  expect(treeitems()).toHaveLength(3);
  await key(folder, "ArrowRight");
  expect(document.activeElement).toBe(item("Child"));
  await key(item("Child"), "ArrowDown");
  expect(treeitems().map((element) => element.tabIndex)).toEqual([-1, -1, 0]);
  expect(document.activeElement).toBe(item("Root"));
  await key(item("Root"), "ArrowUp");
  expect(document.activeElement).toBe(item("Child"));
  await key(item("Child"), "ArrowLeft");
  expect(document.activeElement).toBe(item("Folder"));
  await key(item("Folder"), "ArrowLeft");
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  await key(folder, "End");
  expect(document.activeElement).toBe(item("Root"));
  await key(item("Root"), "Home");
  expect(document.activeElement).toBe(item("Folder"));
  await key(folder, "Enter");
  expect(folder.getAttribute("aria-selected")).toBe("true");
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  await key(folder, " ");
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(folder.getAttribute("aria-selected")).toBe("false");
  act(() => folder.click());
  expect(folder.getAttribute("aria-selected")).toBe("true");
  act(() => folder.click());
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(folder.getAttribute("aria-selected")).toBe("false");
  act(() => folder.click());
  await key(folder, "ArrowLeft");
  expect(folder.getAttribute("aria-selected")).toBe("false");
  expect(treeitems().filter((element) => element.tabIndex === 0)).toHaveLength(1);
});

test("closing a folder gives up a nested folder's selection, even when a search hides it", async () => {
  const store = createStore();
  store.set(fileWorkspaceAtom, handle("tree-workspace-nested"));
  store.set(expandedDirectoriesAtom, []);
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const inner: Entry = {
    type: "directory",
    handle: handle("opaque-inner"),
    name: "Inner",
    lastModified: 1,
    children: [],
  };
  const outer: Entry = {
    type: "directory",
    handle: handle("opaque-outer"),
    name: "Outer",
    lastModified: 1,
    children: [inner],
  };
  const other: Entry = {
    type: "directory",
    handle: handle("opaque-other"),
    name: "Other",
    lastModified: 1,
    children: [],
  };
  const selections: (Entry | null)[] = [];
  function Harness({ search }: { search: string }) {
    const [selected, setSelected] = useState<Entry | null>(null);
    selections.push(selected);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={[outer, other, rootFile]}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={vi.fn()}
          search={search}
          filter=""
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness search="" />));
  act(() => item("Outer").click());
  act(() => item("Inner").click());
  expect(item("Inner").getAttribute("aria-selected")).toBe("true");
  act(() => item("Outer").click());
  expect(selections.at(-1)).toBeNull();

  // Inner kept its own expansion, so it takes one click to close and one to open and select.
  act(() => item("Outer").click());
  act(() => item("Inner").click());
  act(() => item("Inner").click());
  expect(selections.at(-1)?.name).toBe("Inner");
  await act(async () => root.render(<Harness search="Outer" />));
  expect(treeitems().map((element) => element.getAttribute("aria-label"))).toEqual(["Outer"]);
  act(() => item("Outer").click());
  expect(selections.at(-1)).toBeNull();

  // An open sibling folder's selection is not this folder's to give up.
  act(() => item("Outer").click());
  await act(async () => root.render(<Harness search="" />));
  act(() => item("Other").click());
  act(() => item("Outer").click());
  expect(item("Outer").getAttribute("aria-expanded")).toBe("false");
  expect(selections.at(-1)?.name).toBe("Other");
});

test("filters the visible navigation model and opens a filtered file with Enter", async () => {
  const store = createStore();
  store.set(fileWorkspaceAtom, handle("tree-workspace-two"));
  store.set(expandedDirectoriesAtom, []);
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  mocks.openFile.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  function Harness() {
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={[directory, rootFile]}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={vi.fn()}
          search="child"
          filter="game"
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness />));

  expect(treeitems().map((element) => element.getAttribute("aria-label"))).toEqual(["Folder"]);
  const folder = item("Folder");
  act(() => folder.focus());
  await key(folder, "ArrowRight");
  await key(item("Folder"), "ArrowRight");
  expect(treeitems().map((element) => element.getAttribute("aria-label"))).toEqual([
    "Folder",
    "Child",
  ]);
  expect(document.activeElement).toBe(item("Child"));

  mocks.openFile.mockResolvedValueOnce("tab-id");
  await key(item("Child"), "Enter");
  expect(mocks.openFile).toHaveBeenCalledTimes(1);
  expect(mocks.openFile).toHaveBeenCalledWith(directory.children[0], expect.anything());
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });

  mocks.openFile.mockClear();
  mocks.navigate.mockClear();
  let resolveOpen: (value: string | null) => void = () => undefined;
  mocks.openFile.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)));
  await act(async () => {
    item("Child").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(mocks.openFile).toHaveBeenCalledTimes(1);
  expect(mocks.openFile).toHaveBeenLastCalledWith(directory.children[0], expect.anything());
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => resolveOpen(null));
  expect(mocks.navigate).not.toHaveBeenCalled();

  mocks.openFile.mockRejectedValueOnce(new Error("parse failed"));
  await act(async () => {
    item("Child").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await Promise.resolve();
  });
  expect(mocks.openFile).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith("Common.Error", expect.any(Error));
});

test("file click pairs retain their first identity, support successive pairs and explicit activation", async () => {
  const store = createStore();
  store.set(expandedDirectoriesAtom, []);
  const other: FileMetadata = { ...rootFile, handle: handle("other-file") };
  mocks.openFile.mockResolvedValue("tab-id");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={[rootFile, other]}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={vi.fn()}
          search=""
          filter=""
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness />));
  const mouse = async (index: number, type: string, detail: number) => {
    await act(async () =>
      treeitems()[index].dispatchEvent(new MouseEvent(type, { bubbles: true, detail })),
    );
  };
  const selected = () => treeitems().map((row) => row.getAttribute("aria-selected"));

  // Equal display names must not stand in for file identity across a mismatched pair.
  await mouse(0, "click", 1);
  await mouse(1, "click", 2);
  await mouse(1, "dblclick", 2);
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(selected()).toEqual(["true", "false"]);

  // A fresh pair can select and open the other file after the refused gesture.
  await mouse(1, "click", 1);
  await mouse(1, "click", 2);
  await mouse(1, "dblclick", 2);
  expect(mocks.openFile).toHaveBeenCalledTimes(1);
  expect(mocks.openFile).toHaveBeenLastCalledWith(other, expect.anything());
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });

  // Native click counts can continue through successive pairs without resetting to one.
  await mouse(0, "click", 3);
  await mouse(0, "click", 4);
  await mouse(0, "dblclick", 4);
  expect(mocks.openFile).toHaveBeenCalledTimes(2);
  expect(mocks.openFile).toHaveBeenLastCalledWith(rootFile, expect.anything());
  expect(selected()).toEqual(["true", "false"]);

  await mouse(1, "click", 0);
  expect(selected()).toEqual(["false", "true"]);
  expect(mocks.openFile).toHaveBeenCalledTimes(2);
  await key(treeitems()[0], "Enter");
  expect(mocks.openFile).toHaveBeenCalledTimes(3);
  expect(mocks.openFile).toHaveBeenLastCalledWith(rootFile, expect.anything());
  expect(selected()).toEqual(["true", "false"]);
});

test("a matching folder name under a type filter requires a matching descendant", async () => {
  const store = createStore();
  store.set(fileWorkspaceAtom, handle("tree-workspace-filter"));
  store.set(expandedDirectoriesAtom, []);
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const child: Entry = {
    ...rootFile,
    name: "Caro line",
    metadata: { type: "repertoire", tags: [] },
  };
  const folder: Entry = { ...directory, name: "Caro prep", children: [child] };
  function Harness({ files }: { files: Entry[] }) {
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={files}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={vi.fn()}
          search="caro"
          filter="game"
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness files={[folder]} />));

  expect(item("Caro prep")).toBeUndefined();
  expect(treeitems()).toHaveLength(0);

  const matchingFolder: Entry = {
    ...folder,
    children: [{ ...child, metadata: { type: "game", tags: [] } }],
  };
  await act(async () => root.render(<Harness files={[matchingFolder]} />));
  expect(treeitems().map((element) => element.getAttribute("aria-label"))).toEqual(["Caro prep"]);
  await key(item("Caro prep"), "ArrowRight");
  expect(treeitems().map((element) => element.getAttribute("aria-label"))).toEqual([
    "Caro prep",
    "Caro line",
  ]);
});

test("routes context, M, and drag move intents with opaque entry handles", async () => {
  const store = createStore();
  store.set(expandedDirectoriesAtom, []);
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  const onRequestMove = vi.fn();
  const onMove = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  function Harness() {
    const [selected, setSelected] = useState<Entry | null>(null);
    return (
      <Provider store={store}>
        <DirectoryTree
          files={[directory, rootFile]}
          selectedFile={selected}
          setSelectedFile={setSelected}
          onRequestDelete={vi.fn()}
          onRequestMove={onRequestMove}
          onMove={onMove}
          search=""
          filter=""
        />
      </Provider>
    );
  }
  await act(async () => root.render(<Harness />));

  const rootMove = item("Root").querySelector<HTMLButtonElement>('button[aria-label="Files.Move"]');
  expect(rootMove).not.toBeNull();
  // An icon-sized button clips text; the name lives in the label, the child is a glyph.
  expect(rootMove?.textContent).toBe("");
  expect(rootMove?.querySelector("svg[aria-hidden]")).not.toBeNull();
  act(() => rootMove?.click());
  expect(onRequestMove).toHaveBeenCalledWith(rootFile);
  onRequestMove.mockClear();
  const source = item("Root");
  act(() => source.focus());
  await key(source, "m");
  expect(onRequestMove).toHaveBeenCalledWith(rootFile);

  const payload = new Map<string, string>();
  const dataTransfer = {
    setDragImage: vi.fn(),
    setData: (type: string, value: string) => payload.set(type, value),
    getData: (type: string) => payload.get(type) || "",
  };
  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return event;
  };
  act(() => source.dispatchEvent(drag("dragstart")));
  expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector("[inert]")?.textContent).toContain("Root");
  act(() => item("Folder").dispatchEvent(drag("drop")));
  expect(document.body.querySelector("[inert]")).toBeNull();
  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onMove).toHaveBeenCalledWith(rootFile, directory);
});

test.each([
  ["Repertoire", [rootFile], "Files.Title · Repertoire"],
  ["", [rootFile], "Files.Title"],
  // A tree without rows renders no heading: role="tree" may not hold headings alone.
  ["Repertoire", [], undefined],
])("the grouped Files heading names folder %j listing %j", async (folderName, files, heading) => {
  const store = createStore();
  store.set(fileWorkspaceAtom, handle("tree-workspace-heading"));
  store.set(expandedDirectoriesAtom, []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <DirectoryTree
          files={files}
          selectedFile={null}
          setSelectedFile={() => {}}
          onRequestDelete={() => {}}
          search=""
          filter=""
          grouped
          folderName={folderName}
        />
      </Provider>,
    ),
  );
  const title = [...container.querySelectorAll('[data-section="files"] span')].find((element) =>
    element.textContent?.startsWith("Files.Title"),
  );
  expect(title?.textContent).toBe(heading);
});
