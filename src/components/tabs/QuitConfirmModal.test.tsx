import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/state/workspaceTypes";
import type { BlockingTab } from "@/state/quitGate";
import QuitConfirmModal from "./QuitConfirmModal";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));
vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Group: ({ children }: any) => <div>{children}</div>,
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, ...props }: any) => <p {...props}>{children}</p>,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children, onClose }: any) =>
    opened ? (
      <div role="dialog">
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
}) {
  const onCancel = props.onCancel ?? vi.fn();
  const onQuitWithoutSaving = props.onQuitWithoutSaving ?? vi.fn();
  await act(async () =>
    root.render(
      <Provider store={jotaiStore}>
        <QuitConfirmModal
          opened
          failClosed={props.failClosed}
          tabs={props.tabs}
          onCancel={onCancel}
          onQuitWithoutSaving={onQuitWithoutSaving}
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
