import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Engine, LocalEngine } from "@/utils/engines";

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  navigate: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  retireEngine: vi.fn(),
  getEngineConfig: vi.fn(),
  issueEngineImage: vi.fn(),
  issueEngineResource: vi.fn(),
  reconcileEngineAttachments: vi.fn(),
  confirmRemoval: vi.fn<() => Promise<void>>(),
  selected: 0,
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    fileExists: mocks.fileExists,
    getEngineConfig: mocks.getEngineConfig,
    retireEngine: mocks.retireEngine,
    issueEngineImage: mocks.issueEngineImage,
    issueEngineResource: mocks.issueEngineResource,
    reconcileEngineAttachments: mocks.reconcileEngineAttachments,
  },
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
  runUnlessCancelled: async (title: string, action: () => Promise<unknown>) => {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof Error && error.message === "Cancellation")) {
        mocks.notifyUnlessCancelled(title, error);
      }
      return undefined;
    }
  },
}));
import EnginesPage, { EngineName } from "./EnginesPage";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => false }));
vi.mock("@/routes/engines", () => ({
  Route: { useSearch: () => ({ selected: mocks.selected }) },
}));
vi.mock("react-i18next", async () => {
  const { default: catalogue } = await import("../../translation/en-US.json");
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string; count?: number }) =>
        options?.defaultValue ??
        { "Common.Error": "Error", "Engines.FileMissing": "(file missing)" }[key] ??
        (key.startsWith("Engines.Options.") || key === "Engines.Settings.ExpertSettings"
          ? (catalogue.translation as Record<string, string>)[
              options?.count === undefined ? key : `${key}_${options.count === 1 ? "one" : "other"}`
            ]?.replace("{{count}}", String(options?.count))
          : undefined) ??
        key,
    }),
  };
});
vi.mock("@mantine/core", () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Checkbox: ({
    label,
    description,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    description?: React.ReactNode;
  }) => (
    <label>
      <span>{label}</span>
      <input type="checkbox" aria-label={label} {...props} />
      {description}
    </label>
  ),
  Collapse: ({
    children,
    in: opened,
    id,
  }: {
    children: React.ReactNode;
    in: boolean;
    id: string;
  }) => (opened ? <div id={id}>{children}</div> : null),
  Divider: () => <hr />,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: Object.assign(() => <input />, {
    Wrapper: ({
      children,
      label,
      description,
    }: {
      children: React.ReactNode;
      label: string;
      description?: React.ReactNode;
    }) => (
      <div data-option-label={label}>
        {label}
        {description}
        {children}
      </div>
    ),
  }),
  JsonInput: () => <textarea />,
  NumberInput: ({
    label,
    description,
    value,
    onChange,
    min,
    max,
  }: {
    label: string;
    description?: React.ReactNode;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
  }) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      {description}
    </label>
  ),
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: ({ label }: { label: string }) => <select aria-label={label} />,
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Space: () => null,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children, c }: { children: React.ReactNode; c?: string }) => (
    <span data-color={c}>{children}</span>
  ),
  TextInput: ({
    label,
    description,
    value,
    readOnly,
    onChange,
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    description?: React.ReactNode;
  }) => (
    <label>
      <span>{label}</span>
      <input aria-label={label} value={value} readOnly={readOnly} onChange={onChange} />
      {description}
    </label>
  ),
  ThemeIcon: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  UnstyledButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
  Cloud: () => <svg aria-label="cloud" />,
  Copy: () => null,
  Brain: () => <svg aria-label="cpu" />,
  Folder: () => null,
  ImagePlus: () => null,
  Plus: () => null,
  Search: () => null,
}));
vi.mock("../common/LocalImage", () => ({ default: () => <img alt="engine" /> }));
vi.mock("../common/ConfirmModal", () => ({
  default: ({
    opened,
    onConfirm,
    onClose,
  }: {
    opened: boolean;
    onConfirm: () => Promise<void>;
    onClose: () => void;
  }) => {
    mocks.confirmRemoval.mockImplementation(onConfirm);
    return opened ? (
      <button
        type="button"
        data-testid="confirm-remove"
        onClick={() => {
          void mocks.confirmRemoval().then(onClose);
        }}
      >
        confirm
      </button>
    ) : null;
  },
}));
vi.mock("../common/AppModal", () => ({ default: () => null }));
vi.mock("../common/GenericCard", () => ({ default: () => null }));
vi.mock("../common/GoModeInput", () => ({ default: () => null }));
vi.mock("../common/OpenFolderButton", () => ({ default: () => null }));
vi.mock("../panels/analysis/LinesSlider", () => ({ default: () => null }));
vi.mock("./AddEngine", () => ({ default: () => null }));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick} />
  ),
}));

