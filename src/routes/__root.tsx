import { AppShell } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@/platform/native";
import { exit, getCurrentWebviewWindow, getCurrentWindow, platform } from "@/platform/native";
import { logFailureSafely, warnSafely } from "@/platform/errors";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useAtom, useAtomValue, useSetAtom, useStore as useJotaiStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import AboutModal from "@/components/About";
import ChessBaseGuide from "@/components/library/ChessBaseGuide";
import LazyFeedbackModal from "@/components/feedback/LazyFeedbackModal";
import {
  OpenFeedbackContext,
  useOpenFeedback,
  type FeedbackDraft,
} from "@/components/feedback/openFeedbackContext";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { WindowResizeHandles } from "@/components/WindowResizeHandles";
import NavigationRow from "@/components/tabs/NavigationRow";
import { isBoardsPath } from "@/components/tabs/boardTabDom";
import { TabCommandsProvider, useTabCommands } from "@/components/tabs/TabCommands";
import { useIncomingGameLinks } from "@/components/tabs/useIncomingGameLinks";
import QuitConfirmModal from "@/components/tabs/QuitConfirmModal";
import { FolderSwitchDialogHost } from "@/components/settings/FolderSwitchModal";
import { requestBoardCommand } from "@/components/boards/boardCommands";
import { showCurrentBoardTabs } from "@/state/boardLayoutKind";
import { currentBoardTabsHiddenAtom, currentTabAtom, nativeBarAtom, tabsAtom } from "@/state/atoms";
import { focusModeAtom } from "@/state/focusMode";
import { useHeaderReveal } from "@/hooks/useHeaderReveal";
import {
  assistantAvailableAtom,
  assistantPanelOpenAtom,
  coachEnabledAtom,
  refreshAssistantAvailabilityAtom,
} from "@/state/coachAvailability";
import { AssistantPanelHost } from "@/components/assistant/AssistantPanelHost";
import { AssistantTurnListener } from "@/components/assistant/AssistantTurnListener";
import { CoachTurnListener } from "@/components/panels/coach/CoachTurnListener";
import {
  cancelQuitGate,
  quitWithoutSaving,
  registerQuitCloseListener,
  runQuitGate,
  saveAndQuit,
  type BlockingTab,
  type QuitGateHost,
} from "@/state/quitGate";
import { startFileRevisionPoll } from "@/state/fileFreshness";
import {
  firedByNativeMenu,
  hasCommandModifier,
  keyMapAtom,
  nativeMenuAccelerator,
} from "@/state/keybinds";
import { pickPgnFile } from "@/utils/files";
import { openFile } from "@/utils/openFile";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { createQuitTabSaver } from "@/state/quitSave";
import type { WorkspaceSessionMirror } from "@/state/workspaceSession";
import type { Tab } from "@/utils/tabs";
import {
  assembleNativeMenuResources,
  bindAppMenuCallbacks,
  buildAppMenuTree,
  buildInAppMenuItems,
  fullscreenShortcut,
  installAppMenuSurface,
  menuWindowPlatform,
  openPgnFromMenu,
  renderResizeHandles,
  runNativeMenuAction,
  wantNativeDecorations,
  wantRealMenu,
  type AppMenuCallbacks,
  type MenuGroup,
  type MenuHandle,
  type NativeMenuResource,
} from "./-appMenu";

async function createMenu(menuActions: MenuGroup[]): Promise<MenuHandle> {
  const menu = await assembleNativeMenuResources<NativeMenuResource>(menuActions, {
    separator: () => PredefinedMenuItem.new({ item: "Separator" }),
    predefined: (option) =>
      PredefinedMenuItem.new({
        text: option.label,
        item: option.item,
      }),
    submenu: (label, items) =>
      Submenu.new({
        text: label,
        items: items as never,
      }),
    item: (option) =>
      MenuItem.new({
        id: option.id,
        text: option.label,
        accelerator: option.shortcut && nativeMenuAccelerator(option.shortcut),
        action: option.action,
      }),
    menu: (items) => Menu.new({ items: items as never }),
  });
  return menu as unknown as MenuHandle;
}

