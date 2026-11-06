import { AppShell } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createRootRouteWithContext, Outlet, useNavigate } from "@tanstack/react-router";
import { ask, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@/platform/native";
import { exit, getCurrentWebviewWindow, getCurrentWindow, platform } from "@/platform/native";
import { logFailureSafely, warnSafely } from "@/platform/errors";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useAtom, useAtomValue, useStore as useJotaiStore } from "jotai";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import AboutModal from "@/components/About";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { SideBar } from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import QuitConfirmModal from "@/components/tabs/QuitConfirmModal";
import i18n from "@/i18n";
import { nativeBarAtom, tabsAtom } from "@/state/atoms";
import {
  cancelQuitGate,
  quitWithoutSaving,
  registerQuitCloseListener,
  runQuitGate,
  type BlockingTab,
  type QuitGateHost,
} from "@/state/quitGate";
import { startFileRevisionPoll } from "@/state/fileFreshness";
import { keyMapAtom } from "@/state/keybinds";
import { initializePathOwners, startupLegacyDeckScanComplete } from "@/state/pathOwners";
import {
  ensurePracticeMigration,
  retireMigratedLegacyDeckKeysFromBrowser,
  runPracticeMigrationPass,
  type PracticeMigrationPassResult,
} from "@/state/practiceStorage";
import { openFile, pickPgnFile } from "@/utils/files";
import { createTab, type Tab } from "@/utils/tabs";
import {
  assembleNativeMenuResources,
  bindAppMenuCallbacks,
  buildAppMenuTree,
  clearSavedDataFromMenu,
  createNewTabFromMenu,
  installAppMenuSurface,
  menuWindowPlatform,
  openPgnFromMenu,
  openSettingsFromMenu,
  renderTopBar,
  runNativeMenuAction,
  wantNativeDecorations,
  type AppMenuCallbacks,
  type MenuGroup,
  type MenuHandle,
  type NativeMenuResource,
} from "./-appMenu";

const FeedbackModal = lazy(() => import("@/components/feedback/FeedbackModal"));

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
        accelerator: option.shortcut,
        action: option.action,
      }),
    menu: (items) => Menu.new({ items: items as never }),
  });
  return menu as unknown as MenuHandle;
}

export type ClearSavedDataAfterConfirmationDeps = {
  blockedMessage: (decks: string[]) => string;
  clear: () => void | Promise<void>;
};

function affectedPracticeDecks(result: PracticeMigrationPassResult): string[] {
  const affected = new Set<string>();
  for (const outcome of result.outcomes) {
    if (outcome.status === "failed") {
      affected.add(`${outcome.identity.file} (${outcome.identity.game})`);
    }
  }
  for (const anomaly of result.inventory?.anomalies ?? []) {
    affected.add(
      anomaly.fileId !== null && anomaly.game !== null
        ? `${anomaly.fileId} (${anomaly.game})`
        : anomaly.leaf,
    );
  }
  if (!result.scanTrusted || !result.inventoryTrusted) {
    affected.add(i18n.t("Board.Practice.Data"));
  }
  return [...affected].sort();
}

