import type { AccountError } from "@/bindings";

const accountErrors: Record<AccountError, true> = {
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
