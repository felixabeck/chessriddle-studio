import {
    type ClockUpdateEvent,
    commands,
    events,
    type GameConfig,
    type GameMoveEvent,
    type GameOverEvent,
    type GameState,
    type OpeningBookConfig,
    type ProgressEvent as WireProgressEvent,
    type Result as GeneratedResult,
    type TimeControl,
} from "@/bindings/generated";
import type { ProgressEvent, ProgressItem } from "@/bindings";
import { normalizeError } from "./errors";
import { ChessRiddleCommandError } from "./chessriddle";
import { error as logError, getCurrentWindow } from "./native";

const MAX_SAFE_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);
const CHESSRIDDLE_COMMANDS = new Set<PropertyKey>([
    "chessriddleTrainingAvailable",
    "chessriddleTrainingNext",
    "chessriddleMistakeCount",
    "chessriddleTrainingSubmit",
    "chessriddleOpenUpgrade",
    "chessriddleOpenWebsite",
    "chessriddleTrainingSettings",
    "chessriddleSaveTrainingSettings",
    "chessriddleTrainingMotifs",
    "chessriddleAccount",
    "connectChessriddle",
    "disconnectChessriddle",
]);

type GameCounterFields = Pick<GameState, "session" | "revision">;
type GameCounterWireInput<T extends GameCounterFields> = Omit<T, keyof GameCounterFields> & {
    [Field in keyof GameCounterFields]: number | GameCounterFields[Field];
};

export type GameConfigInput = Omit<
    GameConfig,
    "whiteTimeControl" | "blackTimeControl" | "openingBook"
> & {
    whiteTimeControl: NumericTimeControl | null;
    blackTimeControl: NumericTimeControl | null;
    openingBook: NumericOpeningBookConfig | null;
};

type NumericTimeControl = Omit<TimeControl, "initialTime" | "increment"> & {
    initialTime: number;
    increment: number;
};

type NumericOpeningBookConfig = Omit<OpeningBookConfig, "maxPly"> & {
    maxPly?: number;
};

export function decodeCounter(value: unknown, field: string): bigint {
    if (typeof value === "bigint") {
        if (value >= 0 && value <= MAX_SAFE_COUNTER) return value;
    } else if (typeof value === "number") {
        if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    }
    throw new TypeError(`${field} must be a nonnegative safe integer`);
}

export function encodeCounter(value: bigint, field: string): number {
    if (typeof value !== "bigint" || value < 0 || value > MAX_SAFE_COUNTER) {
        throw new TypeError(`${field} must be a nonnegative safe integer`);
    }
    return Number(value);
}

export function normalizeGameState(value: GameCounterWireInput<GameState>): GameState {
    return normalizeCounterPair(value);
}

export function normalizeGameMoveEvent(value: GameCounterWireInput<GameMoveEvent>): GameMoveEvent {
    return normalizeCounterPair(value);
}

export function normalizeClockUpdateEvent(
    value: GameCounterWireInput<ClockUpdateEvent>,
): ClockUpdateEvent {
    return normalizeCounterPair(value);
}

export function normalizeGameOverEvent(value: GameCounterWireInput<GameOverEvent>): GameOverEvent {
    return normalizeCounterPair(value);
}

function normalizeCounterPair<T extends GameCounterFields>(
    value: GameCounterWireInput<T>,
): Omit<T, keyof GameCounterFields> & GameCounterFields {
    return {
        ...value,
        session: decodeCounter(value.session, "session"),
        revision: decodeCounter(value.revision, "revision"),
    };
}

const MAX_PROGRESS_GENERATION = 18446744073709551615n;

function decodeProgressGeneration(value: unknown): bigint {
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20) {
        const generation = BigInt(value);
        if (generation <= MAX_PROGRESS_GENERATION) return generation;
    }
    throw new TypeError("generation must be a canonical unsigned u64 decimal string");
}

function normalizeProgressGeneration<T extends { generation: string }>(
    value: T,
): Omit<T, "generation"> & { generation: bigint } {
    return { ...value, generation: decodeProgressGeneration(value.generation) };
}

type CommandResult<T> = GeneratedResult<T, unknown>;

type SuccessResult<T> = Extract<T, { status: "ok" }>;
type UnwrapResult<T> = [SuccessResult<T>] extends [never]
    ? T
    : SuccessResult<T> extends { data: infer Value }
      ? Awaited<Value>
      : T;
type FacadeCommand<T> = T extends (...args: any[]) => Promise<any>
    ? (...args: Parameters<T>) => Promise<UnwrapResult<Awaited<ReturnType<T>>>>
    : never;