let atomEngines: Engine[] = [];
type TestUpdate = ((prev: Engine[]) => Engine[] | Promise<Engine[]>) | { removeLocalId: string };
const setAtomEngines = vi.fn(async (update: TestUpdate) => {
  await publishEngines(update);
  return { operationId: "save", key: "engines", saved: true, synchronized: true };
});
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [atomEngines, setAtomEngines],
  useStore: () => ({ get: () => atomEngines }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function makeEngine(handleId: string): LocalEngine {
  return {
    type: "local",
    id: "engine-id",
    name: "Stockfish",
    version: "17",
    handle: { id: { id: handleId }, kind: "engine" },
    filename: "stockfish",
    settings: [
      { type: "string", name: "MultiPV", value: "1" },
      { type: "string", name: "Threads", value: "1" },
      { type: "string", name: "Hash", value: "16" },
    ],
  };
}

let host: HTMLDivElement;
let root: Root;
let settingsMounted = false;

function renderSettingsPage() {
  settingsMounted = true;
  root.render(
    <SWRConfig value={{ shouldRetryOnError: false }}>
      <EnginesPage />
    </SWRConfig>,
  );
}

async function publishEngines(update: TestUpdate) {
  atomEngines =
    typeof update === "function"
      ? await update(atomEngines)
      : atomEngines.filter(
          (engine) => engine.type !== "local" || engine.id !== update.removeLocalId,
        );
  if (settingsMounted) {
    act(() => renderSettingsPage());
  }
}

async function unmount() {
  await act(async () => {
    settingsMounted = false;
    root.unmount();
  });
}

async function render(engine: Engine) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ shouldRetryOnError: false }}>
        <EngineName engine={engine} />
      </SWRConfig>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSettings() {
  await act(async () => {
    renderSettingsPage();
  });
  await vi.waitFor(() => expect(mocks.getEngineConfig).toHaveBeenCalled());
}

function resource(id: string, kind: "file" | "directory") {
  return { id: { id }, kind, displayName: id } as const;
}

function resourceButton(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
}

