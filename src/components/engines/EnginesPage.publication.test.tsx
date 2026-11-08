import { decodeEngineOwnerValue } from "@/state/engineOwnerStorage";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n, { initializeI18n } from "@/i18n";
import { Route } from "@/routes/engines";
import { enginesAtom } from "@/state/atoms";
import { decodeCompressedOrJson } from "@/state/store/debouncedStorage";
import { resetEngineOwnerCoordinatorForTests } from "@/state/engineOwnerStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { Engine, LocalEngine } from "@/utils/engines";
import EnginesPage from "./EnginesPage";
import { MissingLocalEngineError, toPlayerConfig } from "@/components/boards/playerConfig";
import { capabilityKey } from "@/utils/pathCapabilities";

const decodeOwnerValue = (raw: string) =>
  decodeEngineOwnerValue(decodeCompressedOrJson(raw))?.value;

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  retire: vi.fn(),
  report: vi.fn(),
  image: vi.fn(),
  config: vi.fn(),
  binary: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.report }));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      fileExists: vi.fn().mockResolvedValue(true),
      verifySignedBytes: vi.fn().mockResolvedValue(undefined),
      getEngineConfig: mocks.config,
      issueEngineBinary: mocks.binary,
      reconcileEngineAttachments: mocks.reconcile,
      retireEngine: mocks.retire,
      issueEngineImage: mocks.image,
    },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
const engine: LocalEngine = {
  type: "local",
  id: "publication",
  legacyAssessment: null,
  name: "Stockfish",
  version: "18",
  filename: "stockfish",
  handle: { id: { id: "same-path" }, kind: "engine" },
  settings: [],
};
const twin: LocalEngine = { ...engine, id: "twin" };
const store = getDefaultStore();
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createRouter>;
let mutate: ReturnType<typeof useSWRConfig>["mutate"];
function QueryOwner() {
  mutate = useSWRConfig().mutate;
  return null;
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetEngineOwnerCoordinatorForTests();
  vi.clearAllMocks();
  mocks.reconcile.mockReset().mockResolvedValue(undefined);
  mocks.retire.mockReset().mockResolvedValue(undefined);
  mocks.config.mockReset().mockResolvedValue({ name: "Stockfish", options: [] });
  await initializeI18n();
  await i18n.changeLanguage("en-US");
  Object.defineProperty(window, "__TAURI_OS_PLUGIN_INTERNALS__", {
    configurable: true,
    value: { platform: "linux" },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__TAURI_OS_PLUGIN_INTERNALS__");
});

async function mount(records: Engine[] = [engine, twin]) {
  expect((await store.set(enginesAtom, records)).saved).toBe(true);
  const route = createRootRoute();
  const child = Route.update({
    id: "/engines",
    path: "/engines",
    getParentRoute: () => route,
  } as never).update({ component: EnginesPage });
  router = createRouter({
    routeTree: route.addChildren([child]),
    history: createMemoryHistory({ initialEntries: ["/engines?selected=0"] }),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      <MantineProvider env="test">
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
          <QueryOwner />
          <RouterProvider router={router} />
        </SWRConfig>
      </MantineProvider>,
    );
  });
}
function button(label: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
  if (!result) throw new Error(`missing button: ${label}`);
  return result!;
}
function input(label: string, scope: ParentNode = host): HTMLInputElement {
  const node = [...scope.querySelectorAll("label")].find(
    (node) => node.textContent?.replace(/\s*\*$/, "") === label,
  );
  if (!node) throw new Error(`missing input label: ${label}`);
  return document.getElementById(node!.htmlFor) as HTMLInputElement;
}
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function refuseStorage() {
  const original = Storage.prototype.setItem;
  return vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === "engines") throw new DOMException("Quota", "QuotaExceededError");
      return original.call(this, key, value);
    });
}

