import type { PageTab } from "@/state/pageTabs";

export function normalizeAppPath(pathname: string): string {
    return pathname.replace(/\/+$/, "") || "/";
}

export function isBoardsPath(pathname: string): boolean {
    return normalizeAppPath(pathname) === "/";
}

export function isLibraryFamilyPath(pathname: string): boolean {
    const path = normalizeAppPath(pathname);
    return path === "/library" || path === "/databases" || path.startsWith("/databases/");
}

export function pageTabOf(pathname: string): PageTab | null {
    const path = normalizeAppPath(pathname);
    if (path === "/settings" || path.startsWith("/settings/")) return "settings";
    if (path === "/accounts" || path.startsWith("/accounts/")) return "accounts";
    if (path === "/engines" || path.startsWith("/engines/")) return "engines";
    if (path === "/guide" || path.startsWith("/guide/")) return "guide";
    return null;
}

export type ReturnTarget =
    | { to: "/" }
    | { to: "/library" }
    | { to: "/databases/$databaseId"; params: { databaseId: string } };

export function returnTargetFromPath(pathname: string): ReturnTarget {
    const path = normalizeAppPath(pathname);
    if (path === "/library" || path === "/databases") return { to: "/library" };
    const database = /^\/databases\/([^/]+)$/.exec(path);
    if (database) {
        return { to: "/databases/$databaseId", params: { databaseId: database[1] } };
    }
    return { to: "/" };
}

export function boardTabId(tabId: string): string {
    return `board-tab-${tabId}`;
}

export function boardTabPanelId(tabId: string): string {
    return `board-tab-panel-${tabId}`;
}