async function expandExpert() {
  await act(async () => {
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(toggle).not.toBeNull();
    toggle!.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retireEngine.mockReset().mockResolvedValue(undefined);
  mocks.reconcileEngineAttachments.mockResolvedValue(undefined);
  mocks.issueEngineResource.mockReset();
  mocks.getEngineConfig.mockResolvedValue({
    name: "Stockfish",
    options: [
      { type: "string", value: { name: "SyzygyPath", default: null } },
      { type: "string", value: { name: "EvalFile", default: null } },
    ],
  });
  mocks.selected = 0;
  settingsMounted = false;
  setAtomEngines.mockImplementation(async (update) => {
    await publishEngines(update);
    return { operationId: "save", key: "engines", saved: true, synchronized: true };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await unmount();
  host.remove();
});

describe("EngineName binary inspection state", () => {
  test("renders no status when the engine file is present", async () => {
    const engine = makeEngine("engine-capability-present");
    mocks.fileExists.mockResolvedValue(true);
    await render(engine);

    expect(mocks.fileExists).toHaveBeenCalledWith(engine.handle.id);
    expect(host.textContent).toContain("Stockfish");
    expect(host.textContent).not.toContain("(file missing)");
    expect(host.textContent).not.toContain("(Error)");
    expect(host.querySelector('[data-color="danger"]')).toBeNull();
  });

  test("renders the existing missing-file copy when the engine file is absent", async () => {
    const engine = makeEngine("engine-capability-missing");
    mocks.fileExists.mockResolvedValue(false);
    await render(engine);

    expect(mocks.fileExists).toHaveBeenCalledWith(engine.handle.id);
    expect(host.textContent).toContain("Stockfish (file missing)");
    expect(host.querySelector('[data-color="danger"]')).not.toBeNull();
  });

  test("renders Error without claiming the file is missing when inspection rejects", async () => {
    const engine = makeEngine("engine-capability-denied");
    mocks.fileExists.mockRejectedValue(new Error("denied"));
    await render(engine);

    expect(mocks.fileExists).toHaveBeenCalledWith(engine.handle.id);
    expect(mocks.fileExists).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Stockfish (Error)");
    expect(host.textContent).not.toContain("(file missing)");
    expect(host.querySelector('[data-color="danger"]')).not.toBeNull();
  });
});

test.each([false, true])(
  "settings defaults settle without Hash support (advertised settings already stored: %s)",
  async (alreadyStored) => {
    const engine = makeEngine(`engine-defaults-without-hash-${alreadyStored}`);
    engine.settings = alreadyStored
      ? [
          { type: "string", name: "Threads", value: "4" },
          { type: "string", name: "MultiPV", value: "3" },
        ]
      : [];
    atomEngines = [engine];
    mocks.getEngineConfig.mockResolvedValue({
      name: "Stockfish",
      options: [
        { type: "spin", value: { name: "Threads", default: 1, min: 1, max: 32 } },
        { type: "spin", value: { name: "MultiPV", default: 1, min: 1, max: 256 } },
      ],
    });

    await renderSettings();
    // Publish the mock atom's saved engine back into the effect on subsequent renders.
    for (let publication = 0; publication < 3; publication++) {
      await renderSettings();
    }

    expect(atomEngines[0].settings).toEqual(
      alreadyStored
        ? engine.settings
        : [
            { type: "string", name: "Threads", value: "1" },
            { type: "string", name: "MultiPV", value: "1" },
          ],
    );
    expect(setAtomEngines).toHaveBeenCalledTimes(alreadyStored ? 0 : 1);
  },
);

test("directory resource picker stores a real path option", async () => {
  const engine = makeEngine("engine-resource-directory");
  const selected = resource("tables", "directory");
  atomEngines = [engine];
  mocks.issueEngineResource.mockResolvedValue(selected);
  await renderSettings();
  await expandExpert();

  await act(async () => {
    resourceButton("Common.Open")?.click();
    await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledOnce());
  });

  expect(mocks.issueEngineResource).toHaveBeenCalledWith(true);
  expect(atomEngines[0].settings).toEqual(
    expect.arrayContaining([{ type: "resource", name: "SyzygyPath", resources: [selected] }]),
  );
});

test("file resource picker stores a replacement resource", async () => {
  const engine = makeEngine("engine-resource-file");
  const first = resource("eval-a", "file");
  const replacement = resource("eval-b", "file");
  atomEngines = [engine];
  mocks.issueEngineResource.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
  await renderSettings();
  await expandExpert();

  await act(async () => {
    resourceButton("Evaluation network")?.click();
    await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledOnce());
  });
  await act(async () => {
    renderSettingsPage();
    await Promise.resolve();
  });
  await act(async () => {
    resourceButton("Evaluation network")?.click();
    await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledTimes(2));
  });

  expect(mocks.issueEngineResource).toHaveBeenNthCalledWith(1, false);
  expect(mocks.issueEngineResource).toHaveBeenNthCalledWith(2, false);
  expect(atomEngines[0].settings).toEqual(
    expect.arrayContaining([{ type: "resource", name: "EvalFile", resources: [replacement] }]),
  );
});