test("default-true check disable stays false through pending save and hydration while refusal restores true", async () => {
  mocks.config.mockResolvedValue({
    name: "Stockfish",
    options: [{ type: "check", value: { name: "Ponder", default: true } }],
  });
  await mount([engine]);
  const check = input("Think on your time");
  expect(check.checked).toBe(true);
  const bytes = localStorage.getItem("engines");
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => check.click());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const pendingChecked = check.checked;
  const pendingBytes = localStorage.getItem("engines");
  await act(async () => release());
  await act(async () => {
    await store.set(enginesAtom, (current) => current);
  });
  expect(pendingChecked).toBe(false);
  expect(pendingBytes).toBe(bytes);
  expect(check.checked).toBe(false);
  expect(store.get(enginesAtom)?.[0].settings).toEqual([
    { type: "string", name: "Ponder", value: "false" },
  ]);
  const { createEngineOwnerStorage, enginesSchema } = await import("@/state/engineOwnerStorage");
  const hydrated = await createEngineOwnerStorage("engines", enginesSchema, []).getItem(
    "engines",
    [],
  );
  await act(async () => {
    await store.set(enginesAtom, hydrated);
  });
  await act(async () => {
    await router.navigate({ to: "/engines", search: {} });
  });
  await act(async () => {
    await router.navigate({ to: "/engines", search: { selected: 0 } });
  });
  expect(input("Think on your time").checked).toBe(false);
  await act(async () => input("Think on your time").click());
  await act(async () => {
    await store.set(enginesAtom, (current) => current);
  });
  expect(input("Think on your time").checked).toBe(true);
  const refusal = refuseStorage();
  await act(async () => input("Think on your time").click());
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
  await act(async () => {
    await store.set(enginesAtom, (current) => current);
  });
  expect(input("Think on your time").checked).toBe(true);
  refusal.mockRestore();
});

test("actual local Add creates one registration and immutable id from repeated submit during delayed persistence", async () => {
  await mount([]);
  mocks.binary.mockResolvedValue(engine.handle);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Add New"]')!.click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => button("Local", dialog).click());
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>("button.mantine-Input-input")!.click(),
  );
  await vi.waitFor(() => expect(input("Name", dialog).value).toBe("Stockfish"));
  mocks.reconcile.mockClear();
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const form = dialog.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const pending = store.get(enginesAtom);
  await act(async () => release());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(pending).toEqual([]);
  expect(store.get(enginesAtom)).toHaveLength(1);
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  const saved = store.get(enginesAtom)![0];
  expect(saved.id).toBeTruthy();
  expect(decodeOwnerValue(localStorage.getItem("engines")!)).toEqual([saved]);
});

test("actual local Add admits one repeated form submission and permits deliberate retry after refusal", async () => {
  await mount([]);
  mocks.binary.mockResolvedValue(engine.handle);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Add New"]')!.click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => button("Local", dialog).click());
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>("button.mantine-Input-input")!.click(),
  );
  await vi.waitFor(() => expect(input("Name", dialog).value).toBe("Stockfish"));
  mocks.reconcile.mockClear();
  let refuse!: (error: Error) => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  const form = dialog.querySelector("form")!;
  const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => {
    submit();
    submit();
  });
  await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
  const addDisabled = button("Add", form).disabled;
  const nameDisabled = input("Name", dialog).disabled;
  const pendingRecords = store.get(enginesAtom);
  await act(async () => {
    refuse(new Error("refused"));
  });
  await vi.waitFor(() => expect(button("Add", form).disabled).toBe(false));
  expect(addDisabled).toBe(true);
  expect(nameDisabled).toBe(true);
  expect(pendingRecords).toEqual([]);
  expect(mocks.reconcile).toHaveBeenCalledOnce();
  expect(store.get(enginesAtom)).toEqual([]);
  await act(async () => {
    submit();
    submit();
  });
  await vi.waitFor(() => expect(store.get(enginesAtom)).toHaveLength(1));
  const saved = store.get(enginesAtom)![0];
  expect(saved.id).toBeTruthy();
  expect(decodeOwnerValue(localStorage.getItem("engines")!)).toEqual([saved]);
  expect(
    mocks.reconcile.mock.calls.filter(([request]) => request.action === "prepare"),
  ).toHaveLength(2);
});

test("successful routed removal persists before pending retirement and prevents player reuse", async () => {
  await mount([engine]);
  mocks.reconcile.mockClear();
  let finish!: () => void;
  let retirementFinished = false;
  mocks.retire.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          retirementFinished = true;
          resolve();
        };
      }),
  );
  expect(store.get(enginesAtom)).toEqual([engine]);
  await act(async () => button("Remove").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  await act(async () => button("Remove", dialog).click());
  await vi.waitFor(() => expect(mocks.retire).toHaveBeenCalledOnce());
  expect(mocks.retire).toHaveBeenCalledWith(engine.id);
  expect(retirementFinished).toBe(false);
  expect(store.get(enginesAtom)).toEqual([]);
  expect(decodeOwnerValue(localStorage.getItem("engines")!)).toEqual([]);
  expect(mocks.reconcile).toHaveBeenNthCalledWith(1, { action: "prepare", retained_ids: [] });
  expect(mocks.reconcile).toHaveBeenNthCalledWith(2, {
    action: "reconcile",
    retained_ids: [],
    abandoned_ids: [],
    startup: false,
  });
  expect(() =>
    toPlayerConfig({ type: "engine", engine, go: { t: "Depth", c: 1 } }, store.get(enginesAtom)),
  ).toThrow(MissingLocalEngineError);
  await act(async () => finish());
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(engine.id);
});

