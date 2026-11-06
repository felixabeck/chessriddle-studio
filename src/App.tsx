import { localStorageColorSchemeManager, MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import i18n from "@/i18n";
import { ask, check, getMatches, info, relaunch, type Update, warn } from "@/platform/native";
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
} from "./state/atoms";

import "@/styles/chessgroundBaseOverride.css";
import "@/styles/chessgroundColorsOverride.css";

import "@mantine/charts/styles.css";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/tiptap/styles.css";

import "mantine-contextmenu/styles.css";
import "mantine-datatable/styles.css";

import "@/styles/global.css";

import { tauri } from "./platform/tauri";

const colorSchemeManager = localStorageColorSchemeManager({
  key: "mantine-color-scheme",
});

const notificationMaxHeight = "calc(100dvh - 2 * var(--mantine-spacing-md))";

import ErrorComponent from "@/components/ErrorComponent";
import { useConversionProgress } from "@/hooks/useConversionProgress";
import { useDatabaseContentValidation } from "@/hooks/useDatabaseContentValidation";
import { useDocumentLanguage } from "@/hooks/useDocumentLanguage";
import { routeTree } from "./routeTree.gen";
import { appCssVariablesResolver, createAppTheme } from "./styles/theme";
import { initializePathOwners } from "./state/pathOwners";
import { SessionPersistenceNotice } from "./components/home/SessionPersistenceNotice";
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

async function installUpdate(update: Update, signal: AbortSignal) {
  const accepted = await ask(t("Updater.Available", { version: update.version }), {
    title: t("Updater.Title"),
    kind: "info",
  });
  if (!accepted || signal.aborted) return;
  try {
    await update.downloadAndInstall();
  } catch (e) {
    if (signal.aborted) return;
    warn(`Failed to install update ${update.version}: ${e}`);
    notifications.show({
      color: "danger",
      title: t("Updater.InstallFailed"),
      message: String(e),
    });
    return;
  }
  // The plugin API takes no AbortSignal, so an install that settles after unmount is only
  // prevented from relaunching; the transfer itself is not cancelled.
  if (signal.aborted) return;
  await relaunch();
}

/** Runs after the splash is closed and never blocks it; every failure ends in `warn`. */
async function checkForAppUpdate(signal: AbortSignal) {
  let update: Update | null;
  try {
    update = await withTimeout(check(), UPDATE_CHECK_TIMEOUT_MS);
  } catch (e) {
    if (!signal.aborted) warn(`Update check failed: ${e}`);
    return;
  }
  if (!update) return;
  try {
    if (!signal.aborted) await installUpdate(update, signal);
  } catch (e) {
    if (!signal.aborted) warn(`Update failed: ${e}`);
  } finally {
    void update.close().catch((e) => warn(`Failed to release update handle: ${e}`));
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
      try {
        await initializePathOwners().catch((error) =>
          warn(`Path owner reconciliation failed: ${String(error)}`),
        );
        if (signal.aborted) return;

        info("React app started successfully");

        const store = getDefaultStore();
        try {
          const matches = await getMatches();
          if (matches.args.file.occurrences > 0) {
            info(`Opening file from command line: ${matches.args.file.value}`);
            // CLI paths are intentionally not forwarded into the renderer. Use the native
            // capability picker so the backend can issue an opaque handle instead.
          }
        } catch (e) {
          warn(`Failed to parse CLI args: ${e}`);
        }

        await preloadReferenceDb(store, signal);
      } finally {
        if (!signal.aborted) await tauri.closeSplashscreen();
      }
    };

    void startupSequence()
      .catch((startupError) => warn(`Application startup failed: ${String(startupError)}`))
      .then(() => {
        if (!signal.aborted) return checkForAppUpdate(signal);
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
        <ContextMenuProvider>
          <Notifications
            classNames={{ notification: "wrap-anywhere" }}
            notificationMaxHeight={notificationMaxHeight}
            styles={{
              root: { maxHeight: notificationMaxHeight, overflowY: "auto" },
              notification: { overflowY: "auto", alignItems: "safe center" },
            }}
          />
          <RouterProvider router={router} />
          <SessionPersistenceNotice />
        </ContextMenuProvider>
      </MantineProvider>
    </DndProvider>
  );
}
