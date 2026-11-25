import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { createRoot } from "react-dom/client";
import App from "./App";
import i18n, { initializeI18n } from "./i18n";
import { initializePersistedSessions, SessionSanitizationError } from "./utils/session";
import { setAutoFreeze } from "immer";
import { I18nextProvider } from "react-i18next";
import { StartupStorageFailure } from "./components/home/StartupStorageFailure";
import { WorkspaceReadFailure } from "./components/home/WorkspaceReadFailure";
import { WorkspaceReadError } from "./state/workspace";
import { sanitizeRevocationReasons } from "./utils/lichess/revocation";
import { logFailureSafely, safeFailureContext } from "./platform/errors";
import { tauri } from "./platform/tauri";
import { initializeWorkspace } from "./state/atoms";
import { initializePathOwners } from "./state/pathOwners";
import { initializeEngineCompletions } from "./state/engineCompletions";
import { initializeDownloadFailures } from "./hooks/downloadJobs";

let applicationStartup: Promise<void> | undefined;

const WINDOW_REVEAL_FAILURE = "StartupWindowRevealError";

function logStartupDiagnostic(
  operation: string,
  diagnostic: string,
  fallbackLabel: string,
): Promise<void> {
  return logFailureSafely(
    diagnostic,
    { operation, primaryFailure: { category: "unexpected", message: diagnostic } },
    fallbackLabel,
  );
}

async function closeSplashscreenSafely(): Promise<void> {
  try {
    await tauri.closeSplashscreen();
  } catch {
    await logStartupDiagnostic(
      "closeSplashscreen",
      WINDOW_REVEAL_FAILURE,
      "Startup window reveal failed",
    );
  }
}

/** Do not mount feature routes until credential-bearing legacy storage has been scrubbed and
 * native account metadata has reconciled into public renderer sessions. */
export function startApplication(): Promise<void> {
  if (applicationStartup) return applicationStartup;
  try {
    localStorage.removeItem("mantine-primary-color");
  } catch {
    // The retired appearance preference must never block startup when storage is refused.
  }
  dayjs.extend(customParseFormat);
  setAutoFreeze(false);
  applicationStartup = (async () => {
    const workspaceSession = await import("./state/workspaceSession");
    try {
      await workspaceSession.restoreWorkspaceSessionAtStart();
    } catch (error) {
      workspaceSession.markWorkspaceSessionRestoreFailed(error);
      await logFailureSafely(
        "StartupWorkspaceSessionRestoreError",
        {
          operation: "restoreWorkspaceSessionAtStart",
          primaryFailure: safeFailureContext(error),
        },
        "Workspace session restore failed",
      );
    }
    let workspaceReadFailure = false;
    try {
      initializeWorkspace();
    } catch (error) {
      if (!(error instanceof WorkspaceReadError)) {
        applicationStartup = undefined;
        throw error;
      }
      workspaceReadFailure = true;
    }
    const container = document.getElementById("app");
    const root = createRoot(container!);
    if (workspaceReadFailure) {
      try {
        await initializeI18n();
      } catch {
        // The refusal screen also renders with its shipped English fallback.
      }
      root.render(
        <I18nextProvider i18n={i18n}>
          <WorkspaceReadFailure />
        </I18nextProvider>,
      );
      await closeSplashscreenSafely();
      return;
    }
    try {
      await tauri.releasePreviousDocumentOperations();
    } catch (error) {
      const primaryFailure = safeFailureContext(error);
      await logFailureSafely(
        `StartupReservationReleaseError: ${primaryFailure.category}: ${primaryFailure.message}`,
        { operation: "releasePreviousDocumentOperations", primaryFailure },
        "Startup reservation release failed",
      );
    }

    let sanitizationFailure: SessionSanitizationError | undefined;
    try {
      // Bootstrap publishes its safe document owner even when the public save is unsaved.
      // App exposes that recoverable status and retries the latest list without another startup.
      await initializePersistedSessions();
    } catch (error) {
      if (error instanceof SessionSanitizationError) sanitizationFailure = error;
      // Other failures happen after storage has been synchronously sanitized. The application
      // remains usable while the next launch retries native reconciliation.
    }

    try {
      await initializeI18n();
    } catch {
      // Rendering remains available if a locale bundle cannot be loaded on this launch.
    }

    if (sanitizationFailure) {
      const { legacySignInFound, allRevoked } = sanitizationFailure;
      const unresolvedReasons = sanitizeRevocationReasons(sanitizationFailure.unresolvedReasons);
      root.render(
        <I18nextProvider i18n={i18n}>
          <StartupStorageFailure
            legacySignInFound={legacySignInFound}
            allRevoked={allRevoked}
            unresolvedReasons={unresolvedReasons}
          />
        </I18nextProvider>,
      );
      await closeSplashscreenSafely();
      // Only the class and public summary may leave this credential-handling boundary.
      const diagnostic = `SessionSanitizationError: legacySignInFound=${legacySignInFound}, allRevoked=${allRevoked}, unresolvedReasons=${unresolvedReasons.join(",")}`;
      await logStartupDiagnostic(
        "initializePersistedSessions",
        diagnostic,
        "Session sanitization failed",
      );
      return;
    }

    try {
      await initializeDownloadFailures();
    } catch (error) {
      await logFailureSafely(
        "StartupDownloadFailureObserverError",
        {
          operation: "initializeDownloadFailures",
          primaryFailure: safeFailureContext(error),
        },
        "Download failure recovery failed",
      );
    }

    try {
      await initializePathOwners();
      await initializeEngineCompletions();
    } catch (error) {
      await logFailureSafely(
        "StartupEngineCompletionError",
        {
          operation: "initializeEngineCompletions",
          primaryFailure: safeFailureContext(error),
        },
        "Engine completion recovery failed",
      );
    }

    root.render(
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );
  })();
  return applicationStartup;
}
