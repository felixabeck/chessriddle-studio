import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { ErrorCategory } from "@/bindings";
import englishCatalogue from "@/translation/en-US.json";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateTrash: vi.fn(),
  trashData: { items: [] as Array<unknown>, olderCount: 0, cursor: null as unknown },
  trashError: undefined as unknown,
  listFileWorkspace: vi.fn(),
  listWorkspaceTrash: vi.fn(),
  emptyWorkspaceTrash: vi.fn(),
  trashWorkspaceEntry: vi.fn(),
  restoreWorkspaceTrashItem: vi.fn(),
  deleteWorkspaceTrashItem: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceDirectory: vi.fn(),
  renameWorkspaceFile: vi.fn(),
  writeWorkspaceFileMetadata: vi.fn(),
  issueFileWorkspace: vi.fn(),
  setWorkspace: vi.fn(),
  setWorkspaceDisplayName: vi.fn(),
  notify: vi.fn(),
  data: [] as Array<unknown> | undefined,
  cardMounts: [] as string[],
  error: undefined as unknown,
  realSWR: false,
  workspace: undefined as unknown,
}));
const stateAtoms = vi.hoisted(() => ({
  fileWorkspaceAtom: {},
  fileWorkspaceDisplayNameAtom: {},
  fontSizeAtom: {},
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      listFileWorkspace: mocks.listFileWorkspace,
      listWorkspaceTrash: mocks.listWorkspaceTrash,
      emptyWorkspaceTrash: mocks.emptyWorkspaceTrash,
      trashWorkspaceEntry: mocks.trashWorkspaceEntry,
      restoreWorkspaceTrashItem: mocks.restoreWorkspaceTrashItem,
      deleteWorkspaceTrashItem: mocks.deleteWorkspaceTrashItem,
      moveWorkspaceEntry: mocks.moveWorkspaceEntry,
      createWorkspaceFile: mocks.createWorkspaceFile,
      createWorkspaceDirectory: mocks.createWorkspaceDirectory,
      renameWorkspaceFile: mocks.renameWorkspaceFile,
      writeWorkspaceFileMetadata: mocks.writeWorkspaceFileMetadata,
      issueFileWorkspace: mocks.issueFileWorkspace,
    },
  };
});
vi.mock("jotai", () => ({
  useAtomValue: (atom: object) => {
    if (atom !== stateAtoms.fontSizeAtom) throw new Error("Unexpected atom");
    return 100;
  },
  useAtom: (atom: object) =>
    atom === stateAtoms.fileWorkspaceAtom
      ? [mocks.workspace ?? workspace, mocks.setWorkspace]
      : ["", mocks.setWorkspaceDisplayName],
}));
vi.mock("@/state/atoms", () => stateAtoms);
vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof import("swr")>("swr");
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) =>
      mocks.realSWR
        ? actual.default(...args)
        : Array.isArray(args[0]) && args[0][0] === "workspace-trash"
          ? { data: mocks.trashData, error: mocks.trashError, mutate: mocks.mutateTrash }
          : { data: mocks.data, error: mocks.error, mutate: mocks.mutate },
    useSWRConfig: () => {
      const config = actual.useSWRConfig();
      return mocks.realSWR ? config : { ...config, mutate: mocks.mutate };
    },
  };
});
vi.mock("react-i18next", async () => {
  const { default: catalogue } = await import("@/translation/en-US.json");
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string; name?: string }) =>
        key === "Common.NameAlreadyUsed" || key.startsWith("Files.Refusal.")
          ? catalogue.translation[key as keyof typeof catalogue.translation]
          : options?.defaultValue?.replace("{{name}}", options.name || "") || key,
    }),
  };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("@mantine/core", async (importOriginal) => {
  const { createContext, useContext } = await import("react");
  const RadioContext = createContext({ value: "", onChange: (_value: string) => {} });
  const Radio = Object.assign(
    ({ value, label }: { value: string; label: string }) => {
      const group = useContext(RadioContext);
      return (
        <label>
          <input
            type="radio"
            value={value}
            checked={group.value === value}
            onChange={() => group.onChange(value)}
          />
          {label}
        </label>
      );
    },
    {
      Group: ({
        label,
        value,
        onChange,
        children,
      }: {
        label: string;
        value: string;
        onChange: (value: string) => void;
        children: React.ReactNode;
      }) => (
        <RadioContext.Provider value={{ value, onChange }}>
          <div role="radiogroup" aria-label={label}>
            {children}
          </div>
        </RadioContext.Provider>
      ),
    },
  );
  return {
    ...(await importOriginal<typeof import("@mantine/core")>()),
    Button: ({
      children,
      loading,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
      <button {...props} disabled={props.disabled || loading}>
        {children}
      </button>
    ),
    Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Input: ({
      leftSection: _leftSection,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement> & { leftSection?: React.ReactNode }) => (
      <input {...props} />
    ),
    Modal: ({
      opened,
      title,
      children,
      onClose,
    }: {
      opened: boolean;
      title: string;
      children: React.ReactNode;
      onClose: () => void;
    }) =>
      opened ? (
        <div role="dialog" aria-label={title}>
          <button onClick={onClose}>Close dialog</button>
          {children}
        </div>
      ) : null,
    Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Box: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Radio,
    ScrollArea: {
      Autosize: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    },
    Select: ({
      "aria-label": ariaLabel,
      label,
      value,
      onChange,
      data,
    }: {
      "aria-label"?: string;
      label?: string;
      value: string | null;
      onChange: (value: string | null) => void;
      data: { value: string; label: string }[];
    }) => (
      <select
        aria-label={ariaLabel ?? label}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        <option value="" />
        {data.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    ),
    SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Text: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
      <p {...props}>{children}</p>
    ),
    TextInput: ({
      label,
      error,
      ...props
    }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) => (
      <label>
        {label}
        <input aria-label={label} {...props} />
        {error && <span role="alert">{error}</span>}
      </label>
    ),
    Title: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  };
});
vi.mock("./DirectoryTree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DirectoryTree")>()),
  default: ({
    files,
    setSelectedFile,
    selectedFile,
    onRequestMove,
    onMove,
    search,
    filter,
  }: {
    files: Array<unknown>;
    setSelectedFile: (entry: unknown) => void;
    selectedFile: { name?: string } | null;
    onRequestMove?: (entry: unknown) => void;
    onMove?: (entry: unknown, destination: unknown) => Promise<void> | void;
    search: string;
    filter: string;
  }) => (
    <>
      <span data-testid="tree" data-search={search} data-filter={filter} />
      <span data-testid="entries">
        {(files as { name: string }[]).map((file) => file.name).join(",")}
      </span>
      <output>{selectedFile?.name || "No selection"}</output>
      <button type="button" onClick={() => setSelectedFile(files[0])}>
        Select sample file
      </button>
      <button type="button" onClick={() => setSelectedFile(files[1])}>
        Select destination folder
      </button>
      <button type="button" onClick={() => onRequestMove?.(files[0])}>
        Context Move
      </button>
      <button type="button" onClick={() => onRequestMove?.(files[0])}>
        Keyboard M
      </button>
      <button type="button" onClick={() => onMove?.(files[0], files[1])}>
        Drag to folder
      </button>
      <button
        type="button"
        onClick={() => {
          void onMove?.(files[0], files[1]);
          void onMove?.(files[0], files[1]);
        }}
      >
        Drag twice
      </button>
    </>
  ),
}));

vi.mock("./FileCard", async () => {
  const { useEffect, useRef } = await vi.importActual<typeof import("react")>("react");
  return {
    default: function FileCardStub({
      selected,
      onEditMetadata,
    }: {
      selected: { name: string };
      onEditMetadata: () => void;
    }) {
      const mountName = useRef(selected.name);
      useEffect(() => {
        mocks.cardMounts.push(mountName.current);
      }, []);
      return (
        <>
          <section data-testid="file-card">{selected.name}</section>
          <button onClick={onEditMetadata}>Files.EditMetadata</button>
        </>
      );
    },
  };
});

const workspace = { id: { id: "workspace-token" }, kind: "fileWorkspace" } as const;
const entry = {
  type: "file",
  handle: { id: { id: "entry-token" }, kind: "fileWorkspace" },
  name: "sample.pgn",
  numGames: 2,
  metadata: { type: "game", tags: [] },
  lastModified: 1,
};
const destination = {
  type: "directory",
  handle: { id: { id: "destination-token" }, kind: "fileWorkspace" as const },
  name: "Destination",
  children: [],
  lastModified: 1,
};