test("path resource picker appends multiple directory handles", async () => {
  const engine = makeEngine("engine-resource-append");
  const first = resource("tables-a", "directory");
  const second = resource("tables-b", "directory");
  atomEngines = [engine];
  mocks.issueEngineResource.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await renderSettings();
  await expandExpert();

  await act(async () => {
    resourceButton("Common.Open")?.click();
    await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledOnce());
  });
  await act(async () => {
    renderSettingsPage();
    await Promise.resolve();
  });
  await act(async () => {
    resourceButton("Common.Open")?.click();
    await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledTimes(2));
  });

  expect(mocks.issueEngineResource).toHaveBeenNthCalledWith(1, true);
  expect(mocks.issueEngineResource).toHaveBeenNthCalledWith(2, true);
  expect(atomEngines[0].settings).toEqual(
    expect.arrayContaining([{ type: "resource", name: "SyzygyPath", resources: [first, second] }]),
  );
});

test("resource picker errors and cancellation do not adopt handles", async () => {
  const engine = makeEngine("engine-resource-errors");
  atomEngines = [engine];
  mocks.issueEngineResource.mockRejectedValueOnce(new Error("permission denied"));
  await renderSettings();
  await expandExpert();

  await act(async () => {
    resourceButton("Common.Open")?.click();
    await vi.waitFor(() => expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce());
  });
  expect(atomEngines[0].settings).toEqual(
    expect.arrayContaining([
      { type: "string", name: "MultiPV", value: "1" },
      { type: "string", name: "Threads", value: "1" },
      { type: "string", name: "Hash", value: "16" },
    ]),
  );

  mocks.notifyUnlessCancelled.mockReset();
  mocks.issueEngineResource.mockRejectedValueOnce(new Error("Cancellation"));
  await act(async () => {
    resourceButton("Common.Open")?.click();
    await Promise.resolve();
  });
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(atomEngines[0].settings).toEqual(
    expect.arrayContaining([
      { type: "string", name: "MultiPV", value: "1" },
      { type: "string", name: "Threads", value: "1" },
      { type: "string", name: "Hash", value: "16" },
    ]),
  );
});

test("stale directory resource picker result is abandoned after unmount", async () => {
  let resolveResource!: (value: ReturnType<typeof resource>) => void;
  atomEngines = [makeEngine("engine-resource-stale")];
  mocks.issueEngineResource.mockReturnValue(
    new Promise((resolve) => {
      resolveResource = resolve;
    }),
  );
  await renderSettings();
  await expandExpert();
  resourceButton("Common.Open")?.click();
  await vi.waitFor(() => expect(mocks.issueEngineResource).toHaveBeenCalledOnce());

  await unmount();
  await act(async () => {
    resolveResource(resource("late-directory", "directory"));
    await vi.waitFor(() =>
      expect(mocks.reconcileEngineAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ abandoned_ids: [{ id: "late-directory" }] }),
      ),
    );
  });
  expect(setAtomEngines).not.toHaveBeenCalled();
});

test("local removal retires by id and drops persisted state even when retirement fails", async () => {
  const engine = makeEngine("engine-capability-remove");
  const failure = new Error("retirement failed");
  atomEngines = [engine];
  mocks.retireEngine.mockRejectedValue(failure);

  await act(async () => renderSettingsPage());
  await act(async () => resourceButton("Common.Remove")!.click());
  await act(async () => {
    (host.querySelector('[data-testid="confirm-remove"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.retireEngine).toHaveBeenCalledWith("engine-id");
  expect(atomEngines).toEqual([]);
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Error", failure);
});

test("local removal publishes the drop and finishes the save before retiring", async () => {
  const engine = makeEngine("engine-removal-order");
  atomEngines = [engine];
  await renderSettings();
  let finishSave!: () => void;
  let saveResolved = false;
  setAtomEngines.mockImplementationOnce(async (update) => {
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/engines",
      search: { selected: undefined },
    });
    await publishEngines(update);
    await new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    saveResolved = true;
    return { operationId: "save", key: "engines", saved: true, synchronized: true };
  });
  mocks.retireEngine.mockImplementation(async (id) => {
    expect(id).toBe(engine.id);
    expect(atomEngines.some((known) => known.id === id)).toBe(false);
    expect(saveResolved).toBe(true);
  });

  await act(async () => resourceButton("Common.Remove")!.click());
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-remove"]')!.click();
  });
  expect(atomEngines).toEqual([]);
  expect(mocks.retireEngine).not.toHaveBeenCalled();
  await act(async () => {
    finishSave();
    await expect(mocks.confirmRemoval.mock.results[0].value).resolves.toBeUndefined();
  });
  expect(mocks.retireEngine).toHaveBeenCalledExactlyOnceWith(engine.id);
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="confirm-remove"]')).toBeNull();
});