test("current handle configuration rejection is visible, metadata remains usable and recovery clears the error", async () => {
  const failure = {
    tag: "backend-error",
    category: "engine-timeout",
    message: "Engine configuration unavailable",
    diagnostic: "Private native handshake trace",
  };
  mocks.config.mockRejectedValueOnce(failure);
  await mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent ?? "").toContain(failure.message),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("Common.Error"));
  expect(host.textContent).not.toContain(failure.diagnostic);
  await type(input("Name"), "Metadata still usable");
  await vi.waitFor(() => expect(store.get(enginesAtom)?.[0].name).toBe("Metadata still usable"));
  await act(async () => {
    await mutate(["engine-config", capabilityKey(engine.handle)]);
  });
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a new selected handle clears the previous configuration error", async () => {
  mocks.config.mockRejectedValueOnce({
    tag: "backend-error",
    category: "engine-timeout",
    message: "Previous configuration unavailable",
  });
  const other = { ...twin, handle: { ...twin.handle, id: { id: "healthy-selection" } } };
  await mount([engine, other]);
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent ?? "").toContain(
      "Previous configuration unavailable",
    ),
  );
  await act(async () => {
    await router.navigate({ to: "/engines", search: { selected: 1 } });
  });
  await vi.waitFor(() => expect(mocks.config).toHaveBeenCalledWith(other.handle));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(input("Name").value).toBe(other.name);
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a stale configuration rejection cannot follow a new handle selection", async () => {
  let reject!: (error: Error) => void;
  mocks.config.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  const other = { ...twin, handle: { ...twin.handle, id: { id: "different-binary" } } };
  await mount([engine, other]);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  await act(async () => {
    await router.navigate({ to: "/engines", search: { selected: 1 } });
  });
  await vi.waitFor(() => expect(mocks.config).toHaveBeenCalledWith(other.handle));
  await act(async () => reject(new Error("Obsolete configuration failure")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Obsolete configuration failure");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("pending JSON submission disables raw editing and refusal retains its immutable submitted text", async () => {
  await mount();
  await act(async () => button("Edit JSON").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const textarea = dialog.querySelector("textarea")!;
  const submitted = JSON.stringify({ ...engine, name: "Submitted JSON" });
  await type(textarea, submitted);
  let refuse!: (error: Error) => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await act(async () => button("Save", dialog).click());
  await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
  const inputDisabled = textarea.disabled;
  const saveDisabled = button("Save", dialog).disabled;
  const closeDisabled = dialog.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18n.t("Common.Close")}"]`,
  )!.disabled;
  await act(async () => refuse(new Error("JSON refused")));
  await vi.waitFor(() => expect(textarea.disabled).toBe(false));
  expect(inputDisabled).toBe(true);
  expect(saveDisabled).toBe(true);
  expect(closeDisabled).toBe(false);
  expect(textarea.value).toBe(submitted);
  expect(store.get(enginesAtom)).toEqual([engine, twin]);
});

test("an older delayed JSON Save cannot close a reopened editor or discard its new raw draft", async () => {
  await mount();
  await act(async () => button("Edit JSON").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  await type(
    dialog.querySelector("textarea")!,
    JSON.stringify({ ...engine, name: "Older JSON save" }),
  );
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => button("Save", dialog).click());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () =>
    dialog
      .querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("Common.Close")}"]`)!
      .click(),
  );
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await act(async () => button("Edit JSON").click());
  const reopened = document.querySelector('[role="dialog"]')!;
  const draft = JSON.stringify({ ...engine, name: "New reopened draft" });
  await type(reopened.querySelector("textarea")!, draft);
  await act(async () => release());
  await vi.waitFor(() => expect(store.get(enginesAtom)?.[0].name).toBe("Older JSON save"));
  expect(document.querySelector('[role="dialog"]')).toBe(reopened);
  expect(reopened.querySelector("textarea")!.value).toBe(draft);
});

