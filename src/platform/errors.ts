import type {
    EngineTerminalSnapshot,
    ErrorCategory,
    ErrorPayload,
    ErrorPayloadTag,
    RemoteHttpRejection,
    RootFailure,
} from "@/bindings";
import { error as logError, warn as logWarn } from "./native";

export type AppErrorCategory =
    | "cancelled"
    | "network"
    | "not-found"
    | "applied-despite-error"
    | "permission"
    | "validation"
    | "unexpected";

export type AppError = {
    category: AppErrorCategory;
    message: string;
    diagnostic?: string;
    backendCategory?: ErrorCategory;
    rootFailure?: RootFailure;
    engineFailure?: EngineTerminalSnapshot;
    remoteHttpRejection?: RemoteHttpRejection;
    nameTaken?: true;
    databaseAdmission?: true;
    databaseBusy?: true;
    chessBaseDatabase?: true;
    progress_generation?: string;
};

const reportedErrors = new WeakSet<object>();

/** Transfers reporting ownership without altering or retaining the rejected error. */
export function markErrorReported(error: unknown): void {
    if (typeof error === "object" && error !== null) reportedErrors.add(error);
}

export function isErrorReported(error: unknown): boolean {
    return typeof error === "object" && error !== null && reportedErrors.has(error);
}

const APP_ERROR_CATEGORIES: readonly AppErrorCategory[] = [
    "cancelled",
    "network",
    "not-found",
    "applied-despite-error",
    "permission",
    "validation",
    "unexpected",
];

const BACKEND_CATEGORY: Record<ErrorCategory, AppErrorCategory> = {
    io: "unexpected",
    parsing: "validation",
    platform: "unexpected",
    network: "network",
    "chess-data": "validation",
    database: "unexpected",
    "invalid-input": "validation",
    "stale-game": "validation",
    "missing-resource": "not-found",
    conflict: "validation",
    "resource-limit": "validation",
    authentication: "permission",
    credential: "permission",
    cancellation: "cancelled",
    durability: "applied-despite-error",
    "partial-removal": "applied-despite-error",
    "operation-and-cleanup": "unexpected",
    "engine-timeout": "unexpected",
    "engine-position-rejected": "validation",
    "engine-retired": "validation",
    "engine-failure": "unexpected",
    permission: "permission",
    "puzzle-themes-unavailable": "not-found",
};

const BACKEND_TAG: Record<ErrorPayloadTag, true> = {
    "backend-error": true,
    "engine-failure": true,
};

const FEN_BOARD_PATTERN = /[rnbqkpRNBQKP1-8]+(?:\/[rnbqkpRNBQKP1-8]+){1,7}/g;
const PGN_DRAW_PATTERN = /1\/2-1\/2/g;
const PREFIX_SECRET_PATTERN = /(bearer\s+|token[=:]\s*|password[=:]\s*)[^\s,;]+/gi;
const JSON_SECRET_PATTERN = /(["'](?:password|token)["']\s*:\s*["'])[^"']+/gi;
const PATH_PATTERN =
    /(?:(?<![A-Za-z])[A-Za-z]:(?:\\|\/)+(?:(?:[^'"\n]*?[\\/])+)?[^'"\s\n]+|\\\\(?:[^'"\n]*?\\)+[^'"\s\n]+|~\/(?:[^/\s'"]+\/)*[^/\s'"]+|(?<![.:/\w])\/(?:[^/\s'"]+\/)+[^/\s'"]*|(?<![.:/\w])\/[^/\s'"]+\.[A-Za-z0-9]{1,24}\b)/g;

function isErrorPayload(value: unknown): value is ErrorPayload {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { tag?: unknown }).tag === "string" &&
        Object.hasOwn(BACKEND_TAG, (value as { tag: string }).tag)
    );
}

function isAppError(value: unknown): value is AppError {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as { category?: unknown; message?: unknown };
    return (
        typeof candidate.message === "string" &&
        typeof candidate.category === "string" &&
        APP_ERROR_CATEGORIES.includes(candidate.category as AppErrorCategory)
    );
}

function errorSource(error: unknown): string {
    if (error instanceof Error || error instanceof DOMException) return error.message;
    if (typeof error === "string") return error;
    return safelyStringify(error);
}

function aggregateErrorSource(error: AggregateError, seen: WeakSet<object>): string {
    if (seen.has(error)) return "[circular]";
    seen.add(error);
    const messages = [
        error.message,
        ...error.errors.map((cause: unknown) =>
            cause instanceof AggregateError
                ? aggregateErrorSource(cause, seen)
                : normalizeError(cause).message,
        ),
    ].filter(Boolean);
    // Keep aggregate failures visible even when every contained cause says Cancellation.
    return `Aggregate error: ${messages.join(" | ") || "Unexpected error"}`;
}

function redactSecrets(value: string): string {
    return value
        .replace(PREFIX_SECRET_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`)
        .replace(JSON_SECRET_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`);
}

function redact(value: string): string {
    const shields: string[] = [];
    const shield = (match: string) => {
        const token = `\u0001SHIELD${shields.length}\u0001`;
        shields.push(match);
        return token;
    };
    const shielded = value.replace(FEN_BOARD_PATTERN, shield).replace(PGN_DRAW_PATTERN, shield);
    let redacted = redactSecrets(shielded).replace(PATH_PATTERN, "[path]");
    for (const [index, original] of shields.entries()) {
        redacted = redacted.replace(`\u0001SHIELD${index}\u0001`, original);
    }
    return redacted;
}

function safelyStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    try {
        return JSON.stringify(value, (_key, current: unknown) => {
            if (typeof current === "object" && current !== null) {
                if (seen.has(current)) return "[circular]";
                seen.add(current);
            }
            return typeof current === "bigint" ? current.toString() : current;
        });
    } catch {
        return String(value);
    }
}