type GeneratedCommands = {
    [Name in keyof typeof commands]: FacadeCommand<(typeof commands)[Name]>;
};
export type NativeReadOptions = { signal?: AbortSignal };
type NativeReadCommandName =
    | "searchPosition"
    | "getPlayersGameInfo"
    | "preloadReferenceDb"
    | "getGames"
    | "getDbGame"
    | "getPlayers"
    | "getTournaments"
    | "listWorkspaceDatabases"
    | "getPuzzle"
    | "listPuzzleDatabases"
    | "getPuzzleThemes"
    | "getThemesForPuzzle"
    | "countPgnGames"
    | "fileRevision"
    | "readGame"
    | "readGames"
    | "lexPgn"
    | "listFileWorkspace"
    | "listWorkspaceTrash"
    | "listLinkedCollections"
    | "resolveLinkedGame"
    | "collectionForDatabase";
type NativeReadFacade<T> = T extends (
    ...args: [...infer Args, string | null]
) => Promise<infer Result>
    ? (...args: [...Args, NativeReadOptions?]) => Promise<Result>
    : never;
type TauriCommands = Omit<
    GeneratedCommands,
    "startGame" | NativeReadCommandName | "getProgress" | "failedProgressSnapshot" | "clearProgress"
> & {
    getProgress: (id: string) => Promise<ProgressItem | null>;
    failedProgressSnapshot: () => Promise<ProgressItem[]>;
    clearProgress: (id: string) => Promise<bigint>;
    startGame: (
        gameId: string,
        config: GameConfigInput,
    ) => ReturnType<GeneratedCommands["startGame"]>;
} & {
    [Name in NativeReadCommandName]: NativeReadFacade<GeneratedCommands[Name]>;
} & {
    prepareAnalysis: (tab: string, options?: NativeReadOptions) => Promise<string>;
};

const NATIVE_READ_ARITY: Readonly<Record<NativeReadCommandName, number>> = {
    searchPosition: 3,
    getPlayersGameInfo: 3,
    preloadReferenceDb: 1,
    getGames: 2,
    getDbGame: 3,
    getPlayers: 2,
    getTournaments: 2,
    listWorkspaceDatabases: 1,
    getPuzzle: 4,
    listPuzzleDatabases: 0,
    getPuzzleThemes: 1,
    getThemesForPuzzle: 2,
    countPgnGames: 1,
    fileRevision: 1,
    readGame: 2,
    readGames: 3,
    lexPgn: 1,
    listFileWorkspace: 1,
    listWorkspaceTrash: 2,
    listLinkedCollections: 1,
    resolveLinkedGame: 3,
    collectionForDatabase: 1,
};

const EXPECTED_SESSION_COMMANDS = new Set<PropertyKey>([
    "getGameState",
    "makeGameMove",
    "takeBackGameMove",
    "resignGame",
    "abortGame",
    "getGameEngineLogs",
]);
const DOWNLOAD_SINCE_MS_ARGUMENTS = new Map<PropertyKey, number>([
    ["downloadLichessGames", 4],
    ["downloadChessComGames", 3],
]);
const GAME_STATE_COMMANDS = new Set<PropertyKey>([
    "startGame",
    "getGameState",
    "makeGameMove",
    "takeBackGameMove",
    "resignGame",
]);

type EventEnvelope<T> = { payload: T };
type EventAdapterError<T> = (error: unknown, event: EventEnvelope<T>) => void;

function eventSubscription<T, Wire = T>(
    subscribe: (callback: (event: EventEnvelope<Wire>) => void) => Promise<() => void>,
    normalize: (payload: Wire) => T,
) {
    return (callback: (event: EventEnvelope<T>) => void, onError?: EventAdapterError<T>) =>
        subscribe((event) => {
            try {
                callback({ ...event, payload: normalize(event.payload) });
            } catch (error) {
                onError?.(normalizeError(error), event as unknown as EventEnvelope<T>);
            }
        });
}

export class TauriCommandError extends Error {
    readonly details;

    constructor(error: unknown) {
        const details = normalizeError(error);
        super(details.message);
        this.name = "TauriCommandError";
        this.details = details;
    }
}

export function unwrapCommand<T>(result: CommandResult<T>): T {
    if (result.status === "ok") return result.data;
    throw new TauriCommandError(result.error);
}

function isCommandResult(value: unknown): value is CommandResult<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        ((value as { status?: unknown }).status === "ok" ||
            (value as { status?: unknown }).status === "error")
    );
}

