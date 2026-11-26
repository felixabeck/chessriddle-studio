import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import type { FeedbackType } from "@/bindings";
import type { AppMenuCallbacks } from "./-appMenu";
import { focusedDialogButton, press } from "@/tests/keyboard";

const mocks = vi.hoisted(() => ({
  fileRevision: vi.fn(),
  windowFocus: vi.fn(),
  lastCallbacks: null as AppMenuCallbacks | null,
  lastFeedbackProps: null as {
    opened: boolean;
    initialType?: FeedbackType;
    initialMessage?: string;
  } | null,
  outlet: (() => null) as () => ReactNode,
  createTab: vi.fn(),
  pickPgnFile: vi.fn(),
  requestBoardCommand: vi.fn(),
  ask: vi.fn(),
  useIncomingGameLinks: vi.fn(),
  navigate: vi.fn(),
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
    firedByNativeMenu: () => false,
    nativeMenuAccelerator: (keys: string) => keys,
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
  default: ({
    opened,
    onClose,
    initialType,
    initialMessage,
  }: {
    opened: boolean;
    onClose: () => void;
    initialType?: FeedbackType;
    initialMessage?: string;
  }) => {
    mocks.lastFeedbackProps = { opened, initialType, initialMessage };
    return opened ? (
      <div data-testid="feedback-modal">
        <button type="button" data-testid="feedback-modal-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null;
  },
}));
vi.mock("@/components/tabs/NavigationRow", () => ({
  default: ({ onSendFeedback }: { onSendFeedback: () => void }) => (
    <button type="button" data-testid="row-feedback" onClick={onSendFeedback}>
      feedback
    </button>
  ),
}));
vi.mock("@/components/WindowResizeHandles", () => ({ WindowResizeHandles: () => null }));
vi.mock("@/components/tabs/QuitConfirmModal", () => ({ default: () => null }));
vi.mock("@/components/tabs/useIncomingGameLinks", () => ({
  useIncomingGameLinks: mocks.useIncomingGameLinks,
}));
vi.mock("@/components/tabs/TabCommands", () => ({
  TabCommandsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-commands-owner">{children}</div>
  ),
  useTabCommands: () => ({
    newTab: mocks.createTab,
    tabs: [],
    activeTab: null,
    selectTab: () => undefined,
    showTab: () => undefined,
    closeTab: async () => undefined,
    duplicateTab: () => undefined,
    renameTab: () => undefined,
    reorderTabs: () => undefined,
    pageTabs: [],
    showPageTab: () => undefined,
    closePageTab: () => undefined,
  }),
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
    buildInAppMenuItems: (args: Parameters<typeof actual.buildInAppMenuItems>[0]) => {
      mocks.lastCallbacks = args.callbacks;
      return actual.buildInAppMenuItems(args);
    },
    buildAppMenuTree: (args: Parameters<typeof actual.buildAppMenuTree>[0]) => {
      mocks.lastCallbacks = args.callbacks;
      return actual.buildAppMenuTree(args);
    },
    installAppMenuSurface: vi.fn(async () => ({ decorationsApplied: false })),
  };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Outlet: () => mocks.outlet(),
  createRootRouteWithContext: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { RootLayout, startRootFileFreshnessPoll, useOpenFeedback } from "./__root";
import { installAppMenuSurface, menuWindowPlatform, wantRealMenu } from "./-appMenu";
import { getDefaultStore } from "jotai";
import { getCurrentWindow } from "@/platform/native";
import { nativeBarAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";

beforeEach(() => {
  mocks.fileRevision.mockReset().mockResolvedValue("dev:ino:revision");
  mocks.windowFocus.mockReset().mockResolvedValue(vi.fn());
  mocks.lastCallbacks = null;
  mocks.lastFeedbackProps = null;
  mocks.outlet = () => null;
  mocks.createTab.mockReset().mockResolvedValue("created");
  mocks.pickPgnFile.mockReset().mockResolvedValue(null);
  mocks.ask.mockReset().mockResolvedValue(false);
  mocks.navigate.mockReset().mockResolvedValue(undefined);
});

test.each([{ name: "OPEN_FILE", key: "o", action: mocks.pickPgnFile }])(
  "$name yields to a focused dialog button and works after dismissal",
  async ({ key, action }) => {
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
  },
);

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

test("the root shell is the one owner of incoming game links", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.useIncomingGameLinks.mockClear();
  await act(async () => {
    root.render(<RootLayout />);
  });
  // Mounted below the router and the tab owner, on every render of the shell.
  expect(mocks.useIncomingGameLinks).toHaveBeenCalled();
  expect(host.querySelector("[data-testid='tab-commands-owner']")).not.toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

test("the row feedback button opens the same dialog", async () => {
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
    host.querySelector<HTMLButtonElement>("[data-testid='row-feedback']")?.click();
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).not.toBeNull();
  expect(mocks.lastFeedbackProps).toEqual({
    opened: true,
    initialType: undefined,
    initialMessage: undefined,
  });
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
  expect(mocks.lastFeedbackProps).toEqual({
    opened: true,
    initialType: undefined,
    initialMessage: undefined,
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-testid='feedback-modal-close']")?.click();
  });
  expect(host.querySelector("[data-testid='feedback-modal']")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

test("useOpenFeedback opens the dialog prefilled and reopening without a draft opens it empty", async () => {
  function FeedbackTrigger() {
    const openFeedback = useOpenFeedback();
    return (
      <div>
        <button
          type="button"
          data-testid="open-prefilled-feedback"
          onClick={() =>
            openFeedback({ type: "suggestion", message: "Please link directly to Settings." })
          }
        >
          prefilled
        </button>
        <button type="button" data-testid="open-empty-feedback" onClick={() => openFeedback()}>
          empty
        </button>
      </div>
    );
  }
  mocks.outlet = () => <FeedbackTrigger />;

  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => {
    root.render(<RootLayout />);
  });

  try {
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='open-prefilled-feedback']")?.click();
    });
    expect(mocks.lastFeedbackProps).toEqual({
      opened: true,
      initialType: "suggestion",
      initialMessage: "Please link directly to Settings.",
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='feedback-modal-close']")?.click();
    });
    expect(host.querySelector("[data-testid='feedback-modal']")).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='row-feedback']")?.click();
    });
    expect(mocks.lastFeedbackProps).toEqual({
      opened: true,
      initialType: undefined,
      initialMessage: undefined,
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='feedback-modal-close']")?.click();
    });
    await act(async () => {
      mocks.lastCallbacks?.sendFeedback();
    });
    expect(mocks.lastFeedbackProps).toEqual({
      opened: true,
      initialType: undefined,
      initialMessage: undefined,
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='feedback-modal-close']")?.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='open-empty-feedback']")?.click();
    });
    expect(mocks.lastFeedbackProps).toEqual({
      opened: true,
      initialType: undefined,
      initialMessage: undefined,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("useOpenFeedback throws outside OpenFeedbackContext", async () => {
  function OrphanConsumer() {
    useOpenFeedback();
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(act(async () => root.render(<OrphanConsumer />))).rejects.toThrow(
      "useOpenFeedback used outside RootLayout",
    );
  } finally {
    errorSpy.mockRestore();
    await act(async () => root.unmount());
    host.remove();
  }
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

const bindsRendererF11 = menuWindowPlatform(String(import.meta.env.VITE_PLATFORM)) !== "other";

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

test.runIf(bindsRendererF11)(
  "F11 toggles full screen from the page, a text field, a rich-text editor and a dialog",
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

test.runIf(bindsRendererF11)("holding F11 toggles full screen once", async () => {
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

test.runIf(bindsRendererF11)(
  "F11 still toggles full screen with native decorations on Linux and Windows",
  async () => {
    const { appWindow, unmount } = await renderWithWindow(true);
    try {
      await act(async () => {
        expect(press("F11").defaultPrevented).toBe(true);
      });
      await vi.waitFor(() => expect(appWindow.setFullscreen).toHaveBeenCalledWith(true));
    } finally {
      await unmount();
    }
  },
);

test.runIf(!bindsRendererF11)("F11 is left to the native menu's accelerator on macOS", async () => {
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

test.runIf(bindsRendererF11)(
  "F11 reports a fullscreen error through the same callback as the menu entry",
  async () => {
    const { appWindow, unmount } = await renderWithWindow(false);
    const { notifications } = await import("@mantine/notifications");
    vi.mocked(appWindow.setFullscreen).mockRejectedValueOnce(new Error("fullscreen failed"));
    try {
      await act(async () => {
        expect(press("F11").defaultPrevented).toBe(true);
      });
      await vi.waitFor(() =>
        expect(notifications.show).toHaveBeenCalledWith(
          expect.objectContaining({ color: "danger" }),
        ),
      );
    } finally {
      await unmount();
    }
  },
);

test("the root asks for a native menu only on macOS", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<RootLayout />));
  try {
    expect(vi.mocked(installAppMenuSurface)).toHaveBeenCalled();
    const windowPlatform = menuWindowPlatform(String(import.meta.env.VITE_PLATFORM));
    expect(vi.mocked(installAppMenuSurface).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        wantRealMenu: wantRealMenu(windowPlatform),
      }),
    );
    expect(wantRealMenu("linux")).toBe(false);
    expect(wantRealMenu("win32")).toBe(false);
    expect(wantRealMenu("other")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the Help-menu Guide action navigates to /guide", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => {
    root.render(<RootLayout />);
  });
  expect(mocks.lastCallbacks).not.toBeNull();
  await act(async () => {
    await mocks.lastCallbacks?.openGuide();
  });
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/guide" });
  await act(async () => root.unmount());
  host.remove();
});
