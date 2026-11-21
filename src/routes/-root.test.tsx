import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import type { AppMenuCallbacks } from "./-appMenu";
import { focusedDialogButton, press } from "@/tests/keyboard";

const mocks = vi.hoisted(() => ({
  fileRevision: vi.fn(),
  windowFocus: vi.fn(),
  lastCallbacks: null as AppMenuCallbacks | null,
  createTab: vi.fn(),
  pickPgnFile: vi.fn(),
  requestBoardCommand: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("@/components/boards/boardCommands", () => ({
  requestBoardCommand: mocks.requestBoardCommand,
}));

vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  const analysis = {
    value: "analysis-tab",
    name: "Game",
    type: "analysis",
    gameOrigin: { kind: "none" },
  };
  return {
    nativeBarAtom: atom(false),
    tabsAtom: atom([analysis]),
    currentTabAtom: atom(analysis),
    workspaceStartedFresh: () => false,
  };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await import("jotai");
  return {
    keyMapAtom: atom({
      NEW_TAB: { keys: "Ctrl+T" },
      OPEN_FILE: { keys: "Ctrl+O" },
      SAVE_FILE: { keys: "Ctrl+S" },
    }),
  };
});
vi.mock("@/platform/native", () => ({
  Menu: {},
  MenuItem: {},
  PredefinedMenuItem: {},
  Submenu: {},
  ask: mocks.ask,
  exit: vi.fn(),
  error: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  getCurrentWindow: vi.fn(),
  getCurrentWebviewWindow: vi.fn(() => ({
    destroy: vi.fn(),
    onCloseRequested: async () => () => undefined,
  })),
  platform: vi.fn(() => "linux"),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    openAppLog: vi.fn(),
    fileRevision: mocks.fileRevision,
  },
  tauriSubscriptions: { windowFocus: mocks.windowFocus },
}));
vi.mock("@/components/About", () => ({ default: () => null }));
vi.mock("@/components/library/ChessBaseGuide", () => ({ default: () => null }));
vi.mock("@/components/feedback/LazyFeedbackModal", () => ({
  default: ({ opened, onClose }: { opened: boolean; onClose: () => void }) =>
    opened ? (
      <div data-testid="feedback-modal">
        <button type="button" data-testid="feedback-modal-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/Sidebar", () => ({
  SideBar: ({ onSendFeedback }: { onSendFeedback: () => void }) => (
    <button type="button" data-testid="sidebar-feedback" onClick={onSendFeedback}>
      feedback
    </button>
  ),
}));
vi.mock("@/components/TopBar", () => ({ default: () => null }));
vi.mock("@/components/WindowResizeHandles", () => ({ WindowResizeHandles: () => null }));
vi.mock("@/components/tabs/QuitConfirmModal", () => ({ default: () => null }));
vi.mock("@/components/tabs/TabCommands", () => ({
  TabCommandsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-commands-owner">{children}</div>
  ),
}));
vi.mock("@/utils/files", () => ({ pickPgnFile: mocks.pickPgnFile }));
vi.mock("@/utils/openFile", () => ({ openFile: vi.fn() }));
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  createTab: mocks.createTab,
}));
vi.mock("@mantine/core", () => {
  function AppShell({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  }
  AppShell.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  AppShell.Navbar = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  AppShell.Main = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppShell };
});
vi.mock("./-appMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./-appMenu")>();
  return {
    ...actual,
    buildAppMenuTree: (args: Parameters<typeof actual.buildAppMenuTree>[0]) => {
      mocks.lastCallbacks = args.callbacks;
      return actual.buildAppMenuTree(args);
    },
    installAppMenuSurface: vi.fn(async () => ({ decorationsApplied: false })),
  };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createRootRouteWithContext: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { RootLayout, startRootFileFreshnessPoll } from "./__root";
