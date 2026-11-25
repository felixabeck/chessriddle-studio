import type { AccountError, LibrarySyncError } from "@/bindings";

export function requiresChessRiddleConnection(error: AccountError | null): boolean {
    return error === "notConnected" || error === "authentication" || error === "invalidGrant";
}

const accountErrors: Record<AccountError, true> = {
    noMatch: true,
    notConnected: true,
    dailyLimit: true,
    updateRequired: true,
    invalidRequest: true,
    submissionInProgress: true,
    engineTimeout: true,
    engineBusy: true,
    engineUnavailable: true,
    unavailable: true,
    busy: true,
    storage: true,
    network: true,
    rateLimited: true,
    server: true,
    invalidGrant: true,
    authentication: true,
    invalidLink: true,
    browser: true,
    alreadyConnected: true,
};

/** Only the native closed error vocabulary crosses this account boundary. */
export class ChessRiddleCommandError extends Error {
    readonly code: AccountError;

    constructor(cause: unknown) {
        const value = cause instanceof Error ? cause.message : cause;
        const code =
            typeof value === "string" && Object.hasOwn(accountErrors, value)
                ? (value as AccountError)
                : "server";
        super(code);
        this.name = "ChessRiddleCommandError";
        this.code = code;
    }
}

const librarySyncErrors: Record<LibrarySyncError, true> = {
    unavailable: true,
    busy: true,
    localStorage: true,
    invalidWorkspace: true,
    notActive: true,
};

/** Only the native closed error vocabulary crosses the Library sync boundary. */
export class LibrarySyncCommandError extends Error {
    readonly code: LibrarySyncError;

    constructor(cause: unknown) {
        const value = cause instanceof Error ? cause.message : cause;
        const code =
            typeof value === "string" && Object.hasOwn(librarySyncErrors, value)
                ? (value as LibrarySyncError)
                : "unavailable";
        super(code);
        this.name = "LibrarySyncCommandError";
        this.code = code;
    }
}