function classify(source: string): AppErrorCategory {
    const lower = source.toLowerCase();
    // Fallback for non-command errors (D-E): a thrown JS Error from the renderer itself,
    // useTauriListener callback failures, and any other non-command rejection. Backend
    // command errors carry ErrorPayload and are mapped through BACKEND_CATEGORY, not this
    // table.
    //
    // `applied-despite-error` means: the destructive change reached the filesystem even though
    // this is an error. It covers both a partial removal and a complete one whose durability
    // could not be confirmed -- which is why it is not called "partially-applied", since the
    // second case removed everything it was asked to.
    //
    // It is tested first, ahead of every other branch, because it is the only category keyed on
    // an exact literal this codebase owns -- the `#[error(...)]` text of `Error::PartialRemoval`
    // and `Error::CommittedDurabilityUncertain` -- while the branches below match generic English
    // words that can appear anywhere in a wrapped cause. A partial removal whose cause reads
    // "connection aborted" or "operation timeout" is still a partial removal, and reporting it as
    // `cancelled` would tell the user nothing happened at the one moment files were destroyed.
    //
    // Rewording either Rust variant silently breaks this. The backend asserts the literals it
    // emits; the table below asserts the literals this side matches. Both are needed -- neither
    // test alone sees the other end of the string. Finding f-20260830-04.
    if (
        lower.includes("partially removed:") ||
        lower.includes("committed but durability uncertain:")
    ) {
        return "applied-despite-error";
    }
    if (lower === "cancellation" || lower.includes("analysis cancelled")) return "cancelled";
    if (lower.includes("connection aborted") || lower.includes("network failure")) {
        return "network";
    }
    if (lower.includes("engine timeout:")) return "unexpected";
    if (
        lower.includes("game not found:") ||
        lower.includes("missing reference database") ||
        lower.includes("no moves found") ||
        lower.includes("no opening found") ||
        lower.includes("no puzzles")
    ) {
        return "not-found";
    }
    if (
        lower.includes("invalid input:") ||
        lower.includes("invalid color:") ||
        lower.includes("conflict:") ||
        lower.includes("resource limit:") ||
        lower.includes("game not in progress") ||
        lower.includes("not human's turn") ||
        lower.includes("not engine's turn") ||
        lower.includes("players aren't the same")
    ) {
        return "validation";
    }
    if (
        lower.includes("oauth failure:") ||
        lower.includes("credential operation failed") ||
        lower.includes("credential operation requires recovery")
    ) {
        return "permission";
    }
    if (lower.includes("cancel") || lower.includes("abort")) return "cancelled";
    if (lower.includes("network") || lower.includes("timeout") || lower.includes("fetch")) {
        return "network";
    }
    if (lower.includes("not found") || lower.includes("missing")) return "not-found";
    if (lower.includes("permission") || lower.includes("denied")) return "permission";
    if (lower.includes("invalid") || lower.includes("validation")) return "validation";
    return "unexpected";
}

export function normalizeError(error: unknown): AppError {
    if (isErrorPayload(error)) {
        const rejection = error.remoteHttpRejection;
        return {
            category: BACKEND_CATEGORY[error.category],
            backendCategory: error.category,
            message: redact(error.message),
            ...(error.nameTaken === true ? { nameTaken: true } : {}),
            ...(error.databaseAdmission === true ? { databaseAdmission: true } : {}),
            ...(error.databaseBusy === true ? { databaseBusy: true } : {}),
            ...(error.chessBaseDatabase === true ? { chessBaseDatabase: true } : {}),
            ...(typeof error.progressGeneration === "string"
                ? { progress_generation: error.progressGeneration }
                : {}),
            ...(typeof rejection === "object" &&
            rejection !== null &&
            typeof rejection.status === "number" &&
            Number.isFinite(rejection.status) &&
            typeof rejection.authorizationSent === "boolean"
                ? {
                      remoteHttpRejection: {
                          status: rejection.status,
                          authorizationSent: rejection.authorizationSent,
                      },
                  }
                : {}),
            ...(error.rootFailure == null ? {} : { rootFailure: error.rootFailure }),
            ...(error.engineFailure == null
                ? {}
                : { engineFailure: safeEngineFailure(error.engineFailure) }),
        };
    }
    if (isAppError(error)) return error;
    if (error instanceof Error) {
        const details = (error as { details?: unknown }).details;
        if (isAppError(details)) return details;
    }
    if (error instanceof AggregateError) {
        return {
            category: "unexpected",
            message: redact(aggregateErrorSource(error, new WeakSet())),
        };
    }
    const source = errorSource(error) || "Unexpected error";
    return { category: classify(source), message: redact(source) };
}