export function cancellationError(): TauriCommandError {
    return new TauriCommandError({
        tag: "backend-error",
        category: "cancellation",
        message: "Cancellation",
    });
}

async function logCleanupFailure(command: PropertyKey, ticket: string, cause: unknown) {
    const message = `native ${String(command)} cleanup failed (${ticket}): ${normalizeError(cause).message}`;
    try {
        await logError(message);
    } catch (loggingError) {
        console.error(
            `Native ${String(command)} cleanup logging failed (${ticket})`,
            normalizeError(loggingError),
        );
    }
}

async function withPreparedTicket<T>({
    signal,
    operation,
    prepare,
    cancel,
    continuation,
}: {
    signal?: AbortSignal;
    operation: PropertyKey;
    prepare: () => Promise<CommandResult<string>>;
    cancel: (ticket: string) => Promise<CommandResult<unknown>>;
    continuation: (ticket: string) => Promise<T>;
}): Promise<T> {
    if (signal?.aborted) throw cancellationError();

    let ticket: string | undefined;
    let aborted = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
        const cleanupTicket = ticket;
        if (!cleanupTicket) return Promise.resolve();
        cleanupPromise ??= (async () => {
            try {
                unwrapCommand(await cancel(cleanupTicket));
            } catch (error) {
                await logCleanupFailure(operation, cleanupTicket, error);
            }
        })();
        return cleanupPromise;
    };
    const onAbort = () => {
        aborted = true;
        void cleanup();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        ticket = unwrapCommand(await prepare());
        if (aborted || signal?.aborted) {
            await cleanup();
            throw cancellationError();
        }
        let result: T;
        try {
            result = await continuation(ticket);
        } catch (error) {
            await cleanup();
            throw error;
        }
        if (aborted || signal?.aborted) {
            await cleanup();
            throw cancellationError();
        }
        return result;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}

export function withDownloadTicket<T>(continuation: (ticket: string) => Promise<T>): Promise<T> {
    return withPreparedTicket({
        operation: "download",
        prepare: () => commands.prepareDownload(),
        cancel: (ticket) => commands.releaseDownload(ticket),
        continuation,
    });
}

/** The owner requests conversion cancellation separately. No abort signal may override settlement. */
export function withConversionTicket<T>(continuation: (ticket: string) => Promise<T>): Promise<T> {
    return withPreparedTicket({
        operation: "conversion",
        prepare: () => commands.prepareConversion(),
        cancel: (ticket) => commands.releaseConversion(ticket),
        continuation,
    });
}

async function invokeNativeRead(
    commandName: PropertyKey,
    command: (...args: unknown[]) => Promise<unknown>,
    args: unknown[],
    options: NativeReadOptions | undefined,
): Promise<unknown> {
    const signal = options?.signal;
    if (!signal) return command(...args, null);
    return withPreparedTicket({
        signal,
        operation: commandName,
        prepare: () => commands.prepareNativeRead(),
        cancel: (ticket) => commands.cancelNativeRead(ticket),
        continuation: async (ticket) => {
            const result = await command(...args, ticket);
            return isCommandResult(result) ? unwrapCommand(result) : result;
        },
    });
}

async function prepareAnalysis(
    tab: string,
    options: NativeReadOptions | undefined,
): Promise<string> {
    return withPreparedTicket({
        signal: options?.signal,
        operation: "prepareAnalysis",
        prepare: () => commands.prepareAnalysis(tab),
        cancel: (ticket) => commands.cancelAnalysis(ticket),
        continuation: async (ticket) => ticket,
    });
}

/**
 * The only renderer boundary that imports generated Tauri commands and events.
 * Commands always either resolve with their successful payload or reject with a
 * normalized, redacted `TauriCommandError`.
 */
