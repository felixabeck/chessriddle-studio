import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StoreApi } from "zustand";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import type { TreeStoreState } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { saveToDatabase } from "@/utils/tabs";
import SaveToDatabaseModal from "./SaveToDatabaseModal";

vi.mock("@/hooks/useDatabaseList", () => ({ useDatabaseList: vi.fn() }));
vi.mock("@/utils/tabs", () => ({
  useTabActions: () => ({ getTab: vi.fn(), updateTab: vi.fn() }),
  saveToDatabase: vi.fn(),
}));
vi.mock("@/components/common/AppModal", () => ({
  default: ({
    children,
    pending = false,
    onClose,
  }: {
    children: ReactNode;
    pending?: boolean;
    onClose: () => void;
  }) => (
    <div role="dialog" data-pending={pending}>
      {!pending && <button type="button" aria-label="Close dialog" onClick={onClose} />}
      {children}
    </div>
  ),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function renderModal(onClose: () => void = vi.fn()) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <SaveToDatabaseModal
          opened
          onClose={onClose}
          tab={undefined}
          store={{} as StoreApi<TreeStoreState>}
        />
      </MantineProvider>,
    ),
  );
}

const readyTarget: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database" }, kind: "database" },
  filename: "games.db3",
  title: "Ready database",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
  collection: {
    id: "collection",
    name: "Games",
    file: { id: { id: "collection-file" }, kind: "fileWorkspace" },
    database: { id: { id: "database" }, kind: "database" },
    account: null,
    status: "ready",
    generation: "generation",
    omitted: 0,
    retiredDatabase: null,
    fetchSinceMs: null,
  },
};

async function selectReadyTarget(onClose: () => void) {
  const mutate = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useDatabaseList).mockReturnValue({
    data: {
      databases: [readyTarget],
      unread: [],
      root: { id: { id: "root" }, kind: "databaseRoot" },
    },
    error: undefined,
    isLoading: false,
    mutate,
  } as unknown as ReturnType<typeof useDatabaseList>);
  await renderModal(onClose);
  await act(async () => host.querySelector("input")!.click());
  const option = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(option.textContent).toBe(readyTarget.title);
  await act(async () => option.click());
  expect(host.querySelector("input")?.value).toBe(readyTarget.title);
  return mutate;
}

function saveButton() {
  return Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Common.Save",
  )!;
}

function deferredSave() {
  let resolve!: (value: Awaited<ReturnType<typeof saveToDatabase>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof saveToDatabase>>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  vi.mocked(saveToDatabase).mockReturnValue(promise);
  return { resolve };
}

test("pending save prevents dismissal and repeated saves, then completes once and clears pending", async () => {
  const save = deferredSave();
  const onClose = vi.fn();
  const mutate = await selectReadyTarget(onClose);
  const button = saveButton();
  expect(button.disabled).toBe(false);

  await act(async () => {
    button.click();
    button.click();
  });

  expect(saveToDatabase).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ database: readyTarget.file }),
  );
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");
  expect(host.querySelector('[aria-label="Close dialog"]')).toBeNull();
  expect(host.querySelector("input")?.disabled).toBe(true);
  expect(button.hasAttribute("data-loading")).toBe(true);
  expect(button.disabled).toBe(true);
  expect(
    Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "Common.Cancel")
      ?.disabled,
  ).toBe(true);
  await act(async () => button.click());
  expect(saveToDatabase).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();

  await act(async () => save.resolve("saved"));

  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.Database.Saved" });
  expect(mutate).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("false");
  expect(host.querySelector('[aria-label="Close dialog"]')).not.toBeNull();
  expect(host.querySelector("input")?.disabled).toBe(false);
  expect(button.hasAttribute("data-loading")).toBe(false);
  expect(button.disabled).toBe(false);
});

test("unmount during a pending save prevents late close and notifications", async () => {
  const save = deferredSave();
  const onClose = vi.fn();
  const mutate = await selectReadyTarget(onClose);
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");

  await act(async () => root.unmount());
  await act(async () => save.resolve("saved"));

  expect(onClose).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});

test.each([
  ["missing", "This database folder is no longer available. Choose another."],
  ["permission", "ChessRiddle Studio is not allowed to read this database folder. Choose another."],
  ["changed", "This database folder changed. Choose another."],
  ["too-large", "This database folder is too large to list. Choose another."],
] as const)(
  "shows Library recovery guidance for a typed %s listing failure",
  async (rootFailure, message) => {
    vi.mocked(useDatabaseList).mockReturnValue({
      error: { tag: "backend-error", category: "io", message: "private diagnostic", rootFailure },
      isLoading: false,
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDatabaseList>);
    await renderModal();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(host.textContent).not.toContain("private diagnostic");
    expect(host.querySelector("input")?.disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  },
);