export async function clearSavedDataAfterConfirmation(
  deps: ClearSavedDataAfterConfirmationDeps,
): Promise<void> {
  const pathOwnersInitialized = await initializePathOwners().then(
    () => true,
    () => false,
  );
  await ensurePracticeMigration();
  const result = await runPracticeMigrationPass();
  if (pathOwnersInitialized && startupLegacyDeckScanComplete()) {
    retireMigratedLegacyDeckKeysFromBrowser(result.outcomes);
  }
  const affected = affectedPracticeDecks(result);
  if (affected.length > 0) {
    throw new Error(deps.blockedMessage(affected));
  }
  await deps.clear();
}

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
  const isNative = useAtomValue(nativeBarAtom);
  const navigate = useNavigate();
  const jotaiStore = useJotaiStore();

  const [, setTabs] = useAtom(tabsAtom);

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

  const createNewTab = useCallback(
    () =>
      createNewTabFromMenu({
        navigate,
        createTab: () =>
          createTab({
            tab: { name: t("Tab.NewTab"), type: "new" },
            setTabs,
          }),
      }),
    [navigate, setTabs, t],
  );

  const openSettings = useCallback(() => openSettingsFromMenu({ navigate }), [navigate]);

  const toggleFullscreen = useCallback(async () => {
    const currentWindow = getCurrentWindow();
    const isFullscreen = await currentWindow.isFullscreen();
    await currentWindow.setFullscreen(!isFullscreen);
  }, []);

  const [keyMap] = useAtom(keyMapAtom);
  const [opened, setOpened] = useState(false);
  const [feedbackOpened, setFeedbackOpened] = useState(false);
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

  const menuCallbacks: AppMenuCallbacks = useMemo(
    () =>
      bindAppMenuCallbacks({
        runMenu,
        about: () => setOpened(true),
        sendFeedback: () => setFeedbackOpened(true),
        createNewTab,
        openNewFile,
        openSettings,
        exit: () => requestQuit(),
        reload: () => location.reload(),
        toggleFullscreen,
        documentation: () => tauri.openDocumentation(),
        clearSavedData: () =>
          clearSavedDataFromMenu({
            ask,
            confirmMessage: t("Menu.Help.ClearSavedData.Confirm"),
            title: t("Menu.Help.ClearSavedData.Title"),
            clear: () =>
              clearSavedDataAfterConfirmation({
                blockedMessage: (decks) =>
                  t("Menu.Help.ClearSavedData.MigrationBlocked", {
                    decks: decks.join(", "),
                    practiceData: t("Board.Practice.Data"),
                  }),
                clear: () => {
                  localStorage.clear();
                  sessionStorage.clear();
                  location.reload();
                },
              }),
          }),
        openLogs: () => tauri.openAppLog(),
        openLogsSuccessMessage: t("Menu.Help.OpenLogs"),
      }),
    [createNewTab, openNewFile, openSettings, requestQuit, runMenu, t, toggleFullscreen],
  );

  useHotkeys(keyMap.NEW_TAB.keys, () => {
    void menuCallbacks.createNewTab();
  });
  useHotkeys(keyMap.OPEN_FILE.keys, () => {
    void menuCallbacks.openNewFile();
  });

  const menuActions = useMemo(
    () =>
      buildAppMenuTree({
        t,
        isMacOS,
        newTabShortcut: keyMap.NEW_TAB.keys,
        openFileShortcut: keyMap.OPEN_FILE.keys,
        callbacks: menuCallbacks,
      }),
    [isMacOS, keyMap.NEW_TAB.keys, keyMap.OPEN_FILE.keys, menuCallbacks, t],
  );

  const showTopBar = renderTopBar(isNative, windowPlatform);
  const showWindowControls = showTopBar && !decorationsApplied;

  useEffect(() => {
    const myGen = ++installGeneration.current;
    void installAppMenuSurface({
      groups: menuActions,
      wantRealMenu: wantNativeDecorations(isNative, windowPlatform),
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
  }, [isNative, menuActions, notifyMenuError, windowPlatform]);

  return (
    <AppShell
      navbar={{
        width: "3rem",
        breakpoint: 0,
      }}
      header={
        showTopBar
          ? {
              height: "2.25rem",
            }
          : undefined
      }
      styles={{
        main: {
          height: "100vh",
          userSelect: "none",
          background: "var(--cf-background)",
        },
        navbar: { background: "var(--cf-card)", borderColor: "var(--cf-border)" },
        header: { background: "var(--cf-card)", borderColor: "var(--cf-border)" },
      }}
    >
      <AboutModal opened={opened} setOpened={setOpened} />
      {feedbackOpened && (
        <Suspense fallback={null}>
          <FeedbackModal opened={feedbackOpened} onClose={() => setFeedbackOpened(false)} />
        </Suspense>
      )}
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
      />
      {showTopBar && (
        <AppShell.Header>
          <TopBar menuActions={menuActions} showWindowControls={showWindowControls} />
        </AppShell.Header>
      )}
      <AppShell.Navbar>
        <SideBar />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