test.each(["unsaved receipt", "unsynchronized receipt"])(
  "local removal still retires after an %s without rejecting",
  async (exit) => {
    const engine = makeEngine(`engine-removal-${exit}`);
    atomEngines = [engine];
    await renderSettings();
    setAtomEngines.mockImplementationOnce(async (update) => {
      await publishEngines(update);
      return {
        operationId: "save",
        key: "engines",
        saved: exit === "unsynchronized receipt",
        synchronized: false,
      };
    });
    await act(async () => resourceButton("Common.Remove")!.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="confirm-remove"]')!.click();
      await expect(mocks.confirmRemoval.mock.results[0].value).resolves.toBeUndefined();
    });

    expect(mocks.retireEngine).toHaveBeenCalledExactlyOnceWith(engine.id);
    expect(atomEngines).toEqual([]);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="confirm-remove"]')).toBeNull();
  },
);

test.each(["rejected setter", "throwing setter"])(
  "local removal still retires after an %s without rejecting",
  async (exit) => {
    const engine = makeEngine(`engine-removal-${exit}`);
    const failure = new Error("save failed");
    atomEngines = [engine];
    await renderSettings();
    if (exit === "rejected setter") {
      setAtomEngines.mockRejectedValueOnce(failure);
    } else {
      setAtomEngines.mockImplementationOnce(() => {
        throw failure;
      });
    }
    await act(async () => resourceButton("Common.Remove")!.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="confirm-remove"]')!.click();
      await expect(mocks.confirmRemoval.mock.results[0].value).resolves.toBeUndefined();
    });

    expect(mocks.retireEngine).toHaveBeenCalledExactlyOnceWith(engine.id);
    expect(atomEngines).toEqual([engine]);
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Error", failure);
    expect(host.querySelector('[data-testid="confirm-remove"]')).toBeNull();
  },
);

test("a shifted local engine gets fresh settings with no active removal confirmation", async () => {
  const first = makeEngine("engine-removal-first");
  // Equal names and binary handles must still have independent application identities.
  const second = { ...first, id: "second-engine-id" };
  atomEngines = [first, second];
  let finishRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    finishRetirement = resolve;
  });
  mocks.retireEngine.mockReturnValue(retirement);
  await renderSettings();
  await act(async () => resourceButton("Common.Remove")!.click());
  expect(host.querySelector('[data-testid="confirm-remove"]')).not.toBeNull();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-remove"]')!.click();
    await vi.waitFor(() => expect(mocks.retireEngine).toHaveBeenCalledOnce());
  });

  // Navigation is still pending: the route continues selecting index zero after publication.
  expect(mocks.selected).toBe(0);
  expect(resourceButton("Common.Remove")).toBeDefined();
  expect(host.querySelector('[data-testid="confirm-remove"]')).toBeNull();
  expect(atomEngines).toEqual([second]);
  expect(setAtomEngines).toHaveBeenCalledOnce();
  await act(async () => finishRetirement());
  expect(host.querySelector('[data-testid="confirm-remove"]')).toBeNull();
  expect(atomEngines).toEqual([second]);
  expect(mocks.retireEngine).toHaveBeenCalledExactlyOnceWith(first.id);
});