import { menuWindowPlatform } from "./-appMenu";
import { reloadApp } from "@/components/settings/advancedActions";
import { getDefaultStore } from "jotai";
import { getCurrentWindow } from "@/platform/native";
import { nativeBarAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";

beforeEach(() => {
  mocks.fileRevision.mockReset().mockResolvedValue("dev:ino:revision");
  mocks.windowFocus.mockReset().mockResolvedValue(vi.fn());
  mocks.lastCallbacks = null;
  mocks.createTab.mockReset().mockResolvedValue("created");
  mocks.pickPgnFile.mockReset().mockResolvedValue(null);
  mocks.ask.mockReset().mockResolvedValue(false);
});

test.each([
  { name: "NEW_TAB", key: "t", action: mocks.createTab },
  { name: "OPEN_FILE", key: "o", action: mocks.pickPgnFile },
])("$name yields to a focused dialog button and works after dismissal", async ({ key, action }) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<RootLayout />));
  const { dialog, button } = focusedDialogButton();
  dialog.setAttribute("role", "dialog");
  try {
    expect(document.activeElement).toBe(button);
    await act(async () => {
      expect(press(key, { target: button, ctrlKey: true }).defaultPrevented).toBe(false);
    });
    expect(action).not.toHaveBeenCalled();
    dialog.remove();

    await act(async () => {
      press(key, { ctrlKey: true });
    });
    expect(action).toHaveBeenCalledOnce();
  } finally {
    dialog.remove();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the menu reload, clear-saved-data and open-logs actions call the Settings implementation", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<RootLayout />));
  try {
    expect(mocks.lastCallbacks).not.toBeNull();
    expect(mocks.lastCallbacks!.reload).toBe(reloadApp);

    const { tauri } = await import("@/platform/tauri");
    await act(async () => {
      await mocks.lastCallbacks!.openLogs();
    });
    expect(tauri.openAppLog).toHaveBeenCalledOnce();

    await act(async () => {
      await mocks.lastCallbacks!.clearSavedData();
    });
    expect(mocks.ask).toHaveBeenCalledExactlyOnceWith("Menu.Help.ClearSavedData.Confirm", {
      title: "Menu.Help.ClearSavedData.Title",
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the root poll follows current file tabs, listens for focus, and stops its resources", async () => {
  vi.useFakeTimers();
  const handle = { id: { id: "root-poll-file" }, kind: "fileWorkspace" as const };
  const tab = {
    value: "root-poll-tab",
    gameOrigin: { kind: "file", file: { handle }, gameNumber: 0 },
  } as Tab;
  const getTabs = vi.fn(() => [tab]);
  const unsubscribe = vi.fn();
  let onFocus: (() => void) | undefined;
  mocks.windowFocus.mockImplementation(async (callback: () => void) => {
    onFocus = callback;
    return unsubscribe;
  });

  const stop = startRootFileFreshnessPoll(getTabs);
  await Promise.resolve();
  onFocus?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(mocks.fileRevision).toHaveBeenCalledWith(handle, {
    signal: expect.any(AbortSignal),
  });
  expect(getTabs).toHaveBeenCalled();
  expect(mocks.windowFocus).toHaveBeenCalledOnce();

  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(mocks.fileRevision).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("the sidebar feedback button opens the same dialog", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => {
    root.render(<RootLayout />);
  });
  expect(host.querySelector("[data-testid='tab-commands-owner']")).not.toBeNull();
  expect(host.querySelector("[data-testid='feedback-modal']")).toBeNull();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-testid='sidebar-feedback']")?.click();
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).not.toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

test("the Help-menu feedback action opens the dialog", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => {
    root.render(<RootLayout />);
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).toBeNull();
  expect(mocks.lastCallbacks).not.toBeNull();
  await act(async () => {
    mocks.lastCallbacks?.sendFeedback();
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).not.toBeNull();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-testid='feedback-modal-close']")?.click();
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

test("the root binds no Save hotkey; Ctrl+S belongs to the board alone", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<RootLayout />));
  try {
    mocks.requestBoardCommand.mockClear();
    await act(async () => {
      press("s", { ctrlKey: true });
    });
    expect(mocks.requestBoardCommand).not.toHaveBeenCalled();

    // The File menu entry does request the save of the active analysis tab.
    await act(async () => {
      await mocks.lastCallbacks?.saveGame();
    });
    expect(mocks.requestBoardCommand).toHaveBeenCalledWith(expect.anything(), "save");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const drawsOwnTopBar = menuWindowPlatform(String(import.meta.env.VITE_PLATFORM)) !== "other";

async function renderWithWindow(isNative: boolean) {
  const fullscreen = { value: false };
  const appWindow = {
    isFullscreen: vi.fn(async () => fullscreen.value),
    setFullscreen: vi.fn(async (next: boolean) => {
      fullscreen.value = next;
    }),
  };
  vi.mocked(getCurrentWindow).mockReturnValue(appWindow as never);
  getDefaultStore().set(nativeBarAtom, isNative);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<RootLayout />));
  return {
    appWindow,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      getDefaultStore().set(nativeBarAtom, false);
    },
  };
}

test.runIf(drawsOwnTopBar)(
  "F11 toggles full screen with the in-app menu bar from the page, a text field, a rich-text editor and a dialog",
  async () => {
    const { appWindow, unmount } = await renderWithWindow(false);
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    // jsdom does not implement isContentEditable, which react-hotkeys-hook reads.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    document.body.append(input, editor);
    const targets: { name: string; focus: () => HTMLElement | undefined }[] = [
      { name: "page", focus: () => undefined },
      { name: "input", focus: () => (input.focus(), input) },
      { name: "contenteditable", focus: () => (editor.focus(), editor) },
      { name: "dialog", focus: () => focusedDialogButton().button },
    ];
    try {
      let expected = false;
      for (const { name, focus } of targets) {
        const target = focus();
        let keydown: KeyboardEvent | undefined;
        await act(async () => {
          keydown = press("F11", target ? { target } : {});
        });
        expected = !expected;
        await vi.waitFor(() =>
          expect({ name, lastCall: appWindow.setFullscreen.mock.lastCall }).toEqual({
            name,
            lastCall: [expected],
          }),
        );
        expect({ name, prevented: keydown?.defaultPrevented }).toEqual({ name, prevented: true });
      }
      expect(appWindow.setFullscreen).toHaveBeenCalledTimes(targets.length);
    } finally {
      document.querySelectorAll('[aria-modal="true"]').forEach((dialog) => dialog.remove());
      input.remove();
      editor.remove();
      await unmount();
    }
  },
);

test.runIf(drawsOwnTopBar)("holding F11 toggles full screen once", async () => {
  const { appWindow, unmount } = await renderWithWindow(false);
  try {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F11", code: "F11", bubbles: true }),
      );
      for (let i = 0; i < 3; i++) {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "F11", code: "F11", repeat: true, bubbles: true }),
        );
      }
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "F11", code: "F11", bubbles: true }),
      );
    });
    await vi.waitFor(() => expect(appWindow.setFullscreen).toHaveBeenCalledWith(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appWindow.setFullscreen).toHaveBeenCalledTimes(1);
  } finally {
    await unmount();
  }
});

test("F11 is left to the native menu's accelerator when the native bar is on", async () => {
  const { appWindow, unmount } = await renderWithWindow(true);
  try {
    await act(async () => {
      expect(press("F11").defaultPrevented).toBe(false);
    });
    expect(appWindow.setFullscreen).not.toHaveBeenCalled();
  } finally {
    await unmount();
  }
});