import { TauriCommandError } from "@/platform/tauri";
import { useFileWorkspace } from "./useFileWorkspace";
import DirectoryTree from "./DirectoryTree";
import type { Entry } from "./file";
import { Input, Select } from "@mantine/core";
import { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { workspaceListingKey, type WorkspaceListingCache } from "./workspaceListing";
let controller!: ReturnType<typeof useFileWorkspace>;
function FilesPage() {
  const [selected, setSelected] = useState<Entry | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const source = useFileWorkspace(selected, setSelected);
  controller = source;
  return (
    <>
      {source.chooser}
      {source.creation}
      <Input
        aria-label="Common.Search"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <Select
        label="Files.FileType"
        value={filter}
        onChange={(v) => setFilter(v ?? "")}
        data={["game", "repertoire", "tournament", "puzzle", "other"].map((value) => ({
          value,
          label: value,
        }))}
      />
      {source.trash}
      {source.status}
      {source.data && source.failure === "silent" && (
        <DirectoryTree {...source.listProps} search={search} filter={filter} />
      )}
      {source.detail}
      {source.dialogs}
    </>
  );
}

const cleanupCopy =
  "The file operation failed, and cleanup also failed. Files or folders may remain. Check the collection before trying again.";
const nativeLeftover = {
  handle: { id: { id: "leftover" }, kind: "fileWorkspace" },
  kind: "directory",
  name: "Leftover",
  children: [],
  metadata: null,
  gameCount: null,
  lastModified: 1,
};
const nativeFile = {
  ...nativeLeftover,
  handle: entry.handle,
  kind: "file",
  name: entry.name,
  metadata: entry.metadata,
  gameCount: 2,
};
const nativeDestination = { ...nativeLeftover, handle: destination.handle, name: destination.name };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function realWorkspace() {
  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.realSWR = true;
  const cache = new Map();
  let config!: WorkspaceListingCache;
  function Capture() {
    config = useSWRConfig();
    return <FilesPage />;
  }
  async function render(provider = cache) {
    await act(async () =>
      root.render(
        <SWRConfig
          key={provider === cache ? "original" : "replacement"}
          value={{
            provider: () => provider,
            shouldRetryOnError: false,
            revalidateOnFocus: false,
            dedupingInterval: 0,
          }}
        >
          <Capture />
        </SWRConfig>,
      ),
    );
  }
  await render();
  return { cache, config, render };
}

test.each(["file", "folder", "rename", "metadata", "move"] as const)(
  "cleanup %s reconciles real SWR and preserves failure state",
  async (action) => {
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockResolvedValue({ entries: [nativeFile, nativeDestination, nativeLeftover], unread: [] });
    const command = {
      file: mocks.createWorkspaceFile,
      folder: mocks.createWorkspaceDirectory,
      rename: mocks.renameWorkspaceFile,
      metadata: mocks.writeWorkspaceFileMetadata,
      move: mocks.moveWorkspaceEntry,
    }[action];
    command.mockRejectedValueOnce(commandError("operation-and-cleanup", "private diagnostic"));
    await realWorkspace();
    if (action === "file" || action === "folder")
      click(action === "file" ? "Create file" : "Create folder");
    else {
      click("Select sample file");
      click(action === "rename" ? "Rename" : action === "metadata" ? "Files.EditMetadata" : "Move");
    }
    if (action !== "move")
      await setDialogName(action === "metadata" ? entry.name : "Keep this name");
    if (action === "metadata") {
      const select = container.querySelector('[role="dialog"] select') as HTMLSelectElement;
      await act(async () => {
        select.value = "repertoire";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    expect(command).toHaveBeenCalledOnce();
    expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="entries"]')?.textContent).toContain("Leftover");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(cleanupCopy);
    expect(container.textContent).not.toContain(
      "The file operation could not be completed. Please try again.",
    );
    expect(container.textContent).not.toContain("private diagnostic");
    expect(
      (
        container.querySelector(
          '[role="dialog"] input[aria-label="Name"]',
        ) as HTMLInputElement | null
      )?.value,
    ).toBe(action === "move" ? undefined : action === "metadata" ? entry.name : "Keep this name");
  },
);

test.each([false, true])(
  "move cleanup awaits delayed real SWR listing and blocks duplicate admission, relist failure=%s",
  async (fails) => {
    const listing = deferred<unknown[]>();
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockReturnValueOnce(listing.promise.then((entries) => ({ entries, unread: [] })));
    mocks.moveWorkspaceEntry.mockRejectedValueOnce(
      commandError("operation-and-cleanup", "private diagnostic"),
    );
    await realWorkspace();
    let settled = false;
    let moving!: Promise<void>;
    let duplicate: Promise<void> | undefined;
    await act(async () => {
      moving = controller.listProps.onMove(entry as Entry, destination as Entry)!.then(() => {
        settled = true;
      });
    });
    try {
      expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(2);
      await act(async () => {
        duplicate = controller.listProps.onMove(entry as Entry, destination as Entry);
      });
      expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(container.textContent).not.toContain(cleanupCopy);
    } finally {
      await act(async () => {
        if (fails) listing.reject(new Error("relist unavailable"));
        else listing.resolve([nativeFile, nativeDestination, nativeLeftover]);
        await moving;
        await duplicate;
      });
    }
    expect(settled).toBe(true);
    expect(container.textContent).toContain(cleanupCopy);
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce();
    expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe(
      fails ? undefined : [entry.name, destination.name, nativeLeftover.name].join(","),
    );
    expect(container.textContent).not.toContain("relist unavailable");
  },
);

test("cleanup failed relist keeps its original visible warning and entered name", async () => {
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockRejectedValue(new Error("relist unavailable"));
  mocks.createWorkspaceDirectory.mockRejectedValueOnce(
    commandError("operation-and-cleanup", "private diagnostic"),
  );
  await realWorkspace();
  click("Create folder");
  await setDialogName("Keep this name");
  await act(async () => dialogButton("Confirm").click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(cleanupCopy);
  expect((container.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe(
    "Keep this name",
  );
  expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(2);
  expect(mocks.createWorkspaceDirectory).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("relist unavailable");
});

test("cleanup drains an old native listing and late resolution cannot overwrite the fresh leftover", async () => {
  const old = deferred<unknown[]>();
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockReturnValueOnce(old.promise.then((entries) => ({ entries, unread: [] })))
    .mockResolvedValueOnce({ entries: [nativeLeftover], unread: [] });
  mocks.createWorkspaceDirectory.mockRejectedValueOnce(
    commandError("operation-and-cleanup", "private diagnostic"),
  );
  const { cache, config } = await realWorkspace();
  let prior!: Promise<unknown>;
  await act(async () => {
    prior = config.mutate(workspaceListingKey(workspace));
  });
  click("Create folder");
  await setDialogName("Leftover");
  await act(async () => dialogButton("Confirm").click());
  expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(3);
  expect(mocks.listFileWorkspace.mock.calls[1][1].signal.aborted).toBe(true);
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("Leftover");
  await act(async () => {
    old.resolve([]);
    await prior;
  });
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("Leftover");
  expect(cache.get(unstable_serialize(workspaceListingKey(workspace))).data[0].name).toBe(
    "Leftover",
  );
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(cleanupCopy);
});

test("cleanup reconciles captured A while switched B keeps its own listing and A reloads on return", async () => {
  const freshA = deferred<unknown[]>();
  const pendingMutation = deferred<void>();
  const other = { id: { id: "workspace-B" }, kind: "fileWorkspace" } as const;
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockResolvedValueOnce({ entries: [{ ...nativeLeftover, name: "B only" }], unread: [] })
    .mockReturnValueOnce(freshA.promise.then((entries) => ({ entries, unread: [] })))
    .mockResolvedValue({ entries: [nativeLeftover], unread: [] });
  mocks.createWorkspaceDirectory.mockReturnValueOnce(pendingMutation.promise);
  const { cache, render } = await realWorkspace();
  click("Create folder");
  await setDialogName("Leftover");
  await act(async () => dialogButton("Confirm").click());
  mocks.workspace = other;
  await render();
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("B only");
  await act(async () =>
    pendingMutation.reject(commandError("operation-and-cleanup", "private diagnostic")),
  );
  expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(3);
  await act(async () => freshA.resolve([nativeLeftover]));
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("B only");
  expect(cache.get(unstable_serialize(workspaceListingKey(workspace)))?.data).toBeUndefined();
  expect(mocks.listFileWorkspace.mock.calls.map(([handle]) => handle)).toEqual([
    workspace,
    other,
    workspace,
  ]);
  mocks.workspace = workspace;
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("Leftover"),
  );
  expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(4);
  expect(mocks.createWorkspaceDirectory).toHaveBeenCalledOnce();
});

test("cleanup rejection after switching pending mutation A to B reconciles only A", async () => {
  const pendingMutation = deferred<void>();
  const other = { id: { id: "pending-mutation-workspace-B" }, kind: "fileWorkspace" } as const;
  const bEntry = { ...nativeLeftover, name: "B listing" };
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockResolvedValueOnce({ entries: [bEntry], unread: [] })
    .mockResolvedValueOnce({ entries: [nativeLeftover], unread: [] });
  mocks.createWorkspaceDirectory.mockReturnValueOnce(pendingMutation.promise);
  const { cache, render } = await realWorkspace();
  click("Create folder");
  await setDialogName("A leftover");
  await act(async () => dialogButton("Confirm").click());
  expect(mocks.createWorkspaceDirectory).toHaveBeenCalledExactlyOnceWith(
    workspace,
    workspace,
    "A leftover",
  );

  mocks.workspace = other;
  await render();
  expect(mocks.listFileWorkspace.mock.calls.map(([handle]) => handle)).toEqual([workspace, other]);
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("B listing");
  const bKey = unstable_serialize(workspaceListingKey(other));
  const bData = cache.get(bKey).data;
  expect(bData).toEqual([expect.objectContaining({ name: "B listing" })]);

  await act(async () =>
    pendingMutation.reject(commandError("operation-and-cleanup", "private A diagnostic")),
  );

  expect(mocks.listFileWorkspace.mock.calls.map(([handle]) => handle)).toEqual([
    workspace,
    other,
    workspace,
  ]);
  expect(mocks.createWorkspaceDirectory).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("B listing");
  expect(cache.get(bKey).data).toBe(bData);
  expect(cache.get(bKey).error).toBeUndefined();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain(cleanupCopy);
  expect(container.textContent).not.toContain("private A diagnostic");
});

function commandError(category: ErrorCategory, message: string) {
  return new TauriCommandError({
    tag: "backend-error",
    category,
    message,
  });
}

const mutationCommands = {
  file: mocks.createWorkspaceFile,
  folder: mocks.createWorkspaceDirectory,
  rename: mocks.renameWorkspaceFile,
  metadata: mocks.writeWorkspaceFileMetadata,
  move: mocks.moveWorkspaceEntry,
};
type MutationAction = keyof typeof mutationCommands;
const refusalCopy = englishCatalogue.translation;
const durabilityCopy = englishCatalogue.translation["Common.DurabilityUncertain"];

function expectDurabilityNotice() {
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "warning",
    message: durabilityCopy,
  });
  expect(container.textContent).not.toContain(refusalCopy["Files.OperationFailed"]);
  expect(container.textContent).not.toContain("private diagnostic");
}

async function openMutation(action: MutationAction) {
  if (action === "file" || action === "folder")
    click(action === "file" ? "Create file" : "Create folder");
  else {
    click("Select sample file");
    click(action === "rename" ? "Rename" : action === "metadata" ? "Files.EditMetadata" : "Move");
  }
  if (action !== "move") await setDialogName(action === "metadata" ? entry.name : "Retained draft");
  if (action === "metadata") setDialogType("repertoire");
}

describe.each(Object.keys(mutationCommands) as MutationAction[])("%s durability", (action) => {
  test.each([false, true])(
    "closes and notifies once after the relist finishes, listing failure=%s",
    async (fails) => {
      const listing = deferred<unknown[]>();
      mocks.listFileWorkspace
        .mockReset()
        .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
        .mockReturnValueOnce(listing.promise.then((entries) => ({ entries, unread: [] })));
      mutationCommands[action].mockRejectedValueOnce(
        commandError("durability", "private diagnostic"),
      );
      await realWorkspace();
      await openMutation(action);
      await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
      expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(2);
      expect(mocks.notify).not.toHaveBeenCalled();
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        if (fails) listing.reject(new Error("private listing diagnostic"));
        else listing.resolve([nativeFile, nativeDestination, nativeLeftover]);
      });
      expect(mutationCommands[action]).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expectDurabilityNotice();
      expect(container.textContent).not.toContain("private listing diagnostic");
    },
  );

  test("durable success closes without a notice", async () => {
    await openMutation(action);
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

test.each([false, true])(
  "late durability preserves a replacement dialog's draft, alert and open state, relist failure=%s",
  async (fails) => {
    const old = deferred<void>();
    mocks.createWorkspaceDirectory
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(commandError("permission", "replacement diagnostic"));
    await openMutation("folder");
    await act(async () => dialogButton("Confirm").click());
    click("Close dialog");
    await openMutation("folder");
    await setDialogName("Replacement draft");
    await act(async () => dialogButton("Confirm").click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      refusalCopy["Files.Refusal.Permission"],
    );
    const before = dialog.outerHTML;
    if (fails) mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
    await act(async () => old.reject(commandError("durability", "private diagnostic")));
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.outerHTML).toBe(before);
    expect((dialog.querySelector("input") as HTMLInputElement).value).toBe("Replacement draft");
    expectDurabilityNotice();
  },
);

test.each(["workspace", "provider", "unmount"] as const)(
  "late durability still notifies after %s retires the page presentation",
  async (replacement) => {
    const pending = deferred<void>();
    mocks.listFileWorkspace.mockReset().mockResolvedValue({ entries: [], unread: [] });
    mocks.createWorkspaceDirectory.mockReturnValueOnce(pending.promise);
    const { cache, render } = await realWorkspace();
    await openMutation("folder");
    await act(async () => dialogButton("Confirm").click());
    if (replacement === "workspace")
      mocks.workspace = { id: { id: "durability-B" }, kind: "fileWorkspace" };
    if (replacement === "unmount") await act(async () => root.render(<div>Unmounted</div>));
    else await render(replacement === "provider" ? new Map() : cache);
    if (replacement !== "unmount") {
      await openMutation("folder");
      await setDialogName("Replacement draft");
    }
    const before = container.innerHTML;
    await act(async () => pending.reject(commandError("durability", "private diagnostic")));
    expect(container.innerHTML).toBe(before);
    expectDurabilityNotice();
  },
);

const refusalCases = [
  ["invalid-input", "Files.Refusal.Invalid", false],
  ["resource-limit", "Files.Refusal.Limit", false],
  ["permission", "Files.Refusal.Permission", false],
  ["conflict", "Files.Refusal.Changed", true],
  ["missing-resource", "Files.Refusal.Unavailable", true],
  ["network", "Files.OperationFailed", false],
  ["io", "Files.OperationFailed", false],
  ["cancellation", null, false],
] as const;

describe.each(Object.keys(mutationCommands) as MutationAction[])("%s typed refusal", (action) => {
  test.each(refusalCases)(
    "%s displays catalogue guidance and retains the action",
    async (category, key, relists) => {
      mocks.listFileWorkspace
        .mockReset()
        .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
        .mockResolvedValue({
          entries: [nativeFile, nativeDestination, nativeLeftover],
          unread: [],
        });
      const command = mutationCommands[action];
      command.mockRejectedValueOnce(commandError(category, "private diagnostic"));
      await realWorkspace();
      await openMutation(action);
      await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
      const dialog = container.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      expect(dialog.querySelector('[role="alert"]')?.textContent ?? "").toBe(
        key ? refusalCopy[key] : "",
      );
      expect(container.textContent).not.toContain("private diagnostic");
      expect(command).toHaveBeenCalledOnce();
      expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(relists ? 2 : 1);
      expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe(
        [entry.name, destination.name, ...(relists ? ["Leftover"] : [])].join(","),
      );
      expect(
        (dialog.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value,
      ).toBe(action === "move" ? undefined : action === "metadata" ? entry.name : "Retained draft");
      expect((dialog.querySelector("select") as HTMLSelectElement | null)?.value).toBe(
        action === "metadata" ? "repertoire" : undefined,
      );
      const checkedDestination =
        action === "move"
          ? (dialog.querySelector('input[type="radio"]:checked') as HTMLInputElement).value
          : undefined;
      expect(checkedDestination).toBe(action === "move" ? fileWorkspaceKey(workspace) : undefined);
      expect(dialogButton(action === "move" ? "Move" : "Confirm").disabled).toBe(false);
    },
  );

  test("name-taken stays correctable without relisting", async () => {
    mutationCommands[action].mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "conflict",
        nameTaken: true,
        message: "private diagnostic",
      }),
    );
    await openMutation(action);
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Name already used");
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
  });
});

test.each(["folder", "move"] as const)(
  "%s holds synchronous admission through delayed refusal reconciliation",
  async (action) => {
    const listing = deferred<unknown[]>();
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockReturnValueOnce(listing.promise.then((entries) => ({ entries, unread: [] })));
    mutationCommands[action].mockRejectedValueOnce(commandError("conflict", "private diagnostic"));
    await realWorkspace();
    await openMutation(action);
    const confirm = dialogButton(action === "move" ? "Move" : "Confirm");
    act(() => {
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).not.toContain(refusalCopy["Files.Refusal.Changed"]);
    await act(async () => listing.resolve([nativeFile, nativeDestination, nativeLeftover]));
    expect(confirm.disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Changed"],
    );
    expect(container.querySelector('[data-testid="entries"]')?.textContent).toContain("Leftover");
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
  },
);

test.each(["conflict", "missing-resource"] as const)(
  "%s relist failure keeps original refusal and refuses retry against unavailable listing",
  async (category) => {
    const listing = deferred<never>();
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [], unread: [] })
      .mockReturnValueOnce(listing.promise);
    mocks.createWorkspaceDirectory.mockRejectedValueOnce(
      commandError(category, "private diagnostic"),
    );
    await realWorkspace();
    await openMutation("folder");
    await act(async () => dialogButton("Confirm").click());
    expect(dialogButton("Confirm").disabled).toBe(true);
    await act(async () => listing.reject(commandError("permission", "private list diagnostic")));
    const key = category === "conflict" ? "Files.Refusal.Changed" : "Files.Refusal.Unavailable";
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(refusalCopy[key]);
    expect(container.textContent).toContain("Files could not be loaded. Please try again.");
    await act(async () => dialogButton("Confirm").click());
    expect(mocks.createWorkspaceDirectory).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(refusalCopy[key]);
    expect((container.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe(
      "Retained draft",
    );
    expect(container.textContent).not.toContain("private list diagnostic");
  },
);

test.each(["file", "folder", "rename", "metadata", "move"] as const)(
  "%s refuses retry when its bound source or creation parent disappears",
  async (action) => {
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockResolvedValue({ entries: [nativeLeftover], unread: [] });
    mutationCommands[action].mockRejectedValueOnce(commandError("conflict", "private diagnostic"));
    await realWorkspace();
    if (action === "file" || action === "folder") click("Select destination folder");
    await openMutation(action);
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Changed"],
    );
    expect(
      (
        container.querySelector(
          '[role="dialog"] input[aria-label="Name"]',
        ) as HTMLInputElement | null
      )?.value,
    ).toBe(action === "move" ? undefined : action === "metadata" ? entry.name : "Retained draft");
    expect(mutationCommands[action].mock.calls[0].slice(0, 2)).toEqual([
      workspace,
      action === "file" || action === "folder" ? destination.handle : entry.handle,
    ]);
  },
);

test("move retains a removed destination and refuses a second write", async () => {
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
    .mockResolvedValue({ entries: [nativeFile], unread: [] });
  mocks.moveWorkspaceEntry.mockRejectedValueOnce(
    commandError("missing-resource", "private diagnostic"),
  );
  await realWorkspace();
  await openMutation("move");
  const radio = [
    ...container.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="radio"]'),
  ].find((input) => input.closest("label")?.textContent === destination.name)!;
  expect(radio.value).toBe(fileWorkspaceKey(destination.handle));
  await act(async () => radio.click());
  await act(async () => radio.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(radio.checked).toBe(true);
  expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
  await act(async () => dialogButton("Move").click());
  await act(async () => dialogButton("Move").click());
  expect(mocks.moveWorkspaceEntry).toHaveBeenCalledExactlyOnceWith(
    workspace,
    entry.handle,
    destination.handle,
  );
  expect(radio.checked).toBe(true);
  expect(radio.closest("label")?.textContent).toBe(destination.name);
  expect(container.querySelectorAll('[role="dialog"] input[type="radio"]:checked')).toHaveLength(1);
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    refusalCopy["Files.Refusal.Unavailable"],
  );
});

test.each(["file", "folder", "rename", "metadata", "move"] as const)(
  "%s stays bound when selection changes before submission",
  async (action) => {
    await openMutation(action);
    act(() => controller.listProps.setSelectedFile(destination as Entry));
    await act(async () => dialogButton(action === "move" ? "Move" : "Confirm").click());
    expect(mutationCommands[action]).toHaveBeenCalledOnce();
    expect(mutationCommands[action].mock.calls[0].slice(0, 2)).toEqual([
      workspace,
      action === "file" || action === "folder" ? workspace : entry.handle,
    ]);
  },
);

test.each(["rename", "metadata"] as const)(
  "%s refuses an unreadable bound source before writing",
  async (action) => {
    await openMutation(action);
    mocks.data = [{ ...entry, readError: "permission" }, destination];
    await rerender();
    await act(async () => dialogButton("Confirm").click());
    expect(mutationCommands[action]).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Unavailable"],
    );
  },
);

