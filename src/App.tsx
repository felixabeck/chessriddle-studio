import { localStorageColorSchemeManager, MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import i18n from "@/i18n";
import { ask, check, info, platform, relaunch, type Update, warn } from "@/platform/native";
import { warnSafely } from "@/platform/errors";
import { getDefaultStore, useAtomValue } from "jotai";
import { ContextMenuProvider } from "mantine-contextmenu";
import { useEffect, useMemo, useRef } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  fontSizeAtom,
  pieceSetAtom,
  pieceSizeAtom,
  referenceDbAtom,
  spellCheckAtom,
  tabsAtom,
} from "./state/atoms";
import { isQuitGateInProgress, scanBlockingTabs } from "./state/quitGate";

import "@/styles/chessgroundBaseOverride.css";
import "@/styles/chessgroundColorsOverride.css";

import "@mantine/charts/styles.layer.css";
import "@mantine/core/styles.layer.css";
import "@mantine/dates/styles.layer.css";
import "@mantine/notifications/styles.layer.css";
import "@mantine/tiptap/styles.layer.css";

import "mantine-contextmenu/styles.layer.css";
import "mantine-datatable/styles.layer.css";

import "@/styles/global.css";

import { tauri } from "./platform/tauri";

const colorSchemeManager = localStorageColorSchemeManager({
  key: "mantine-color-scheme",
});

const notificationMaxHeight = "calc(100dvh - 2 * var(--mantine-spacing-md))";

import ErrorComponent from "@/components/ErrorComponent";
import ThemeVariantSync from "@/styles/ThemeVariantSync";
import { useConversionProgress } from "@/hooks/useConversionProgress";
import { useDatabaseContentValidation } from "@/hooks/useDatabaseContentValidation";
import { useDocumentLanguage } from "@/hooks/useDocumentLanguage";
import { routeTree } from "./routeTree.gen";
import { appCssVariablesResolver, createAppTheme } from "./styles/theme";
import { initializePathOwners } from "./state/pathOwners";
import { SessionPersistenceNotice } from "./components/home/SessionPersistenceNotice";
import { AutomaticStockfishNotice } from "./components/home/AutomaticStockfishNotice";
import { FixedNoticeStack, fixedNoticeToastRoot } from "./components/home/FixedNoticeStack";
import { installNativeContextMenuSuppression } from "./utils/nativeContextMenu";

