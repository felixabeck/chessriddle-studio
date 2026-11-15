import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/state/workspaceTypes";
import type { BlockingTab, QuitSaveOutcome } from "@/state/quitGate";
import QuitConfirmModal from "./QuitConfirmModal";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; message?: string; defaultValue?: string }) =>
      key === "Tab.NewTab"
        ? "New tab"
        : options?.name
          ? `${key}:${options.name}${options.message ? `:${options.message}` : ""}`
          : key,
  }),
}));
vi.mock("@mantine/core", () => ({
  Button: ({ children, loading: _loading, variant: _variant, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Group: ({ children }: any) => <div>{children}</div>,
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, ...props }: any) => <p {...props}>{children}</p>,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children, onClose, pending }: any) =>
    opened ? (
      <div role="dialog" data-pending={String(!!pending)}>
        <button type="button" aria-label="outside" onClick={onClose} />
        {children}
      </div>
    ) : null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const currentTab: Tab = {
  name: "Current",
  value: "11111111-1111-4111-8111-111111111111",
  type: "analysis",
  gameOrigin: { kind: "none" },
};
const otherTab: Tab = {
  ...currentTab,
  name: "Other",
  value: "22222222-2222-4222-8222-222222222222",
};

const blocking: BlockingTab[] = [
  { value: currentTab.value, name: currentTab.name, uninspectable: false },
  { value: otherTab.value, name: otherTab.name, uninspectable: true },
];

let host: HTMLDivElement;
let root: Root;
let jotaiStore: ReturnType<typeof createStore>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  jotaiStore = createStore();
  jotaiStore.set(tabsAtom, [currentTab, otherTab], otherTab.value);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
});

async function renderModal(props: {
  failClosed: boolean;
  tabs: BlockingTab[];
  onCancel?: () => void;
  onQuitWithoutSaving?: () => void;
  onSaveAndQuit?: () => Promise<QuitSaveOutcome>;
}) {
  const onCancel = props.onCancel ?? vi.fn();
  const onQuitWithoutSaving = props.onQuitWithoutSaving ?? vi.fn();
  const onSaveAndQuit =
    props.onSaveAndQuit ?? vi.fn(async (): Promise<QuitSaveOutcome> => ({ kind: "quit" }));
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <QuitConfirmModal
          opened
          failClosed={props.failClosed}
          tabs={props.tabs}
          onCancel={onCancel}
          onQuitWithoutSaving={onQuitWithoutSaving}
          onSaveAndQuit={onSaveAndQuit}
        />
      </Provider>,
    ),
  );
  return { onCancel, onQuitWithoutSaving };
}

test("lists tab names and marks uninspectable tabs", async () => {
  await renderModal({ failClosed: false, tabs: blocking });
  const items = [...host.querySelectorAll("li")].map((item) => item.textContent);
  expect(items).toEqual(["Current", "Tab.QuitUninspectable:Other"]);
  expect(host.textContent).toContain("Tab.UnsavedChanges");
  expect(host.textContent).toContain("Tab.UnsavedChangesQuit");
});

test("Cancel navigates to / and activates the first listed tab", async () => {
  const { onCancel } = await renderModal({ failClosed: false, tabs: blocking });
  expect(jotaiStore.get(activeTabAtom)).toBe(otherTab.value);
  await act(async () => {
    host.querySelectorAll("button")[1]?.click();
  });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith({ to: "/" });
  expect(jotaiStore.get(activeTabAtom)).toBe(currentTab.value);
});

test("fail-closed Cancel keeps route and tab", async () => {
  const { onCancel } = await renderModal({ failClosed: true, tabs: [] });
  expect(host.querySelector("ul")).toBeNull();
  expect(host.textContent).toContain("Tab.UnsavedChangesQuitFailClosed");
  await act(async () => {
    host.querySelectorAll("button")[1]?.click();
  });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  expect(jotaiStore.get(activeTabAtom)).toBe(otherTab.value);
});

test("Quit without saving destroys exactly once", async () => {
  const { onQuitWithoutSaving } = await renderModal({ failClosed: false, tabs: blocking });
  await act(async () => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Tab.QuitWithoutSaving")
      ?.click();
  });
  expect(onQuitWithoutSaving).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

const button = (name: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

test("a tab named by a translation key is listed translated, with its file", async () => {
  const fileTab: Tab = {
    name: "Tab.NewTab",
    value: "33333333-3333-4333-8333-333333333333",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: "games" }, kind: "fileWorkspace" },
        name: "games.pgn",
        numGames: 1,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };
  const keyNamed: Tab = { ...currentTab, name: "Tab.NewTab" };
  jotaiStore.set(tabsAtom, [keyNamed, fileTab], keyNamed.value);
  await renderModal({
    failClosed: false,
    tabs: [
      { value: keyNamed.value, name: keyNamed.name, uninspectable: false },
      { value: fileTab.value, name: fileTab.name, uninspectable: false },
    ],
  });
  expect([...host.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "New tab",
    "games › New tab",
  ]);
});