test("a refusal drains a preceding listing and keeps the reconciled current files", async () => {
  const old = deferred<unknown[]>();
  mocks.listFileWorkspace
    .mockReset()
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockReturnValueOnce(old.promise.then((entries) => ({ entries, unread: [] })))
    .mockResolvedValueOnce({ entries: [nativeLeftover], unread: [] });
  mocks.createWorkspaceDirectory.mockRejectedValueOnce(
    commandError("conflict", "private diagnostic"),
  );
  const { config } = await realWorkspace();
  let prior!: Promise<unknown>;
  await act(async () => {
    prior = config.mutate(workspaceListingKey(workspace));
  });
  await openMutation("folder");
  await act(async () => dialogButton("Confirm").click());
  expect(mocks.listFileWorkspace.mock.calls[1][1].signal.aborted).toBe(true);
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("Leftover");
  await act(async () => {
    old.resolve([]);
    await prior;
  });
  expect(container.querySelector('[data-testid="entries"]')?.textContent).toBe("Leftover");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    refusalCopy["Files.Refusal.Changed"],
  );
});

test.each(["reject", "resolve", "relist"] as const)(
  "old %s completion cannot change a reopened form or release its pending guard",
  async (outcome) => {
    const old = deferred<void>();
    const next = deferred<void>();
    const listing = deferred<unknown[]>();
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockImplementation(() =>
        outcome === "relist"
          ? listing.promise.then((entries) => ({ entries, unread: [] }))
          : Promise.resolve({ entries: [nativeFile, nativeDestination], unread: [] }),
      );
    mocks.createWorkspaceDirectory
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    await realWorkspace();
    await openMutation("folder");
    await act(async () => dialogButton("Confirm").click());
    if (outcome === "relist")
      await act(async () => old.reject(commandError("conflict", "old diagnostic")));
    click("Close dialog");
    await openMutation("folder");
    await setDialogName("New owner draft");
    if (outcome !== "relist") await act(async () => dialogButton("Confirm").click());
    await act(async () => {
      if (outcome === "reject") old.reject(commandError("permission", "old diagnostic"));
      else if (outcome === "resolve") old.resolve();
      else listing.resolve([nativeFile, nativeDestination]);
    });
    expect((container.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe(
      "New owner draft",
    );
    expect(dialogButton("Confirm").disabled).toBe(outcome !== "relist");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    if (outcome === "relist") await act(async () => dialogButton("Confirm").click());
    await act(async () => next.reject(commandError("permission", "new diagnostic")));
    expect(dialogButton("Confirm").disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Permission"],
    );
  },
);

test.each(["workspace", "provider", "unmount"] as const)(
  "%s replacement retires presentation while the old cache reconciles",
  async (replacement) => {
    const pending = deferred<void>();
    const other = { id: { id: "owner-B" }, kind: "fileWorkspace" } as const;
    mocks.listFileWorkspace.mockReset().mockResolvedValue({ entries: [], unread: [] });
    mocks.createWorkspaceDirectory.mockReturnValueOnce(pending.promise);
    const { cache, render } = await realWorkspace();
    await openMutation("folder");
    await act(async () => dialogButton("Confirm").click());
    const foreign = new Map();
    if (replacement === "workspace") mocks.workspace = other;
    if (replacement === "unmount") await act(async () => root.render(<div>Unmounted</div>));
    else await render(replacement === "provider" ? foreign : cache);
    if (replacement !== "unmount") {
      await openMutation("folder");
      await setDialogName("New workspace draft");
    }
    const count = mocks.listFileWorkspace.mock.calls.length;
    await act(async () => pending.reject(commandError("conflict", "old diagnostic")));
    await vi.waitFor(() => expect(mocks.listFileWorkspace).toHaveBeenCalledTimes(count + 1));
    expect(mocks.listFileWorkspace.mock.calls.at(-1)?.[0]).toEqual(workspace);
    expect(cache.get(unstable_serialize(workspaceListingKey(workspace)))?.data).toBeUndefined();
    expect(
      (container.querySelector('[role="dialog"] input') as HTMLInputElement | null)?.value,
    ).toBe(replacement === "unmount" ? undefined : "New workspace draft");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(
      [...container.querySelectorAll('[role="dialog"] button')]
        .find((button) => button.textContent === "Confirm")
        ?.hasAttribute("disabled"),
    ).toBe(replacement === "unmount" ? undefined : false);
    expect(mocks.createWorkspaceDirectory).toHaveBeenCalledOnce();
  },
);

test.each(["reject", "resolve", "relist"] as const)(
  "old move %s cannot publish into a newer move or release its pending guard",
  async (outcome) => {
    const old = deferred<void>();
    const next = deferred<void>();
    const listing = deferred<unknown[]>();
    mocks.listFileWorkspace
      .mockReset()
      .mockResolvedValueOnce({ entries: [nativeFile, nativeDestination], unread: [] })
      .mockImplementation(() =>
        outcome === "relist"
          ? listing.promise.then((entries) => ({ entries, unread: [] }))
          : Promise.resolve({ entries: [nativeFile, nativeDestination], unread: [] }),
      );
    mocks.moveWorkspaceEntry.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await realWorkspace();
    await openMutation("move");
    await act(async () => dialogButton("Move").click());
    if (outcome === "relist")
      await act(async () => old.reject(commandError("conflict", "old diagnostic")));
    click("Close dialog");
    // Reopen from the original entry while reconciliation has temporarily cleared the listing.
    act(() => controller.listProps.onRequestMove(entry as Entry));
    if (outcome !== "relist") await act(async () => dialogButton("Move").click());
    await act(async () => {
      if (outcome === "reject") old.reject(commandError("permission", "old diagnostic"));
      else if (outcome === "resolve") old.resolve();
      else listing.resolve([nativeFile, nativeDestination]);
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dialogButton("Move").disabled).toBe(outcome !== "relist");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    if (outcome === "relist") await act(async () => dialogButton("Move").click());
    await act(async () => dialogButton("Move").click());
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(2);
    await act(async () => next.reject(commandError("permission", "new diagnostic")));
    expect(dialogButton("Move").disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Permission"],
    );
  },
);

test("a folder parent stays bound across an unrelated selection change", async () => {
  click("Select destination folder");
  await openMutation("folder");
  act(() => controller.listProps.setSelectedFile(entry as Entry));
  await act(async () => dialogButton("Confirm").click());
  expect(mocks.createWorkspaceDirectory).toHaveBeenCalledExactlyOnceWith(
    workspace,
    destination.handle,
    "Retained draft",
  );
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let container: HTMLDivElement;
let root: Root;

function button(name: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === name)!;
}

function click(name: string) {
  act(() => button(name).click());
}

function dialogButton(name: string) {
  return [...container.querySelector('[role="dialog"]')!.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  )!;
}

async function setDialogName(value: string) {
  const input = container.querySelector('[role="dialog"] input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function completeTrash() {
  click("Select sample file");
  click("Trash");
  await act(async () => button("Common.Delete").click());
  expect(mocks.trashWorkspaceEntry).toHaveBeenCalledWith(workspace, entry.handle);
  expect(container.textContent).toContain("Moved sample.pgn to trash.");
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.realSWR = false;
  mocks.workspace = undefined;
  mocks.data = [entry, destination];
  mocks.cardMounts = [];
  mocks.error = undefined;
  mocks.mutate.mockResolvedValue(undefined);
  mocks.mutateTrash.mockResolvedValue(undefined);
  mocks.trashData = { items: [], olderCount: 0, cursor: null };
  mocks.trashError = undefined;
  mocks.listWorkspaceTrash.mockResolvedValue({ items: [], olderCount: 0, cursor: null });
  mocks.emptyWorkspaceTrash.mockResolvedValue(undefined);
  mocks.trashWorkspaceEntry.mockResolvedValue("11111111-1111-4111-8111-111111111111");
  mocks.restoreWorkspaceTrashItem.mockResolvedValue(undefined);
  mocks.deleteWorkspaceTrashItem.mockResolvedValue(undefined);
  mocks.moveWorkspaceEntry.mockResolvedValue(undefined);
  mocks.createWorkspaceFile.mockResolvedValue(undefined);
  mocks.createWorkspaceDirectory.mockResolvedValue(undefined);
  mocks.renameWorkspaceFile.mockResolvedValue(undefined);
  mocks.writeWorkspaceFileMetadata.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<FilesPage />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("native trash view", () => {
  const item = "22222222-2222-4222-8222-222222222222";
  async function showTrash(category: ErrorCategory | null = null) {
    mocks.trashData.items = [
      {
        item,
        name: "older.pgn",
        kind: "file",
        originalFolder: "Archive",
        trashedSeconds: 1700000000,
        category,
      },
    ];
    await act(async () => root.render(<FilesPage />));
  }

  test("native paging forwards the cursor and replaces the current page", async () => {
    const cursor = { seconds: 1700000000, item };
    const row = {
      item,
      name: "older.pgn",
      kind: "file",
      originalFolder: "Archive",
      trashedSeconds: 1700000000,
      category: null,
    };
    mocks.listFileWorkspace.mockResolvedValue({ entries: [], unread: [] });
    mocks.listWorkspaceTrash
      .mockResolvedValueOnce({ items: [row], olderCount: 1, cursor })
      .mockResolvedValue({ items: [{ ...row, name: "oldest.pgn" }], olderCount: 0, cursor: null });
    await realWorkspace();
    await settle();
    expect(container.textContent).toContain("older.pgn");
    act(() =>
      [...container.querySelectorAll("button")]
        .find((node) => node.textContent?.startsWith("Load older items"))!
        .click(),
    );
    await settle();
    expect(mocks.listWorkspaceTrash).toHaveBeenLastCalledWith(workspace, cursor, {
      signal: expect.any(AbortSignal),
    });
    expect(container.textContent).toContain("oldest.pgn");
    expect(container.textContent).not.toContain("older.pgn");
  });

  test.each(["restore", "delete"] as const)(
    "%s addresses an older row by item id and refreshes both listings",
    async (action) => {
      await showTrash();
      expect(container.textContent).toContain("Archive");
      click(action === "restore" ? "Restore" : "Delete permanently");
      await act(async () =>
        dialogButton(action === "restore" ? "Restore" : "Common.Delete").click(),
      );
      expect(
        action === "restore" ? mocks.restoreWorkspaceTrashItem : mocks.deleteWorkspaceTrashItem,
      ).toHaveBeenCalledWith(workspace, item);
      expect(mocks.mutate).toHaveBeenCalledOnce();
      expect(mocks.mutateTrash).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  test.each(["durability", "partial-removal", "permission"] as const)(
    "Empty trash preserves %s error and refresh policy",
    async (category) => {
      await showTrash();
      mocks.emptyWorkspaceTrash.mockRejectedValueOnce(commandError(category, "private diagnostic"));
      click("Empty trash");
      await act(async () => dialogButton("Common.Delete").click());
      expect(mocks.emptyWorkspaceTrash).toHaveBeenCalledWith(workspace);
      expect(container.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
      expect(container.textContent).not.toContain("private diagnostic");
      expect(mocks.mutateTrash).toHaveBeenCalledTimes(category === "permission" ? 0 : 1);
      expect(mocks.mutate).toHaveBeenCalledTimes(category === "permission" ? 0 : 1);
    },
  );

  test("Empty trash confirms, closes and refreshes after success even when relisting fails", async () => {
    await showTrash();
    mocks.mutateTrash.mockRejectedValueOnce(new Error("private listing error"));
    click("Empty trash");
    expect(mocks.emptyWorkspaceTrash).not.toHaveBeenCalled();
    await act(async () => dialogButton("Common.Delete").click());
    expect(mocks.emptyWorkspaceTrash).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutateTrash).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("unreadable rows show their category and disable row actions", async () => {
    await showTrash("permission");
    expect(container.textContent).toContain("Files.ChildUnreadable.Permission");
    expect(button("Restore").disabled).toBe(true);
    expect(button("Delete permanently").disabled).toBe(true);
  });

  test("listing error offers retry and older pages use the native cursor", async () => {
    mocks.trashError = commandError("permission", "private listing diagnostic");
    await showTrash();
    click("Common.Retry");
    await settle();
    expect(mocks.mutateTrash).toHaveBeenCalledOnce();
    mocks.trashError = undefined;
    mocks.trashData.cursor = { seconds: 1700000000, item };
    mocks.trashData.olderCount = 4;
    await act(async () => root.render(<FilesPage />));
    act(() =>
      [...container.querySelectorAll("button")]
        .find((node) => node.textContent?.startsWith("Load older items"))!
        .click(),
    );
    await settle();
    expect(container.textContent).not.toContain("private listing diagnostic");
  });
});

describe("trash confirmations", () => {
  test("duplicate permanent-delete submits invoke native once", async () => {
    await completeTrash();
    mocks.mutate.mockClear();
    let resolve!: () => void;
    mocks.deleteWorkspaceTrashItem.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    click("Delete permanently");
    act(() => {
      button("Common.Delete").click();
      button("Common.Delete").click();
    });
    expect(mocks.deleteWorkspaceTrashItem).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  test("partial permanent-delete rejection clears the banner, relists, and shows specific copy", async () => {
    await completeTrash();
    mocks.mutate.mockClear();
    // Fallback-path coverage: classify() still matches this owned Display literal.
    mocks.deleteWorkspaceTrashItem.mockRejectedValueOnce(
      new Error("Partially removed: 1 entries were deleted before failing: child not found"),
    );
    click("Delete permanently");
    await act(async () => button("Common.Delete").click());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Moved sample.pgn to trash.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Part of the operation was completed, and what is shown may no longer match.",
    );
    expect(container.textContent).not.toContain(durabilityCopy);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("successful permanent-delete is not reported as failed when relisting fails", async () => {
    await completeTrash();
    mocks.mutate.mockClear();
    mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
    click("Delete permanently");
    await act(async () => button("Common.Delete").click());
    expect(mocks.deleteWorkspaceTrashItem).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("The action could not be completed");
    expect(container.textContent).not.toContain("list unavailable");
  });

  test.each([
    ["durability", "Committed but durability uncertain: parent not found"] as const,
    [
      "partial-removal",
      "Partially removed: 2 entries were deleted before failing: I/O failure",
    ] as const,
  ])(
    "partial permanent-delete keeps its %s error when relisting fails",
    async (category, message) => {
      await completeTrash();
      mocks.mutate.mockClear();
      mocks.deleteWorkspaceTrashItem.mockRejectedValueOnce(commandError(category, message));
      mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
      click("Delete permanently");
      await act(async () => button("Common.Delete").click());
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain("Moved sample.pgn to trash.");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        category === "durability"
          ? durabilityCopy
          : "Part of the operation was completed, and what is shown may no longer match.",
      );
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.textContent?.includes(durabilityCopy)).toBe(category === "durability");
      expect(mocks.notify).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("list unavailable");
    },
  );

  test.each([
    ["restore", "Undo", "Restore file", "Restore", "restoreWorkspaceTrashItem"],
    [
      "purge",
      "Delete permanently",
      "Delete permanently",
      "Common.Delete",
      "deleteWorkspaceTrashItem",
    ],
  ])(
    "%s rejection leaves the trashed item recoverable",
    async (_action, trigger, title, confirm, command) => {
      await completeTrash();
      mocks.mutate.mockClear();
      mocks[
        command as "restoreWorkspaceTrashItem" | "deleteWorkspaceTrashItem"
      ].mockRejectedValueOnce(new Error(`${_action} denied`));
      click(trigger);
      await act(async () => button(confirm).click());
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Moved sample.pgn to trash.");
      expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(title);
      expect(container.textContent).toContain(
        "The action could not be completed. Please try again.",
      );
    },
  );

  test("successful restore is not reported as failed when relisting fails", async () => {
    await completeTrash();
    mocks.mutate.mockClear();
    mocks.mutate.mockImplementationOnce(async () => {
      mocks.error = new Error("list unavailable");
      throw mocks.error;
    });
    click("Undo");
    await act(async () => button("Restore").click());

    expect(mocks.restoreWorkspaceTrashItem).toHaveBeenCalledWith(
      workspace,
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("The action could not be completed");
    expect(container.textContent).not.toContain("Moved sample.pgn to trash.");
    expect(container.textContent).toContain("Files could not be loaded. Please try again.");
  });

  test("applied restore keeps its warning when relisting fails", async () => {
    await completeTrash();
    mocks.mutate.mockClear();
    mocks.restoreWorkspaceTrashItem.mockRejectedValueOnce(
      commandError("durability", "Committed but durability uncertain: parent not found"),
    );
    mocks.mutate.mockImplementationOnce(async () => {
      mocks.error = new Error("list unavailable");
      throw mocks.error;
    });
    click("Undo");
    await act(async () => button("Restore").click());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Moved sample.pgn to trash.");
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      durabilityCopy,
    );
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Files could not be loaded. Please try again.");
    expect(container.textContent).not.toContain("The action could not be completed");
    expect(container.textContent).not.toContain("list unavailable");
  });

  test.each([
    ["restore", "Undo", "Restore file", "Restore", "restoreWorkspaceTrashItem"],
    [
      "purge",
      "Delete permanently",
      "Delete permanently",
      "Common.Delete",
      "deleteWorkspaceTrashItem",
    ],
  ])(
    "%s success closes and relists exactly once",
    async (_action, trigger, _title, confirm, command) => {
      await completeTrash();
      mocks.mutate.mockClear();
      click(trigger);
      await act(async () => button(confirm).click());
      expect(
        mocks[command as "restoreWorkspaceTrashItem" | "deleteWorkspaceTrashItem"],
      ).toHaveBeenCalledWith(workspace, "11111111-1111-4111-8111-111111111111");
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.textContent).not.toContain("Moved sample.pgn to trash.");
    },
  );
});

test("collection selection keeps the native opaque handle and only display metadata", async () => {
  const nextWorkspace = { id: { id: "new-workspace-token" }, kind: "fileWorkspace" };
  mocks.issueFileWorkspace.mockResolvedValue({ handle: nextWorkspace, displayName: "Games" });

  click("Change collection");
  await settle();

  expect(mocks.setWorkspace).toHaveBeenCalledWith(nextWorkspace);
  expect(mocks.setWorkspaceDisplayName).toHaveBeenCalledWith("Games");
});

test("cancelled collection selection stays silent", async () => {
  mocks.issueFileWorkspace.mockRejectedValueOnce(new Error("Cancellation"));

  click("Change collection");
  await settle();

  expect(mocks.setWorkspace).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("durability create refreshes, closes and shows one orange notice", async () => {
  mocks.createWorkspaceFile.mockRejectedValueOnce(
    commandError("durability", "Committed but durability uncertain: registry replacement"),
  );
  click("Create file");
  await settle();
  await setDialogName("created");
  await act(async () => dialogButton("Confirm").click());

  expect(mocks.createWorkspaceFile).toHaveBeenCalledWith(
    workspace,
    workspace,
    "created",
    {
      type: "game",
      tags: [],
    },
    { kind: "text", pgn: "*" },
  );
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("registry replacement");
  expect(container.textContent).not.toContain(
    "The file operation could not be completed. Please try again.",
  );
  expectDurabilityNotice();
});

test.each([
  { nameTaken: true, message: "unrelated diagnostic", expected: "Name already used" },
  {
    message: "Conflict: source PGN changed",
    expected: refusalCopy["Files.Refusal.Changed"],
  },
])("create conflict $message keeps its name and shows $expected", async (failure) => {
  mocks.createWorkspaceFile.mockRejectedValueOnce(
    new TauriCommandError({
      tag: "backend-error",
      category: "conflict",
      message: failure.message,
      ...("nameTaken" in failure ? { nameTaken: failure.nameTaken } : {}),
    }),
  );
  click("Create file");
  await settle();
  await setDialogName("created");
  await act(async () => dialogButton("Confirm").click());

  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector("input")?.value).toBe("created");
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(failure.expected);
  expect(container.textContent).not.toContain(
    failure.nameTaken
      ? "The file operation could not be completed. Please try again."
      : "Name already used",
  );
  expect(mocks.createWorkspaceFile).toHaveBeenCalledOnce();
  expect(mocks.mutate).toHaveBeenCalledTimes(failure.nameTaken ? 0 : 2);
});

test("durability drag move refreshes, clears the move and shows one orange notice", async () => {
  mocks.moveWorkspaceEntry.mockRejectedValueOnce(
    commandError("durability", "Committed but durability uncertain: registry replacement"),
  );
  click("Drag to folder");
  await settle();

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(mocks.moveWorkspaceEntry).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expectDurabilityNotice();
  expect(container.textContent).not.toContain(
    "The file operation could not be completed. Please try again.",
  );
});

test("trash and restore durability relist and keep their confirmation with the shared sentence", async () => {
  mocks.trashWorkspaceEntry.mockRejectedValueOnce(
    commandError("durability", "Committed but durability uncertain: registry replacement"),
  );
  click("Select sample file");
  click("Trash");
  await act(async () => button("Common.Delete").click());
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Move to trash",
  );
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    durabilityCopy,
  );
  expect(mocks.mutateTrash).toHaveBeenCalledOnce();
  expect(container.querySelector("output")?.textContent).toBe("No selection");
  expect(container.textContent).toContain("Moved sample.pgn to trash.");
  expect(button("Undo")).toBeUndefined();
  expect(mocks.notify).not.toHaveBeenCalled();
  click("Common.Cancel");

  await completeTrash();
  mocks.mutate.mockClear();
  mocks.restoreWorkspaceTrashItem.mockRejectedValueOnce(
    commandError("durability", "Committed but durability uncertain: registry replacement"),
  );
  click("Undo");
  await act(async () => button("Restore").click());
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Restore file",
  );
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    durabilityCopy,
  );
  expect(container.textContent).not.toContain("registry replacement");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test.each([false, true])(
  "durable trash closes through confirmation, listing failure=%s",
  async (fails) => {
    if (fails) mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
    await completeTrash();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("The action could not be completed");
    expect(container.textContent).not.toContain("list unavailable");
    expect(mocks.notify).not.toHaveBeenCalled();
  },
);

test.each(["trash", "restore", "purge"] as const)(
  "%s durability keeps the confirm open and relists even when listing fails",
  async (action) => {
    if (action === "trash") {
      click("Select sample file");
      click("Trash");
    } else {
      await completeTrash();
      click(action === "restore" ? "Undo" : "Delete permanently");
    }
    const command = {
      trash: mocks.trashWorkspaceEntry,
      restore: mocks.restoreWorkspaceTrashItem,
      purge: mocks.deleteWorkspaceTrashItem,
    }[action];
    command.mockRejectedValueOnce(commandError("durability", "private diagnostic"));
    mocks.mutate.mockClear();
    mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
    await act(async () => dialogButton(action === "restore" ? "Restore" : "Common.Delete").click());
    expect(command).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      durabilityCopy,
    );
    expect(container.textContent).not.toContain("private diagnostic");
    expect(container.textContent).not.toContain("list unavailable");
    expect(mocks.notify).not.toHaveBeenCalled();
  },
);

test("permanent delete durability keeps its confirmation after a successful relist", async () => {
  await completeTrash();
  mocks.mutate.mockClear();
  mocks.deleteWorkspaceTrashItem.mockRejectedValueOnce(
    commandError("durability", "private diagnostic"),
  );
  click("Delete permanently");
  await act(async () => dialogButton("Common.Delete").click());
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    durabilityCopy,
  );
  expect(container.textContent).not.toContain("private diagnostic");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test.each(["trash", "restore"] as const)(
  "operation_and_cleanup_relists_trash_and_restore %s",
  async (action) => {
    if (action === "restore") {
      await completeTrash();
      click("Undo");
    } else {
      click("Select sample file");
      click("Trash");
    }
    const command =
      action === "trash" ? mocks.trashWorkspaceEntry : mocks.restoreWorkspaceTrashItem;
    mocks.mutate.mockClear();
    command.mockRejectedValueOnce(commandError("operation-and-cleanup", "private cleanup failure"));
    mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
    await act(async () => button(action === "trash" ? "Common.Delete" : "Restore").click());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The action could not be completed. Please try again.",
    );
    expect(container.textContent).not.toContain("list unavailable");

    // The handlers preserve the original rejection even when relisting fails.
    const confirmation = (
      controller.dialogs.props.children as Array<
        { props: { title: string; onConfirm: () => Promise<void> } } | null | false
      >
    ).find(
      (child) =>
        child && child.props.title === (action === "trash" ? "Move to trash" : "Restore file"),
    );
    if (!confirmation) throw new Error("Missing confirmation");
    for (const category of ["operation-and-cleanup", "durability"] as const) {
      const cause = commandError(category, "original mutation failure");
      command.mockRejectedValueOnce(cause);
      mocks.mutate.mockClear();
      mocks.mutate.mockRejectedValueOnce(new Error("list unavailable"));
      await act(async () => {
        await expect(confirmation.props.onConfirm()).rejects.toBe(cause);
      });
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
    }
  },
);

test("failed collection selection notifies without changing the workspace", async () => {
  mocks.issueFileWorkspace.mockRejectedValueOnce(new Error("permission denied"));

  click("Change collection");
  await settle();

  expect(mocks.setWorkspace).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
});

test("collection selection prevents duplicate pending requests and re-enables the button", async () => {
  let resolve!: (result: unknown) => void;
  mocks.issueFileWorkspace.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );

  click("Change collection");
  expect(button("Change collection").disabled).toBe(true);
  click("Change collection");
  expect(mocks.issueFileWorkspace).toHaveBeenCalledOnce();

  resolve({ handle: workspace, displayName: "Games" });
  await settle();
  expect(button("Change collection").disabled).toBe(false);
});

test("collection selection can be retried after a rejection", async () => {
  mocks.issueFileWorkspace
    .mockRejectedValueOnce(new Error("permission denied"))
    .mockResolvedValueOnce({ handle: workspace, displayName: "Games" });

  click("Change collection");
  await settle();
  click("Change collection");
  await settle();

  expect(mocks.issueFileWorkspace).toHaveBeenCalledTimes(2);
});

describe("move controller", () => {
  test.each(["Context Move", "Keyboard M"])(
    "%s moves the exact selected handle to the collection root",
    async (trigger) => {
      mocks.mutate.mockClear();
      click(trigger);
      expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        "Move file",
      );
      await act(async () => dialogButton("Move").click());
      expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(1);
      expect(mocks.moveWorkspaceEntry).toHaveBeenCalledWith(workspace, entry.handle, workspace);
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.querySelector("output")?.textContent).toBe("sample.pgn");
    },
  );

  test("native move rejection keeps the dialog error and focused source", async () => {
    mocks.moveWorkspaceEntry.mockRejectedValueOnce(new Error("native move denied"));
    click("Context Move");
    const move = dialogButton("Move");
    act(() => {
      move.focus();
      move.click();
    });
    await act(async () => undefined);
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledWith(workspace, entry.handle, workspace);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Permission"],
    );
    expect(container.querySelector("output")?.textContent).toBe("sample.pgn");
    expect(document.activeElement).toBe(move);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test("drag move shares the guarded controller and relists once", async () => {
    mocks.mutate.mockClear();
    click("Drag to folder");
    await settle();
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledWith(
      workspace,
      entry.handle,
      destination.handle,
    );
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output")?.textContent).toBe("sample.pgn");
  });

  test("duplicate drag submits call native once and preserve focus on rejection", async () => {
    let reject!: (error: Error) => void;
    mocks.moveWorkspaceEntry.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const drag = button("Drag twice");
    act(() => {
      drag.focus();
      drag.click();
    });
    expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("native drag denied")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      refusalCopy["Files.Refusal.Permission"],
    );
    expect(container.querySelector("output")?.textContent).toBe("sample.pgn");
    expect(document.activeElement).toBe(drag);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe("listing failures", () => {
  test.each([
    ["changed", "This collection changed. Choose another."],
    ["missing", "This collection is no longer available. Choose another."],
    ["unusable", "This collection cannot be opened. Choose another."],
    ["permission", "ChessFable is not allowed to read this collection. Choose another."],
    ["too-large", "This collection is too large to list. Choose another."],
  ])("%s renders its sentence and keeps the header recovery", async (rootFailure, sentence) => {
    mocks.error = {
      tag: "backend-error",
      category: "io",
      message: "native diagnostic",
      rootFailure,
    };
    await rerender();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(sentence);
    mocks.issueFileWorkspace.mockResolvedValueOnce({ handle: workspace, displayName: "Games" });
    click("Change collection");
    await settle();
    expect(mocks.issueFileWorkspace).toHaveBeenCalledOnce();
  });
  test.each(["conflict", "missing-resource", "permission", "resource-limit", "io", "plain"])(
    "%s without rootFailure retries",
    async (category) => {
      mocks.error =
        category === "plain"
          ? new Error("list unavailable")
          : { tag: "backend-error", category, message: "root changed" };
      await rerender();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Files could not be loaded. Please try again.",
      );
    },
  );
  test.each([false, true])("cancellation stays silent with cached data=%s", async (cached) => {
    mocks.error = new DOMException("Cancellation", "AbortError");
    if (!cached) mocks.data = undefined;
    await rerender();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Files could not be loaded");
    expect(container.querySelector('[data-testid="tree"]') !== null).toBe(cached);
    expect(container.textContent?.includes("Loading PGN files…")).toBe(!cached);
  });
  test("changed picker refusal notifies the changed sentence and does not mutate", async () => {
    mocks.issueFileWorkspace.mockRejectedValueOnce({
      tag: "backend-error",
      category: "conflict",
      message: "diagnostic",
      rootFailure: "changed",
    });
    click("Change collection");
    await settle();
    expect(mocks.notify).toHaveBeenCalledWith({
      color: "danger",
      title: "Common.Error",
      message: "This collection changed. Choose another.",
    });
    expect(mocks.setWorkspace).not.toHaveBeenCalled();
    expect(mocks.setWorkspaceDisplayName).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  test("picker cancellation releases the guard for another activation", async () => {
    mocks.issueFileWorkspace
      .mockRejectedValueOnce(new Error("Cancellation"))
      .mockResolvedValueOnce({ handle: workspace, displayName: "Games" });
    click("Change collection");
    await settle();
    click("Change collection");
    await settle();
    expect(mocks.issueFileWorkspace).toHaveBeenCalledTimes(2);
  });
});

function tree() {
  return container.querySelector('[data-testid="tree"]')!;
}

function setDialogType(value: string) {
  const select = container.querySelector('[role="dialog"] select') as HTMLSelectElement;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("metadata and rename submissions", () => {
  test.each(["sample", " study", "study ", " "])(
    "untouched listed name %s writes only metadata and preserves tags",
    async (name) => {
      const selected = { ...entry, name, metadata: { type: "game", tags: ["original", "tag"] } };
      mocks.data = [selected, destination];
      await rerender();
      click("Select sample file");
      click("Files.EditMetadata");
      expect((container.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe(
        name,
      );
      expect((container.querySelector('[role="dialog"] select') as HTMLSelectElement).value).toBe(
        "game",
      );
      setDialogType("repertoire");
      await act(async () => dialogButton("Confirm").click());
      expect(mocks.writeWorkspaceFileMetadata).toHaveBeenCalledOnce();
      expect(mocks.writeWorkspaceFileMetadata).toHaveBeenCalledWith(workspace, entry.handle, {
        type: "repertoire",
        tags: ["original", "tag"],
      });
      expect(mocks.renameWorkspaceFile).not.toHaveBeenCalled();
      expect(mocks.mutate).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  test("changed name and type rename with the chosen type and original tags", async () => {
    mocks.data = [{ ...entry, metadata: { type: "game", tags: ["keep"] } }, destination];
    await rerender();
    click("Select sample file");
    click("Files.EditMetadata");
    await setDialogName("changed");
    setDialogType("puzzle");
    await act(async () => dialogButton("Confirm").click());
    expect(mocks.renameWorkspaceFile).toHaveBeenCalledWith(workspace, entry.handle, "changed", {
      type: "puzzle",
      tags: ["keep"],
    });
    expect(mocks.writeWorkspaceFileMetadata).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  test.each(["Rename", "Files.EditMetadata"])(
    "unchanged %s closes without IPC or relist",
    async (trigger) => {
      click("Select sample file");
      click(trigger);
      await act(async () => dialogButton("Confirm").click());
      expect(mocks.renameWorkspaceFile).not.toHaveBeenCalled();
      expect(mocks.writeWorkspaceFileMetadata).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  test("changed Rename stays name-only and sends the current metadata", async () => {
    click("Select sample file");
    click("Rename");
    expect(container.querySelector('[role="dialog"] select')).toBeNull();
    await setDialogName("changed");
    await act(async () => dialogButton("Confirm").click());
    expect(mocks.renameWorkspaceFile).toHaveBeenCalledWith(
      workspace,
      entry.handle,
      "changed",
      entry.metadata,
    );
    expect(mocks.writeWorkspaceFileMetadata).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  test.each(["", " "])("Rename changed to blank %j sends no IPC", async (name) => {
    click("Select sample file");
    click("Rename");
    await setDialogName(name);
    await act(async () => dialogButton("Confirm").click());
    expect(mocks.renameWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.writeWorkspaceFileMetadata).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceDirectory).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test.each([true, false])(
    "metadata rejection applied=%s retains the shared failure contract",
    async (applied) => {
      mocks.writeWorkspaceFileMetadata.mockRejectedValueOnce(
        applied
          ? commandError(
              "durability",
              "Committed but durability uncertain: workspace sidecar replacement",
            )
          : new Error("write denied"),
      );
      click("Select sample file");
      click("Files.EditMetadata");
      setDialogType("repertoire");
      await act(async () => dialogButton("Confirm").click());
      expect(mocks.mutate).toHaveBeenCalledTimes(applied ? 1 : 0);
      expect(container.querySelector('[role="dialog"]') === null).toBe(applied);
      expect(container.textContent?.includes(refusalCopy["Files.Refusal.Permission"])).toBe(
        !applied,
      );
    },
  );
});

function card() {
  return container.querySelector('[data-testid="file-card"]');
}

async function rerender() {
  await act(async () => root.render(<FilesPage />));
}

describe("workspace controls", () => {
  test("search text reaches the tree", async () => {
    const input = container.querySelector('input[aria-label="Common.Search"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "sam");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(tree().getAttribute("data-search")).toBe("sam");
  });

  test("the type filter reaches the tree and clearing it returns to all types", () => {
    const select = container.querySelector(
      'select[aria-label="Files.FileType"]',
    ) as HTMLSelectElement;
    const choose = (value: string) =>
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(tree().getAttribute("data-filter")).toBe("");
    choose("puzzle");
    expect(tree().getAttribute("data-filter")).toBe("puzzle");
    choose("game");
    expect(tree().getAttribute("data-filter")).toBe("game");
    choose("");
    expect(tree().getAttribute("data-filter")).toBe("");
  });

  test("create file and create folder stay reachable", () => {
    click("Create folder");
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Create folder",
    );
  });
});

describe("selection column", () => {
  test("shows a placeholder without a selection", () => {
    expect(card()).toBeNull();
    expect(container.textContent).toContain("No file selected");
  });

  test("a selected file renders its card and actions, and nothing before the tree changes", () => {
    const before = container.innerHTML.slice(0, container.innerHTML.indexOf('data-testid="tree"'));
    click("Select sample file");
    const after = container.innerHTML.slice(0, container.innerHTML.indexOf('data-testid="tree"'));
    expect(after).toBe(before);
    expect(card()?.textContent).toBe("sample.pgn");
    for (const node of [button("Rename"), button("Move"), button("Trash"), card()!]) {
      expect(tree().compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(container.textContent).not.toContain("No file selected");
  });

  test("a selected folder shows its name and entry count", () => {
    click("Select destination folder");
    expect(card()).toBeNull();
    expect(button("Rename")).toBeUndefined();
    expect(container.textContent).toContain("Entries: {{number}}");
  });

  test("a refreshed listing re-derives the selection by handle", async () => {
    click("Select sample file");
    mocks.data = [{ ...entry, name: "renamed.pgn", handle: { ...entry.handle } }, destination];
    await rerender();
    expect(card()?.textContent).toBe("renamed.pgn");
    expect(container.querySelector("output")?.textContent).toBe("renamed.pgn");
    // Same handle key: the card is not remounted.
    expect(mocks.cardMounts).toEqual(["sample.pgn"]);
  });

  test("a different file remounts the card", async () => {
    const other = { ...entry, handle: { id: { id: "other-token" }, kind: "fileWorkspace" } };
    click("Select sample file");
    mocks.data = [other, destination];
    await rerender();
    click("Select sample file");
    expect(mocks.cardMounts).toEqual(["sample.pgn", "sample.pgn"]);
  });

  test("a vanished entry clears the selection", async () => {
    click("Select sample file");
    mocks.data = [destination];
    await rerender();
    expect(card()).toBeNull();
    expect(container.textContent).toContain("No file selected");
  });

  test("a different entry kind with the same native key clears the file selection", async () => {
    click("Select sample file");
    mocks.data = [{ ...destination, handle: entry.handle }, destination];
    await rerender();
    expect(card()).toBeNull();
    expect(container.textContent).toContain("No file selected");
  });

  test("the selection stands while no listing is available", async () => {
    click("Select sample file");
    mocks.data = undefined;
    await rerender();
    expect(card()?.textContent).toBe("sample.pgn");
  });
});