const router = createRouter({
  routeTree,
  defaultErrorComponent: ErrorComponent,
  context: {},
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const preloadReferenceDb = async (
  store: ReturnType<typeof getDefaultStore>,
  signal: AbortSignal,
) => {
  const referenceDb = store.get(referenceDbAtom);
  if (referenceDb && !signal.aborted) {
    info(`Preloading reference database: ${referenceDb}`);
    try {
      await tauri.preloadReferenceDb(referenceDb, { signal });
    } catch (e) {
      if (signal.aborted) return;
      warn(`Failed to preload reference database: ${e}`);
    }
  }
};

/** Upper bound for the startup update check; a slow or unreachable endpoint must not linger. */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const t = i18n.t.bind(i18n);

function shouldDeferUpdateRestart(): boolean {
  if (isQuitGateInProgress()) {
    info("Update restart deferred: a quit is already in progress");
    return true;
  }
  try {
    if (scanBlockingTabs(getDefaultStore().get(tabsAtom)).length > 0) {
      info("Update restart deferred: unsaved work in open tabs");
      return true;
    }
    return false;
  } catch (e) {
    warn(`Failed to inspect tabs before update restart: ${e}`);
    return true;
  }
}

/** On Windows the updater plugin starts the installer and ends the process inside `install()` (tauri-plugin-updater `install_inner` calls `std::process::exit`), so nothing after it runs. */
function installEndsProcess(): boolean {
  return platform() === "windows";
}

async function installUpdate(update: Update, signal: AbortSignal) {
  const accepted = await ask(t("Updater.Available", { version: update.version }), {
    title: t("Updater.Title"),
    kind: "info",
  });
  if (!accepted || signal.aborted) return;

  const reportInstallFailure = (e: unknown) => {
    if (signal.aborted) return;
    warn(`Failed to install update ${update.version}: ${e}`);
    notifications.show({
      color: "danger",
      title: t("Updater.InstallFailed"),
      message: String(e),
    });
  };

  try {
    await update.download();
  } catch (e) {
    reportInstallFailure(e);
    return;
  }
  if (signal.aborted) return;
  if (installEndsProcess() && shouldDeferUpdateRestart()) {
    notifications.show({
      color: "warning",
      title: t("Updater.Postponed"),
      message: t("Updater.SaveToInstall", { version: update.version }),
      autoClose: false,
    });
    return;
  }
  try {
    await update.install();
  } catch (e) {
    reportInstallFailure(e);
    return;
  }
  // The plugin API takes no AbortSignal, so an install that settles after unmount is only
  // prevented from relaunching; the transfer itself is not cancelled.
  if (signal.aborted) return;
  if (shouldDeferUpdateRestart()) {
    notifications.show({
      color: "success",
      title: t("Updater.Installed"),
      message: t("Updater.RestartToApply", { version: update.version }),
      autoClose: false,
    });
    return;
  }
  await relaunch();
}

function closeUpdate(update: Update | null) {
  if (!update) return;
  void update.close().catch((e) => warn(`Failed to release update handle: ${e}`));
}

/** Runs after the window reveal and the startup sequence settled and never blocks the reveal;
 * every failure ends in `warn`. */
async function checkForAppUpdate(signal: AbortSignal) {
  let update: Update | null;
  let pendingUpdate: Promise<Update | null> | undefined;
  try {
    pendingUpdate = check();
    update = await withTimeout(pendingUpdate, UPDATE_CHECK_TIMEOUT_MS);
  } catch (e) {
    // The plugin check cannot be cancelled. Release any handle delivered after timeout,
    // and consume a late rejection even after startup has unmounted.
    void pendingUpdate?.then(closeUpdate, () => undefined);
    if (!signal.aborted) warn(`Update check failed: ${e}`);
    return;
  }
  if (!update) return;
  try {
    if (!signal.aborted) await installUpdate(update, signal);
  } catch (e) {
    if (!signal.aborted) warn(`Update failed: ${e}`);
  } finally {
    closeUpdate(update);
  }
}

export function useAppStartup() {
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const controller = new AbortController();
    const { signal } = controller;
    const startupSequence = async () => {
      // The native window stays hidden until this reveal (the window-state plugin does not
      // restore visibility). Reveal as soon as the shell has committed, before the slow
      // startup steps, and without a frame callback: a hidden webview may never fire one.
      // The invoke is issued synchronously in this effect, so it runs exactly once per startup.
      // A refused reveal is logged and startup continues; the native fallback in setup shows
      // the window if the reveal was never recorded. The log is `warnSafely`: when IPC is
      // degraded the logger rejects too, and the diagnostic must still reach the console.
      try {
        await tauri.closeSplashscreen();
      } catch (error) {
        warnSafely(`Failed to reveal the main window: ${String(error)}`);
      }
      if (signal.aborted) return;

      await initializePathOwners().catch((error) =>
        warn(`Path owner reconciliation failed: ${String(error)}`),
      );
      if (signal.aborted) return;

      info("React app started successfully");

      // Command-line arguments never reach the renderer: a game link the process was started
      // with is parsed natively and taken by `useIncomingGameLinks`.
      await preloadReferenceDb(getDefaultStore(), signal);
    };

    void startupSequence()
      .catch((startupError) => warn(`Application startup failed: ${String(startupError)}`))
      .then(() => {
        if (signal.aborted) return undefined;
        return checkForAppUpdate(signal);
      });

    return () => {
      controller.abort();
    };
  }, []);
}

export default function App() {
  const pieceSet = useAtomValue(pieceSetAtom);
  const fontSize = useAtomValue(fontSizeAtom);
  const pieceSize = useAtomValue(pieceSizeAtom);
  const spellCheck = useAtomValue(spellCheckAtom);

  useAppStartup();
  useDocumentLanguage();
  useConversionProgress();
  useDatabaseContentValidation();

  useEffect(() => installNativeContextMenuSuppression(), []);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}%`;
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty("--piece-size", `${pieceSize}%`);
  }, [pieceSize]);

  const theme = useMemo(() => createAppTheme({ spellCheck, fontSize }), [spellCheck, fontSize]);

  return (
    <DndProvider backend={HTML5Backend}>
      <link rel="stylesheet" href={`/pieces/${pieceSet}.css`} />

      <MantineProvider
        colorSchemeManager={colorSchemeManager}
        cssVariablesResolver={appCssVariablesResolver}
        defaultColorScheme="dark"
        theme={theme}
      >
        <ThemeVariantSync />
        <ContextMenuProvider>
          <Notifications
            classNames={{ root: fixedNoticeToastRoot, notification: "wrap-anywhere" }}
            notificationMaxHeight={notificationMaxHeight}
            styles={{
              notification: { overflowY: "auto", alignItems: "safe center" },
            }}
          />
          <RouterProvider router={router} />
          <FixedNoticeStack>
            <SessionPersistenceNotice />
            <AutomaticStockfishNotice />
          </FixedNoticeStack>
        </ContextMenuProvider>
      </MantineProvider>
    </DndProvider>
  );
}