test("details picker abandons a result that resolves after unmount without persisting it", async () => {
  let resolveImage!: (value: { id: { id: string }; kind: "engineImage" }) => void;
  atomEngines = [makeEngine("engine-capability")];
  mocks.issueEngineImage.mockReturnValue(new Promise((resolve) => (resolveImage = resolve)));
  mocks.fileExists.mockResolvedValue(true);

  await act(async () => renderSettingsPage());
  host
    .querySelector<HTMLButtonElement>('button[aria-label="Engines.Settings.SelectImage"]')
    ?.click();
  await unmount();
  await act(async () => {
    resolveImage({ id: { id: "late-details-image" }, kind: "engineImage" });
    await vi.waitFor(() => expect(mocks.reconcileEngineAttachments).toHaveBeenCalledOnce());
  });

  expect(setAtomEngines).not.toHaveBeenCalled();
  expect(mocks.reconcileEngineAttachments).toHaveBeenCalledWith(
    expect.objectContaining({ abandoned_ids: [{ id: "late-details-image" }] }),
  );
});

test("queued details save rechecks closure after a prior update deletes its target", async () => {
  let releaseDelete!: () => void;
  let queue = Promise.resolve();
  atomEngines = [makeEngine("engine-capability")];
  mocks.issueEngineImage.mockResolvedValue({
    id: { id: "queued-details-image" },
    kind: "engineImage",
  });
  mocks.fileExists.mockResolvedValue(true);
  setAtomEngines.mockImplementation((update) => {
    const run = queue.then(async () => {
      await publishEngines(update);
      return { operationId: "save", key: "engines", saved: true, synchronized: true };
    });
    queue = run.then(() => undefined);
    return run;
  });

  const deletion = setAtomEngines(async () => {
    await new Promise<void>((resolve) => (releaseDelete = resolve));
    return [];
  });
  await act(async () => renderSettingsPage());
  host
    .querySelector<HTMLButtonElement>('button[aria-label="Engines.Settings.SelectImage"]')
    ?.click();
  await vi.waitFor(() => expect(mocks.issueEngineImage).toHaveBeenCalledOnce());
  await unmount();
  await vi.waitFor(() => expect(releaseDelete).toBeTypeOf("function"));
  releaseDelete();
  await deletion;
  await vi.waitFor(() =>
    expect(mocks.reconcileEngineAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ abandoned_ids: [{ id: "queued-details-image" }] }),
    ),
  );

  expect(atomEngines).toEqual([]);
});

test("changing the selected engine closes the former immutable-owner draft", async () => {
  let resolveImage!: (value: { id: { id: string }; kind: "engineImage" }) => void;
  atomEngines = [
    makeEngine("first-binary"),
    { ...makeEngine("second-binary"), id: "second-engine", name: "Second" },
  ];
  mocks.issueEngineImage.mockReturnValue(new Promise((resolve) => (resolveImage = resolve)));
  mocks.fileExists.mockResolvedValue(true);
  await act(async () => renderSettingsPage());
  host
    .querySelector<HTMLButtonElement>('button[aria-label="Engines.Settings.SelectImage"]')
    ?.click();
  await vi.waitFor(() => expect(mocks.issueEngineImage).toHaveBeenCalledOnce());

  mocks.selected = 1;
  await act(async () => renderSettingsPage());
  await act(async () => {
    resolveImage({ id: { id: "former-owner-image" }, kind: "engineImage" });
    await vi.waitFor(() =>
      expect(mocks.reconcileEngineAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ abandoned_ids: [{ id: "former-owner-image" }] }),
      ),
    );
  });
  expect(setAtomEngines).not.toHaveBeenCalled();
});

function strengthConfig(defaultLimit: boolean, withLimit = true) {
  return {
    name: "Stockfish",
    options: [
      { type: "spin", value: { name: "Threads", default: 1, min: 1, max: 32 } },
      { type: "spin", value: { name: "Hash", default: 16, min: 1, max: 1024 } },
      { type: "spin", value: { name: "MultiPV", default: 1, min: 1, max: 256 } },
      { type: "check", value: { name: "uci_showwdl", default: false } },
      { type: "spin", value: { name: "Unknown Option", default: 7, min: 0, max: 10 } },
      { type: "check", value: { name: "UCI_Chess960", default: false } },
      { type: "spin", value: { name: "uci_elo", default: 1500, min: 1000, max: 3000 } },
      ...(withLimit
        ? [{ type: "check", value: { name: "uci_limitstrength", default: defaultLimit } }]
        : []),
      { type: "button", value: { name: "Clear Hash" } },
    ],
  };
}