function safeEngineFailure(snapshot: EngineTerminalSnapshot): EngineTerminalSnapshot {
    return {
        ...snapshot,
        reason: snapshot.reason == null ? null : redact(snapshot.reason),
        entries: snapshot.entries.map((entry) =>
            entry.type === "truncated" ? entry : { ...entry, value: redact(entry.value) },
        ),
    };
}

export type SafeFailureContext = {
    category: AppErrorCategory;
    message: string;
    engineFailure?: EngineTerminalSnapshot;
};

/** Normalizes and re-redacts a failure before it can reach logs or fallback context. */
export function safeFailureContext(cause: unknown): SafeFailureContext {
    const normalized = normalizeError(cause);
    return {
        category: normalized.category,
        message: redact(normalized.message),
        ...(normalized.engineFailure == null
            ? {}
            : { engineFailure: safeEngineFailure(normalized.engineFailure) }),
    };
}

export type GameFailureContext = {
    tabId: string;
    generation: number;
    gameId?: string;
    session?: string;
};

export type FailureLogContext = {
    operation: string;
    primaryFailure: SafeFailureContext;
    itemIndex?: number;
    item?: string;
    game?: GameFailureContext;
};

/** Logs a sanitized failure and handles native logger rejection with a sanitized console fallback. */
export async function logFailureSafely(
    message: string,
    context: FailureLogContext,
    fallbackLabel: string,
): Promise<void> {
    try {
        await logError(message);
    } catch (loggingCause) {
        console.error(fallbackLabel, {
            ...context,
            loggerFailure: safeFailureContext(loggingCause),
        });
    }
}

/** Reports a warning through the native log and keeps it on the console if the native logger rejects. */
export function warnSafely(message: string): void {
    void logWarn(message).catch((loggingCause: unknown) =>
        console.warn(message, { loggerFailure: safeFailureContext(loggingCause) }),
    );
}

export function errorUnlessCancelled(error: unknown): AppError | null {
    const normalized = normalizeError(error);
    // Pinned IPC Display of `Error::Cancellation` (`d-20260830-05`). Do not use
    // the substring taxonomy: "connection aborted" is a real failure
    // (`f-20260830-28`).
    return normalized.message === "Cancellation" ? null : normalized;
}

export async function runDestructiveWithRefresh<T>(
    run: () => Promise<T>,
    refresh: () => void | Promise<void>,
): Promise<T> {
    try {
        const result = await run();
        await refresh();
        return result;
    } catch (cause) {
        if (normalizeError(cause).category === "applied-despite-error") {
            try {
                await refresh();
            } catch {
                // A refresh failure must not replace the destructive outcome.
            }
            throw cause;
        }
        throw cause;
    }
}

export function isOperationAndCleanup(error: unknown): boolean {
    return normalizeError(error).backendCategory === "operation-and-cleanup";
}

async function reconcileAndRethrow(
    cause: unknown,
    reconcile: () => unknown | Promise<unknown>,
): Promise<never> {
    try {
        await reconcile();
    } catch {
        // Reconciliation cannot replace the original operation and cleanup failure.
    }
    throw cause;
}

export async function runAppliedMutationWithRefresh<T>(
    run: () => Promise<T>,
    refresh: (cleanupFailure?: unknown) => unknown | Promise<unknown>,
): Promise<T | undefined> {
    try {
        const result = await run();
        await refresh();
        return result;
    } catch (cause) {
        if (isOperationAndCleanup(cause)) return reconcileAndRethrow(cause, () => refresh(cause));
        if (normalizeError(cause).category !== "applied-despite-error") throw cause;
        try {
            await refresh();
        } catch {
            throw cause;
        }
        return undefined;
    }
}

export async function runWithAppliedRecovery<T>(
    run: () => Promise<T>,
    recover: () => Promise<T | undefined>,
    reconcile?: () => unknown | Promise<unknown>,
): Promise<T> {
    try {
        return await run();
    } catch (cause) {
        if (isOperationAndCleanup(cause) && reconcile) return reconcileAndRethrow(cause, reconcile);
        if (normalizeError(cause).category !== "applied-despite-error") throw cause;
        try {
            const recovered = await recover();
            if (recovered !== undefined) return recovered;
        } catch {
            throw cause;
        }
        throw cause;
    }
}