test("routed rapid drafts stay responsive, failed name does not contaminate version, newest edit survives reload", async () => {
  await mount();
  const bytes = localStorage.getItem("engines");
  let reject!: (error: Error) => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  await type(input("Name"), "Refused name");
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  await type(input("Version"), "19");
  expect(input("Name").value).toBe("Refused name");
  expect(input("Version").value).toBe("19");
  expect(store.get(enginesAtom)).toEqual([engine, twin]);
  expect(host.textContent).not.toContain("Refused name");
  expect(localStorage.getItem("engines")).toBe(bytes);
  await act(async () => {
    reject(new Error("refused"));
  });
  await vi.waitFor(() => expect(input("Name").value).toBe("Stockfish"));
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.[0]).toMatchObject({ name: "Stockfish", version: "19" }),
  );
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await type(input("Name"), "Older");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await type(input("Name"), "Newest");
  await act(async () => {
    release();
  });
  await vi.waitFor(() => expect(store.get(enginesAtom)?.[0].name).toBe("Newest"));
  expect(input("Name").value).toBe("Newest");
  expect(decodeOwnerValue(localStorage.getItem("engines")!)).toEqual(store.get(enginesAtom));
  const { createEngineOwnerStorage } = await import("@/state/engineOwnerStorage");
  const { enginesSchema } = await import("@/state/engineOwnerStorage");
  expect(
    await createEngineOwnerStorage("engines", enginesSchema, []).getItem("engines", []),
  ).toEqual(store.get(enginesAtom));
});

test("accepted edits merge upgraded metadata and cannot resurrect a permanently removed target", async () => {
  await mount();
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await type(input("Name"), "First");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const upgrade = store.set(enginesAtom, (current) =>
    current.map((item) =>
      item.id === engine.id
        ? {
            ...item,
            handle: { id: { id: "upgrade" }, kind: "engine" as const },
            downloadLink: "catalog-19",
          }
        : item,
    ),
  );
  await type(input("Version"), "19");
  await act(async () => {
    release();
    await upgrade;
  });
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.[0]).toMatchObject({
      name: "First",
      version: "19",
      handle: { id: { id: "upgrade" } },
      downloadLink: "catalog-19",
    }),
  );
  const removal = store.set(enginesAtom, { removeLocalId: engine.id });
  await type(input("Name"), "Late");
  await act(async () => {
    await removal;
  });
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.some((item) => item.id === engine.id)).toBe(false),
  );
  expect(store.get(enginesAtom)).toEqual([twin]);
});

test("duplicate refusal preserves selection and a saved duplicate selects its immutable identity", async () => {
  await mount();
  const refusal = refuseStorage();
  await act(async () => button("Duplicate").click());
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
  expect(store.get(enginesAtom)).toEqual([engine, twin]);
  expect(router.state.location.search).toMatchObject({ selected: 0 });
  refusal.mockRestore();
  await act(async () => button("Duplicate").click());
  await vi.waitFor(() => expect(store.get(enginesAtom)).toHaveLength(3));
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ selected: 1 }));
  const created = store.get(enginesAtom)![1];
  expect(created.id).not.toBe(engine.id);
  expect(created.id).not.toBe(twin.id);
  expect(created.name).toBe("Stockfish (Copy)");
});

test("duplicate completion after navigation cannot steal selection", async () => {
  await mount();
  let release!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => button("Duplicate").click());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => {
    await router.navigate({ to: "/engines", search: { selected: 1 } });
  });
  await act(async () => {
    release();
  });
  await vi.waitFor(() => expect(store.get(enginesAtom)).toHaveLength(3));
  expect(router.state.location.search).toMatchObject({ selected: 1 });
});

test("local removal remains absent through preparation, storage refusal and pending retirement", async () => {
  await mount();
  const bytes = localStorage.getItem("engines");
  let release!: () => void;
  let retire!: () => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  mocks.retire.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        retire = resolve;
      }),
  );
  const refusal = refuseStorage();
  await act(async () => button("Remove").click());
  await act(async () => button("Remove", document.querySelector('[role="dialog"]')!).click());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(store.get(enginesAtom)).toEqual([twin]);
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(localStorage.getItem("engines")).toBe(bytes);
  await act(async () => {
    release();
  });
  await vi.waitFor(() => expect(retire).toBeTypeOf("function"));
  expect(store.get(enginesAtom)).toEqual([twin]);
  expect(localStorage.getItem("engines")).toBe(bytes);
  expect(mocks.retire).toHaveBeenCalledWith(engine.id);
  refusal.mockRestore();
  await act(async () => {
    retire();
  });
});