function optionInput(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

test("essential and unknown settings stay visible, experts toggle and button options stay omitted", async () => {
  atomEngines = [makeEngine("engine-sections")];
  mocks.getEngineConfig.mockResolvedValue(strengthConfig(false));
  await renderSettings();
  for (const label of [
    "CPU threads",
    "Memory (MB)",
    "Number of lines",
    "Show win/draw/loss chances",
    "Unknown Option",
  ]) {
    expect(optionInput(label)).not.toBeNull();
  }
  expect(host.textContent).toContain(
    "How many processor cores the engine uses. More cores make analysis faster.",
  );
  expect(host.textContent).toContain("Threads");
  expect(optionInput("Chess960")).toBeNull();
  expect(optionInput("Limit strength to an Elo rating")).toBeNull();
  expect(host.textContent).not.toContain("Clear Hash");
  await expandExpert();
  expect(optionInput("Chess960")?.disabled).toBe(true);
  expect(optionInput("Limit strength to an Elo rating")).not.toBeNull();
  expect(optionInput("Target Elo")).toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
  expect(toggle.textContent).toBe("Expert settings (2)");
  await act(async () => toggle.click());
  expect(optionInput("Chess960")).toBeNull();
  expect(optionInput("Unknown Option")).not.toBeNull();
});

test.each([false, true])(
  "target Elo follows the current limit and preserves its saved value (initial: %s)",
  async (initial) => {
    const engine = makeEngine(`engine-strength-${initial}`);
    engine.settings!.push(
      { type: "string", name: "uci_elo", value: "1725" },
      { type: "string", name: "uci_limitstrength", value: String(initial) },
    );
    atomEngines = [engine];
    // Stored settings take precedence over the opposite reported default.
    mocks.getEngineConfig.mockResolvedValue(strengthConfig(!initial));
    await renderSettings();
    await expandExpert();
    const eloSetting = { type: "string", name: "uci_elo", value: "1725" };
    expect(optionInput("Target Elo")?.value ?? null).toBe(initial ? "1725" : null);
    for (const checked of [!initial, initial]) {
      await act(async () => {
        optionInput("Limit strength to an Elo rating")!.click();
        await Promise.resolve();
      });
      expect(optionInput("Target Elo")?.value ?? null).toBe(checked ? "1725" : null);
      expect(atomEngines[0].settings).toContainEqual(eloSetting);
    }
  },
);

test.each([false, true])("unstored strength limit uses its default (%s)", async (defaultLimit) => {
  atomEngines = [makeEngine(`engine-strength-default-${defaultLimit}`)];
  mocks.getEngineConfig.mockResolvedValue(strengthConfig(defaultLimit));
  await renderSettings();
  await expandExpert();
  expect(optionInput("Limit strength to an Elo rating")?.checked).toBe(defaultLimit);
  expect(optionInput("Target Elo")?.value ?? null).toBe(defaultLimit ? "1500" : null);
  expect(setAtomEngines).not.toHaveBeenCalled();
});

test("target Elo stays available if the engine has no strength limit option", async () => {
  atomEngines = [makeEngine("engine-no-strength-limit")];
  mocks.getEngineConfig.mockResolvedValue(strengthConfig(false, false));
  await renderSettings();
  await expandExpert();
  expect(optionInput("Target Elo")?.value).toBe("1500");
  expect(setAtomEngines).not.toHaveBeenCalled();
});

test("no expert toggle appears for an engine with only essential or unknown options", async () => {
  atomEngines = [makeEngine("engine-essential-only")];
  mocks.getEngineConfig.mockResolvedValue({
    name: "Other engine",
    options: strengthConfig(false).options.slice(0, 5),
  });
  await renderSettings();
  expect(host.querySelector("button[aria-expanded]")).toBeNull();
  expect(optionInput("Unknown Option")).not.toBeNull();
});
