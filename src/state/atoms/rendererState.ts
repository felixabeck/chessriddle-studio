/** Document-wide renderer initialization and the eagerly hydrated preference atoms it owns. */
import { createDocumentStorageAtoms } from "../utils";
import { initializeOriginalPathOwners } from "../pathOwners";

export const documentPreferences = createDocumentStorageAtoms(initializeRendererState);
let rendererStateInitialized = false;

/** Establish the document's original owners and eager preferences before hydration or cleanup. */
export function initializeRendererState() {
    if (rendererStateInitialized) return;
    initializeOriginalPathOwners();
    // Legacy renderer-visible directories are scrubbed, never migrated into opaque authority.
    // Retired borrowed PostHog telemetry is scrubbed the same way: never migrated.
    if (typeof localStorage !== "undefined") {
        localStorage.removeItem("document-dir");
        localStorage.removeItem("telemetry-enabled");
        localStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog");
        localStorage.removeItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z");
    }
    if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog");
        sessionStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id");
    }
    if (typeof document !== "undefined") {
        const expired =
            "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        document.cookie = expired;
        document.cookie = `${expired}; Domain=.tauri.localhost`;
        document.cookie = `${expired}; Domain=.localhost`;
        document.cookie = `${expired}; Domain=tauri.localhost`;
    }
    documentPreferences.initialize();
    rendererStateInitialized = true;
}