export { OpenFeedbackContext, useOpenFeedback, type FeedbackDraft };

export const Route = createRootRouteWithContext<Record<string, never>>()({
  component: RootLayout,
});

export function startRootFileFreshnessPoll(getTabs: () => readonly Tab[]): () => void {
  return startFileRevisionPoll({
    getTabs,
    fileRevision: (handle, options) => tauri.fileRevision(handle, options),
    subscribeFocus: (callback) => tauriSubscriptions.windowFocus(callback),
  });
}

export function RootLayout() {
  return (
    <TabCommandsProvider>
      <RootShell />
    </TabCommandsProvider>
  );
}

function RootShell() {
  const isNative = useAtomValue(nativeBarAtom);
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const assistantAvailable = useAtomValue(assistantAvailableAtom);
  const [assistantOpened, setAssistantOpened] = useAtom(assistantPanelOpenAtom);
  const refreshAssistantAvailability = useSetAtom(refreshAssistantAvailabilityAtom);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentTab = useAtomValue(currentTabAtom);
  const showBoardLayouts = isBoardsPath(pathname) && currentTab?.type === "analysis";
  const showBoardTabsItem = useAtomValue(currentBoardTabsHiddenAtom);

  useEffect(() => {
    if (coachEnabled) void refreshAssistantAvailability();
  }, [coachEnabled, refreshAssistantAvailability]);
  const jotaiStore = useJotaiStore();
  const { newTab, newAnalysis, showPageTab } = useTabCommands();
  useIncomingGameLinks();

  const [, setTabs] = useAtom(tabsAtom);
  const sessionMirrorRef = useRef<WorkspaceSessionMirror | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeMirror: WorkspaceSessionMirror | null = null;
    void import("@/state/workspaceSession")
      .then(
        ({ flushWorkspaceSessionNotices, getWorkspaceSessionMirror, nativeWorkspaceSession }) => {
          if (disposed) return;
          flushWorkspaceSessionNotices((message, color) => notifications.show({ color, message }));
          const mirror = getWorkspaceSessionMirror(() => ({
            native: nativeWorkspaceSession,
            jotaiStore,
            notify: (message) => notifications.show({ color: "red", message }),
          }));
          activeMirror = mirror;
          sessionMirrorRef.current = mirror;
          mirror.start();
          return import("@/state/unsavedGames").then(
            ({ nativeUnsavedGames, restoreUnsavedGames }) =>
              restoreUnsavedGames({
                native: nativeUnsavedGames,
                jotaiStore,
                setTabs: (...args) => jotaiStore.set(tabsAtom, ...args),
                notify: (message) => notifications.show({ message }),
                sessionMirror: mirror,
              }),
          );
        },
      )
      .catch((error: unknown) =>
        warnSafely(
          `Workspace session startup stopped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return () => {
      disposed = true;
      activeMirror?.stop();
    };
  }, [jotaiStore]);

  const { t } = useTranslation();
  const windowPlatform = menuWindowPlatform(String(import.meta.env.VITE_PLATFORM));
  const decorationsAppliedRef = useRef(false);
  const [decorationsApplied, setDecorationsApplied] = useState(false);
  const installGeneration = useRef(0);

  const notifyMenuError = useCallback(
    (error: unknown) => {
      notifyUnlessCancelled(t("Common.Error"), error);
    },
    [t],
  );

  const runMenu = useCallback(
    (command: () => Promise<unknown>, successMessage?: string) =>
      runNativeMenuAction(command, notifyMenuError, successMessage, (message) => {
        notifications.show({ message });
      }),
    [notifyMenuError],
  );

  const openNewFile = useCallback(
    () =>
      openPgnFromMenu({
        pickPgnFile,
        navigate,
        openFile: (file) => openFile(file, setTabs),
      }),
    [navigate, setTabs],
  );

  const openSettings = useCallback(() => showPageTab("settings"), [showPageTab]);
  const openAccounts = useCallback(() => showPageTab("accounts"), [showPageTab]);
  const openEngines = useCallback(() => showPageTab("engines"), [showPageTab]);
  const openGuide = useCallback(() => showPageTab("guide"), [showPageTab]);

  // The board consumes the request once it is mounted, so show the workspace first. No root
  // hotkey: Ctrl+S stays bound in the board alone, so one key press never starts two saves.
  const requestSave = useCallback(
    async (kind: "save" | "saveTo") => {
      const tab = jotaiStore.get(currentTabAtom);
      if (!tab || tab.type !== "analysis") return;
      await navigate({ to: "/" });
      requestBoardCommand(jotaiStore, kind);
    },
    [jotaiStore, navigate],
  );

  const toggleFullscreen = useCallback(async () => {
    const currentWindow = getCurrentWindow();
    const isFullscreen = await currentWindow.isFullscreen();
    await currentWindow.setFullscreen(!isFullscreen);
  }, []);

  const [focusMode, setFocusMode] = useAtom(focusModeAtom);
  const toggleFocusMode = useCallback(() => setFocusMode((on) => !on), [setFocusMode]);
  const headerRef = useRef<HTMLElement | null>(null);
  const headerRevealed = useHeaderReveal(focusMode, headerRef);
  const headerHidden = focusMode && !headerRevealed;

  const [keyMap] = useAtom(keyMapAtom);
  const [aboutOpened, setAboutOpened] = useState(false);
  const [feedbackState, setFeedbackState] = useState<{
    opened: boolean;
    draft?: FeedbackDraft;
  }>({ opened: false });

  const openFeedback = useCallback((draft?: FeedbackDraft) => {
    setFeedbackState({ opened: true, draft });
  }, []);

  const closeFeedback = useCallback(() => {
    setFeedbackState({ opened: false });
  }, []);
  const [quitDialog, setQuitDialog] = useState<{
    failClosed: boolean;
    tabs: BlockingTab[];
  } | null>(null);
  const isMacOS = platform() === "macos";
  const quitHostRef = useRef<QuitGateHost | null>(null);

  useEffect(() => startRootFileFreshnessPoll(() => jotaiStore.get(tabsAtom)), [jotaiStore]);

  const notifyQuitError = useCallback(
    (error: unknown) => {
      notifyUnlessCancelled(t("Common.Error"), error);
    },
    [t],
  );

  quitHostRef.current = {
    getTabs: () => jotaiStore.get(tabsAtom),
    openDialog: (state) => {
      setQuitDialog(state);
      return true;
    },
    destroyWindow: () => getCurrentWebviewWindow().destroy(),
    exitProcess: (code) => exit(code),
    saveTab: createQuitTabSaver(jotaiStore, () => void navigate({ to: "/" })),
    recovery: {
      drain: () => sessionMirrorRef.current?.drain() ?? Promise.resolve({ finished: false }),
      isConfirmed: (tabId) => sessionMirrorRef.current?.isConfirmed(tabId) ?? false,
    },
    notify: notifyQuitError,
    log: (message) =>
      logFailureSafely(
        message,
        { operation: "window-destroy", primaryFailure: { category: "unexpected", message } },
        "window-destroy",
      ),
    warn: warnSafely,
  };

  const requestQuit = useCallback(() => {
    const current = quitHostRef.current;
    if (!current) return Promise.resolve();
    return runQuitGate(current);
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    return registerQuitCloseListener({
      subscribe: (handler) => appWindow.onCloseRequested(handler),
      onCloseRequested: () => requestQuit(),
      notify: notifyQuitError,
      warn: warnSafely,
      failureMessage: t("Common.QuitListenerFailed"),
    });
  }, [notifyQuitError, requestQuit, t]);

  const openAssistant = useCallback(() => setAssistantOpened(true), [setAssistantOpened]);
  const toggleAssistant = useCallback(
    () => setAssistantOpened((open) => !open),
    [setAssistantOpened],
  );
  const closeAssistant = useCallback(() => setAssistantOpened(false), [setAssistantOpened]);

  const menuCallbacks: AppMenuCallbacks = useMemo(
    () =>
      bindAppMenuCallbacks({
        runMenu,
        about: () => setAboutOpened(true),
        sendFeedback: () => openFeedback(),
        openGuide,
        openAssistant,
        createNewTab: newTab,
        newAnalysis,
        openNewFile,
        saveGame: () => requestSave("save"),
        saveGameTo: () => requestSave("saveTo"),
        openAccounts,
        openEngines,
        openSettings,
        exit: () => requestQuit(),
        toggleFullscreen,
        toggleFocusMode,
        saveLayoutAs: () => {
          requestBoardCommand(jotaiStore, "saveLayoutAs");
        },
        manageLayouts: () => {
          requestBoardCommand(jotaiStore, "manageLayouts");
        },
        showTabs: () => showCurrentBoardTabs(jotaiStore),
      }),
    [
      jotaiStore,
      newAnalysis,
      newTab,
      openAccounts,
      openAssistant,
      openEngines,
      openFeedback,
      openGuide,
      openNewFile,
      openSettings,
      requestQuit,
      requestSave,
      runMenu,
      toggleFocusMode,
      toggleFullscreen,
    ],
  );

  useHotkeys(
    keyMap.OPEN_FILE.keys,
    () => {
      void menuCallbacks.openNewFile();
    },
    { ...backgroundHotkeyOptions, enabled: !firedByNativeMenu("OPEN_FILE") },
  );

  // A window command like F11, and a held key toggles once. It also acts from a text field or
  // editor, unless the user bound it to a key that could be typing.
  const focusModeKeysAreCommand = hasCommandModifier(keyMap.TOGGLE_FOCUS_MODE.keys);
  useHotkeys(
    keyMap.TOGGLE_FOCUS_MODE.keys,
    (event) => {
      if (event.repeat) return;
      toggleFocusMode();
    },
    {
      enabled: !firedByNativeMenu("TOGGLE_FOCUS_MODE"),
      enableOnFormTags: focusModeKeysAreCommand,
      enableOnContentEditable: focusModeKeysAreCommand,
      preventDefault: true,
    },
  );

  const focusModeMenu = useMemo(
    () => ({ on: focusMode, shortcut: keyMap.TOGGLE_FOCUS_MODE.keys }),
    [focusMode, keyMap.TOGGLE_FOCUS_MODE.keys],
  );
  const nativeMenuActions = useMemo(
    () =>
      isMacOS
        ? buildAppMenuTree({
            t,
            isMacOS,
            showAssistant: assistantAvailable,
            showBoardLayouts,
            showBoardTabsItem,
            newTabShortcut: keyMap.NEW_TAB.keys,
            newAnalysisShortcut: keyMap.NEW_ANALYSIS.keys,
            openFileShortcut: keyMap.OPEN_FILE.keys,
            saveShortcut: keyMap.SAVE_FILE.keys,
            focusMode: focusModeMenu,
            callbacks: menuCallbacks,
          })
        : [],
    [
      assistantAvailable,
      focusModeMenu,
      isMacOS,
      keyMap.NEW_ANALYSIS.keys,
      keyMap.NEW_TAB.keys,
      keyMap.OPEN_FILE.keys,
      keyMap.SAVE_FILE.keys,
      menuCallbacks,
      showBoardLayouts,
      showBoardTabsItem,
      t,
    ],
  );
  const inAppMenuActions = useMemo(
    () =>
      buildInAppMenuItems({
        t,
        isMacOS,
        showAssistant: assistantAvailable,
        showBoardLayouts,
        showBoardTabsItem,
        newTabShortcut: keyMap.NEW_TAB.keys,
        newAnalysisShortcut: keyMap.NEW_ANALYSIS.keys,
        openFileShortcut: keyMap.OPEN_FILE.keys,
        saveShortcut: keyMap.SAVE_FILE.keys,
        focusMode: focusModeMenu,
        callbacks: menuCallbacks,
      }),
    [
      assistantAvailable,
      focusModeMenu,
      isMacOS,
      keyMap.NEW_ANALYSIS.keys,
      keyMap.NEW_TAB.keys,
      keyMap.OPEN_FILE.keys,
      keyMap.SAVE_FILE.keys,
      menuCallbacks,
      showBoardLayouts,
      showBoardTabsItem,
      t,
    ],
  );

  // The native macOS menu fires its own accelerator; binding F11 there too would toggle twice.
  // A window command, so it works from any field or dialog; a held key toggles once.
  useHotkeys(
    fullscreenShortcut(isMacOS),
    (event) => {
      if (event.repeat) return;
      void menuCallbacks.toggleFullscreen();
    },
    {
      enabled: windowPlatform !== "other",
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
    },
  );
  const showWindowControls = windowPlatform !== "other" && !isNative && !decorationsApplied;

  useEffect(() => {
    const myGen = ++installGeneration.current;
    void installAppMenuSurface({
      groups: nativeMenuActions,
      wantRealMenu: wantRealMenu(windowPlatform),
      wantDecorations: wantNativeDecorations(isNative, windowPlatform),
      previousDecorationsApplied: decorationsAppliedRef.current,
      isCurrent: () => installGeneration.current === myGen,
      createMenu,
      setDecorations: (on) => getCurrentWindow().setDecorations(on),
      closeMenu: async (menu) => {
        if (typeof menu.close === "function") await menu.close();
      },
      notify: notifyMenuError,
    }).then((result) => {
      if (installGeneration.current !== myGen) return;
      decorationsAppliedRef.current = result.decorationsApplied;
      setDecorationsApplied(result.decorationsApplied);
    });
    return () => {
      installGeneration.current += 1;
    };
  }, [isNative, nativeMenuActions, notifyMenuError, windowPlatform]);

  return (
    <OpenFeedbackContext.Provider value={openFeedback}>
      <AppShell
        padding={0}
        header={{ height: "2.625rem", collapsed: headerHidden }}
        styles={{
          main: {
            height: "100vh",
            minHeight: 0,
            // In focus mode the content keeps the header's height; a revealed header overlays it.
            paddingTop: focusMode ? 0 : "2.625rem",
            paddingBottom: 0,
            overflow: "hidden",
            userSelect: "none",
            background: "var(--cf-background)",
          },
          header: {
            background: "var(--cf-surface-inset)",
            borderBottom: "none",
            minWidth: 0,
            padding: 0,
          },
        }}
      >
        {coachEnabled && <CoachTurnListener />}
        {coachEnabled && <AssistantTurnListener />}
        <AboutModal opened={aboutOpened} setOpened={setAboutOpened} />
        <ChessBaseGuide />
        <LazyFeedbackModal
          opened={feedbackState.opened}
          initialType={feedbackState.draft?.type}
          initialMessage={feedbackState.draft?.message}
          onClose={closeFeedback}
        />
        <QuitConfirmModal
          opened={quitDialog !== null}
          failClosed={quitDialog?.failClosed ?? false}
          tabs={quitDialog?.tabs ?? []}
          onCancel={() => {
            setQuitDialog(null);
            cancelQuitGate();
          }}
          onQuitWithoutSaving={() => {
            void quitWithoutSaving();
          }}
          onSaveAndQuit={saveAndQuit}
        />
        <FolderSwitchDialogHost />
        <AppShell.Header ref={headerRef} inert={headerHidden}>
          <NavigationRow
            menuActions={inAppMenuActions}
            showWindowControls={showWindowControls}
            onSendFeedback={menuCallbacks.sendFeedback}
            showAssistant={assistantAvailable}
            assistantOpened={assistantOpened}
            onToggleAssistant={toggleAssistant}
          />
        </AppShell.Header>
        {renderResizeHandles(windowPlatform, showWindowControls) && <WindowResizeHandles />}
        <AppShell.Main>
          <div style={{ display: "flex", height: "100%", minHeight: 0, position: "relative" }}>
            <div style={{ flex: "1 1 0", minWidth: 0, height: "100%", overflow: "auto" }}>
              <Outlet />
            </div>
            <AssistantPanelHost
              opened={assistantOpened}
              onClose={closeAssistant}
              createNewTab={newTab}
              openAccounts={openAccounts}
              openEngines={openEngines}
              openSettings={openSettings}
            />
          </div>
        </AppShell.Main>
      </AppShell>
    </OpenFeedbackContext.Provider>
  );
}