export const tauri: TauriCommands = new Proxy(commands, {
    get(target, property, receiver) {
        const command = Reflect.get(target, property, receiver);
        if (typeof command !== "function") return command;
        return async (...args: unknown[]) => {
            // WebKit seals `__TAURI_INTERNALS__.invoke` (non-writable, non-configurable;
            // measured 2026-09-25). verify:app times reads and lexing through optional hooks.
            const readStartedAt = property === "readGame" ? performance.now() : 0;
            const lexStartedAt = property === "lexPgn" ? performance.now() : 0;
            const readFileId =
                property === "readGame"
                    ? (args[0] as { id?: { id?: string } } | undefined)?.id?.id
                    : undefined;
            try {
                if (property === "prepareAnalysis") {
                    return await prepareAnalysis(
                        args[0] as string,
                        args[1] as NativeReadOptions | undefined,
                    );
                }
                if (property in NATIVE_READ_ARITY) {
                    const name = property as NativeReadCommandName;
                    const arity = NATIVE_READ_ARITY[name];
                    const options =
                        args.length > arity ? (args.pop() as NativeReadOptions) : undefined;
                    const result = await invokeNativeRead(property, command, args, options);
                    return isCommandResult(result) ? unwrapCommand(result) : result;
                }
                if (EXPECTED_SESSION_COMMANDS.has(property)) {
                    args[1] = encodeCounter(args[1] as bigint, "expectedSession");
                }
                const sinceMsIndex = DOWNLOAD_SINCE_MS_ARGUMENTS.get(property);
                if (property === "importAccountGames") {
                    const request = args[0] as import("@/bindings").AccountImportRequest;
                    args[0] = {
                        ...request,
                        sinceMs:
                            request.sinceMs === null
                                ? null
                                : encodeCounter(request.sinceMs, "sinceMs"),
                    };
                }
                if (sinceMsIndex !== undefined && args[sinceMsIndex] !== null) {
                    args[sinceMsIndex] = encodeCounter(args[sinceMsIndex] as bigint, "sinceMs");
                }
                const result = await command(...args);
                if (CHESSRIDDLE_COMMANDS.has(property)) {
                    if (isCommandResult(result)) {
                        if (result.status === "error")
                            throw new ChessRiddleCommandError(result.error);
                        return result.data;
                    }
                    return result;
                }
                const value = isCommandResult(result) ? unwrapCommand(result) : result;
                if (property === "clearProgress") return decodeProgressGeneration(value);
                if (property === "getProgress") {
                    return value === null ? null : normalizeProgressGeneration(value);
                }
                if (property === "failedProgressSnapshot") {
                    return value.map(normalizeProgressGeneration);
                }
                return GAME_STATE_COMMANDS.has(property) ? normalizeGameState(value) : value;
            } catch (error) {
                if (CHESSRIDDLE_COMMANDS.has(property)) {
                    throw error instanceof ChessRiddleCommandError
                        ? error
                        : new ChessRiddleCommandError(error);
                }
                if (error instanceof TauriCommandError) throw error;
                throw new TauriCommandError(error);
            } finally {
                const mark = (
                    globalThis as {
                        __verifyAppRecordReadGame?: (durationMs: number, fileId?: string) => void;
                    }
                ).__verifyAppRecordReadGame;
                if (property === "readGame" && typeof mark === "function") {
                    mark(performance.now() - readStartedAt, readFileId);
                }
                const markLex = (
                    globalThis as {
                        __verifyAppRecordLexPgn?: (durationMs: number) => void;
                    }
                ).__verifyAppRecordLexPgn;
                if (property === "lexPgn" && typeof markLex === "function") {
                    markLex(performance.now() - lexStartedAt);
                }
            }
        };
    },
}) as unknown as TauriCommands;

/** Typed event subscriptions owned by the same generated-binding boundary. */
export const tauriSubscriptions = {
    chessBaseSelected: (callback: Parameters<typeof events.chessBaseSelected.listen>[0]) =>
        events.chessBaseSelected.listen(callback),
    completionChanged: (callback: Parameters<typeof events.completionChanged.listen>[0]) =>
        events.completionChanged.listen(callback),
    windowFocus: (callback: () => void) => getCurrentWindow().listen("tauri://focus", callback),
    bestMoves: (callback: Parameters<typeof events.bestMovesPayload.listen>[0]) =>
        events.bestMovesPayload.listen(callback),
    clockUpdate: eventSubscription(
        (callback) => events.clockUpdateEvent.listen(callback),
        normalizeClockUpdateEvent,
    ),
    convertProgress: (callback: Parameters<typeof events.convertProgress.listen>[0]) =>
        events.convertProgress.listen(callback),
    databaseContentFailure: (
        callback: Parameters<typeof events.databaseContentFailure.listen>[0],
    ) => events.databaseContentFailure.listen(callback),
    gameMove: eventSubscription(
        (callback) => events.gameMoveEvent.listen(callback),
        normalizeGameMoveEvent,
    ),
    gameOver: eventSubscription(
        (callback) => events.gameOverEvent.listen(callback),
        normalizeGameOverEvent,
    ),
    progress: eventSubscription<ProgressEvent, WireProgressEvent>(
        (callback) => events.progressEvent.listen(callback),
        normalizeProgressGeneration,
    ),
};