test("uninspectable entries and save messages use the same readable label", async () => {
  const keyNamed: Tab = { ...currentTab, name: "Tab.NewTab" };
  jotaiStore.set(tabsAtom, [keyNamed, otherTab], keyNamed.value);
  const named: BlockingTab = { value: keyNamed.value, name: keyNamed.name, uninspectable: false };
  const onSaveAndQuit = vi.fn(
    async (): Promise<QuitSaveOutcome> => ({ kind: "blocked", tab: named, reason: "attention" }),
  );
  await renderModal({
    failClosed: false,
    tabs: [named, { ...named, uninspectable: true }],
    onSaveAndQuit,
  });
  expect(host.querySelectorAll("li")[1]?.textContent).toBe("Tab.QuitUninspectable:New tab");
  await act(async () => button("Tab.SaveAndQuit")?.click());
  expect(host.textContent).toContain("Tab.QuitSaveNeedsAttention:New tab");
});

test("Cancel clears a save message so a reopened dialog starts clean", async () => {
  const onSaveAndQuit = vi.fn(
    async (): Promise<QuitSaveOutcome> => ({
      kind: "blocked",
      tab: blocking[0]!,
      reason: "failed",
      message: "disk full",
    }),
  );
  await renderModal({ failClosed: false, tabs: blocking, onSaveAndQuit });
  await act(async () => button("Tab.SaveAndQuit")?.click());
  expect(host.textContent).toContain("disk full");
  await act(async () => button("Common.Cancel")?.click());
  expect(host.textContent).not.toContain("disk full");
});

test("Save and quit is offered only when something can be saved", async () => {
  const onSaveAndQuit = vi.fn(async (): Promise<QuitSaveOutcome> => ({ kind: "quit" }));
  await renderModal({ failClosed: false, tabs: blocking, onSaveAndQuit });
  expect(button("Tab.SaveAndQuit")).toBeDefined();
  await renderModal({ failClosed: false, tabs: [blocking[1]!], onSaveAndQuit });
  expect(button("Tab.SaveAndQuit")).toBeUndefined();
  await renderModal({ failClosed: true, tabs: [], onSaveAndQuit });
  expect(button("Tab.SaveAndQuit")).toBeUndefined();
});

test("a pending save locks the dialog, and a blocked save names the tab and the reason", async () => {
  let finish!: (outcome: QuitSaveOutcome) => void;
  const onSaveAndQuit = vi.fn(
    () =>
      new Promise<QuitSaveOutcome>((resolve) => {
        finish = resolve;
      }),
  );
  await renderModal({ failClosed: false, tabs: blocking, onSaveAndQuit });
  await act(async () => button("Tab.SaveAndQuit")?.click());
  expect(host.querySelector("[role=dialog]")?.getAttribute("data-pending")).toBe("true");
  expect(button("Common.Cancel")?.disabled).toBe(true);
  expect(button("Tab.QuitWithoutSaving")?.disabled).toBe(true);
  await act(async () =>
    finish({ kind: "blocked", tab: blocking[0]!, reason: "failed", message: "disk full" }),
  );
  expect(host.querySelector("[role=dialog]")?.getAttribute("data-pending")).toBe("false");
  expect(host.textContent).toContain("Tab.QuitSaveFailed:Current:disk full");
  expect(button("Common.Cancel")?.disabled).toBe(false);
});

test.each([
  ["attention", "Tab.QuitSaveNeedsAttention:Current"],
  ["superseded", "Tab.QuitSaveFailed:Current:Tab.SaveSuperseded"],
] as const)("a %s outcome shows its own message", async (reason, text) => {
  const onSaveAndQuit = vi.fn(
    async (): Promise<QuitSaveOutcome> => ({ kind: "blocked", tab: blocking[0]!, reason }),
  );
  await renderModal({ failClosed: false, tabs: blocking, onSaveAndQuit });
  await act(async () => button("Tab.SaveAndQuit")?.click());
  expect(host.textContent).toContain(text);
});

test("a thrown save shows its message and unlocks the dialog", async () => {
  const onSaveAndQuit = vi.fn(async (): Promise<QuitSaveOutcome> => {
    throw new Error("scan exploded");
  });
  await renderModal({ failClosed: false, tabs: blocking, onSaveAndQuit });
  await act(async () => button("Tab.SaveAndQuit")?.click());
  expect(host.textContent).toContain("scan exploded");
  expect(host.querySelector("[role=dialog]")?.getAttribute("data-pending")).toBe("false");
});