test("cloud admission is bounded during delayed save and refused admission permits retry", async () => {
  await mount([]);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Add New"]')!.click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
      .find((node) => node.textContent === "Cloud")!
      .click(),
  );
  const add = [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent === "Add",
  )[1];
  let reject!: (error: Error) => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  await act(async () => {
    add.click();
    add.click();
  });
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(add.disabled).toBe(true);
  expect(store.get(enginesAtom)).toEqual([]);
  await act(async () => {
    reject(new Error("refused"));
  });
  await vi.waitFor(() => expect(add.disabled).toBe(false));
  await act(async () => {
    add.click();
    add.click();
  });
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.filter((item) => item.type === "lichess")).toHaveLength(1),
  );
  expect(add.disabled).toBe(true);
});

test("JSON submission retains its editor on refusal, preserves identity, and closes after its saved receipt", async () => {
  await mount();
  await act(async () => button("Edit JSON").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  await type(
    dialog.querySelector("textarea")!,
    JSON.stringify({ ...engine, id: "submitted-other-id", name: "JSON name" }),
  );
  const refusal = refuseStorage();
  await act(async () => button("Save", dialog).click());
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(store.get(enginesAtom)).toEqual([engine, twin]);
  refusal.mockRestore();
  await act(async () => button("Save", dialog).click());
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.[0]).toMatchObject({
      id: engine.id,
      name: "JSON name",
      legacyAssessment: null,
    }),
  );
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

test.each(["valid", "invalid"] as const)(
  "JSON open owner preserves newer %s raw draft after an older inline receipt and reseeds on reopen",
  async (configuration) => {
    await mount();
    let release!: () => void;
    mocks.reconcile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await type(input("Name"), "Older inline receipt");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(store.get(enginesAtom)?.[0].name).toBe("Stockfish");
    await act(async () => button("Edit JSON").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const textarea = dialog.querySelector("textarea")!;
    const entered = JSON.stringify({
      ...engine,
      name: "Newer JSON draft",
      ...(configuration === "invalid" ? { type: "invalid" } : {}),
    });
    await type(textarea, entered);
    expect(textarea.value).toBe(entered);
    if (configuration === "invalid") {
      await act(async () => button("Save", dialog).click());
    }
    expect(dialog.textContent?.includes("Invalid Configuration")).toBe(configuration === "invalid");
    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(store.get(enginesAtom)?.[0].name).toBe("Older inline receipt"));
    expect(textarea.value).toBe(entered);
    expect(dialog.textContent?.includes("Invalid Configuration")).toBe(configuration === "invalid");
    await act(async () =>
      dialog
        .querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("Common.Close")}"]`)!
        .click(),
    );
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await act(async () => button("Edit JSON").click());
    const reopened = document.querySelector('[role="dialog"]')!;
    expect(JSON.parse(reopened.querySelector("textarea")!.value)).toEqual(
      store.get(enginesAtom)![0],
    );
    expect(reopened.textContent).not.toContain("Invalid Configuration");
  },
);

test("refused inline attachment keeps authoritative image and cleans up its issued draft on unmount", async () => {
  await mount();
  const image = { id: { id: "issued-image" }, kind: "engineImage" };
  mocks.image.mockResolvedValueOnce(image);
  const refusal = refuseStorage();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Select image"]')!.click(),
  );
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
  expect(store.get(enginesAtom)?.[0].imageHandle).toBeUndefined();
  refusal.mockRestore();
  await act(async () => {
    await router.navigate({ to: "/engines", search: {} });
  });
  await vi.waitFor(() =>
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ abandoned_ids: [{ id: "issued-image" }] }),
    ),
  );
});

test("refused defaults are attempted once and Reset settles its options through its own receipt", async () => {
  mocks.config.mockImplementation(async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("defaults refused"));
    return {
      name: "Stockfish",
      options: [{ type: "spin", value: { name: "Threads", default: 1, min: 1, max: 64 } }],
    };
  });
  await mount([engine]);
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mocks.report).toHaveBeenCalledOnce();
  expect(store.get(enginesAtom)?.[0].settings).toEqual([]);
  await type(input("Version"), "19");
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.[0]).toMatchObject({ version: "19", settings: [] }),
  );
  expect(mocks.report).toHaveBeenCalledOnce();
  const refusal = refuseStorage();
  await act(async () => button(i18n.t("Engines.Settings.Reset")).click());
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
  expect(store.get(enginesAtom)?.[0].settings).toEqual([]);
  refusal.mockRestore();
  await act(async () => button(i18n.t("Engines.Settings.Reset")).click());
  await vi.waitFor(() =>
    expect(store.get(enginesAtom)?.[0].settings).toEqual([
      { type: "string", name: "Threads", value: "1" },
    ]),
  );
});
