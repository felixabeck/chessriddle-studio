import { atom, type WritableAtom } from "jotai";
import equal from "fast-deep-equal";
import type {
    PracticeDeckInventory,
    PracticeDeckSnapshot,
    PracticeDeckLoad,
    PracticeEpoch,
    PracticeMigrationOutcome,
    PracticeReviewPage,
} from "@/bindings";
import { normalizeError, type AppError } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import i18n from "@/i18n";
import type { ReviewLog } from "ts-fsrs";
import { z } from "zod";
import { type Position, positionSchema } from "@/components/files/opening";
import { pathRefSchema } from "@/utils/pathCapabilities";
import { getBoardState } from "@/utils/treeReducer";
import { reportPersistError } from "./persistError";
import { afterFileStructureChange } from "./fileStructureChange";

export const PRACTICE_SYNC_DEBOUNCE_MS = 250;
export const PRACTICE_MAX_CONFLICT_RETRIES = 2;
export const PRACTICE_LOG_PAGE_SIZE = 100;
/** Failure identity covering every deck in one file. */
export const PRACTICE_FILE_WIDE_FAILURE_GAME = -1;
/** Mirrors the native u32::MAX refusal for optimistic practice revisions. */
const PRACTICE_REVISION_MAX = 0xffffffff;

/** The old browser shape is retained only as input for startup and inline migration. */
export const reviewLogSchema = z
    .object({
        fen: z.string(),
    })
    .passthrough();

export const practiceDataSchema = z.object({
    positions: positionSchema.array(),
    logs: reviewLogSchema.array(),
});

export type PracticeData = {
    positions: Position[];
    logs: (ReviewLog & { fen: string })[];
};

export type PracticeDeckStatus =
    | "loading"
    | "ready"
    | "read-failed"
    | "write-blocked"
    | "write-pending";

export type PracticeDeckValue = {
    epoch?: string;
    repairEpoch?: string | null;
    positions: Position[];
    revision: number;
    generation: number;
    unappliedReviews: number;
    orphansAcknowledged: boolean;
    status: PracticeDeckStatus;
    repairable?: boolean;
    error?: AppError;
};

export type PracticeDeckKey = { file: string; game: number };

export type PracticeLegacyDeckKey = {
    key: string;
    identity: PracticeDeckKey;
};

export type PracticeLegacyDeckScan = {
    keys: PracticeLegacyDeckKey[];
    trusted: boolean;
    complete: boolean;
};

export type PracticeMigrationDeckOutcome = {
    key: string;
    identity: PracticeDeckKey;
    status: PracticeMigrationOutcome["status"] | "failed";
    entries?: number;
    positions?: number;
    error?: AppError;
};

export type PracticeMigrationPassResult = {
    outcomes: PracticeMigrationDeckOutcome[];
    inventory: PracticeDeckInventory | null;
    scanTrusted: boolean;
    inventoryTrusted: boolean;
};

export type PracticeRatingMutation = {
    type: "rating";
    positions: Position[];
    entry: ReviewLog & { fen: string };
    entryId: string;
    sourcePosition: Position;
};

export type PracticeDeckMutation =
    | PracticeRatingMutation
    | { type: "sync"; positions: Position[] }
    | { type: "reset"; positions: Position[] }
    | { type: "acknowledge" }
    | { type: "repair" }
    | { type: "retry" };

export type PracticeDeckAction =
    | PracticeDeckValue
    | PracticeDeckMutation
    | ((current: PracticeDeckValue) => PracticeDeckValue);

const positionsDocumentSchema = z.object({ positions: positionSchema.array() });

type PracticeMigrationFailure = {
    error: AppError;
    repairable: boolean;
    repairEpoch?: string | null;
};
let practiceMigrationFailures = new Map<string, PracticeMigrationFailure>();
let practiceWritesBlocked = false;
let reportedInventoryAnomalies = new Set<string>();
let practiceMigrationPromise: Promise<PracticeMigrationPassResult> | undefined;

const LEGACY_DECK_KEY = /^deck-(.+)-(-?\d+)$/;

function identityKey(identity: PracticeDeckKey): string {
    return `${identity.file}\u0000${identity.game}`;
}

function displayIdentity(identity: PracticeDeckKey): string {
    return `${identity.file} (${identity.game})`;
}

function errorAsAppError(error: unknown): AppError {
    return normalizeError(error);
}

class PracticeMigrationBlockedError extends Error {
    constructor(
        readonly appError: AppError,
        readonly repairable: boolean,
        readonly repairEpoch?: string | null,
    ) {
        super(appError.message, { cause: appError });
    }
}

function reportMigrationFailures(
    failures: Array<{ identity?: PracticeDeckKey; label?: string }>,
    reasonKey:
        | "Board.Practice.MigrationFailed"
        | "Board.Practice.MigrationScanFailed"
        | "Board.Practice.InventoryDamaged"
        | "Board.Practice.InventoryUnreadable",
): void {
    const labels = failures.map(({ identity, label }) =>
        identity ? displayIdentity(identity) : (label ?? i18n.t("Board.Practice.Data")),
    );
    if (typeof reportPersistError === "function") {
        reportPersistError(
            new Error(
                i18n.t(reasonKey, {
                    decks: labels.length > 0 ? labels.join(", ") : i18n.t("Board.Practice.Data"),
                }),
            ),
        );
    }
}

/** Enumerate only legacy deck key names; values are intentionally not read here. */
export function scanLegacyPracticeDeckKeys(storage?: Storage): PracticeLegacyDeckScan {
    const keys: PracticeLegacyDeckKey[] = [];
    let trusted = true;
    try {
        const source = storage ?? globalThis.localStorage;
        for (let index = 0; index < source.length; index += 1) {
            const key = source.key(index);
            if (!key?.startsWith("deck-")) continue;
            const match = LEGACY_DECK_KEY.exec(key);
            const game = match ? Number(match[2]) : Number.NaN;
            if (
                !match ||
                !Number.isSafeInteger(game) ||
                !pathRefSchema.safeParse({ id: match[1] }).success
            ) {
                trusted = false;
                continue;
            }
            keys.push({ key, identity: { file: match[1], game } });
        }
        return { keys, trusted, complete: true };
    } catch {
        return { keys, trusted: false, complete: false };
    }
}

export function reportPracticeInventoryAnomalies(inventory: PracticeDeckInventory): void {
    // Every inventory re-records each deck's classification, because a retry clears it; only the
    // user notification is deduplicated.
    for (const anomaly of inventory.anomalies) {
        if (anomaly.fileId !== null) {
            const identity = {
                file: anomaly.fileId,
                game: anomaly.game ?? PRACTICE_FILE_WIDE_FAILURE_GAME,
            };
            const error: AppError = {
                ...errorAsAppError(
                    new Error(
                        i18n.t(
                            anomaly.kind === "Unreadable"
                                ? "Board.Practice.InventoryUnreadable"
                                : "Board.Practice.InventoryDamaged",
                            { decks: displayIdentity(identity) },
                        ),
                    ),
                ),
                backendCategory: anomaly.kind === "Unreadable" ? "io" : "invalid-input",
            };
            // Repair deletes the native deck, so it is offered only where the inventory found this
            // deck's stored content damaged. The inventory validates with the same read path as a
            // load, so a load failure it did not classify is not damage it can prove: I/O, an
            // authorization refusal, or a renderer-side failure. Retry reruns the inventory.
            practiceMigrationFailures.set(identityKey(identity), {
                error,
                repairable:
                    anomaly.kind !== "Unreadable" &&
                    (typeof anomaly.epoch === "string" ||
                        (anomaly.epoch === null &&
                            anomaly.game === null &&
                            anomaly.kind === "DamagedDeck")),
                repairEpoch:
                    typeof anomaly.epoch === "string"
                        ? anomaly.epoch
                        : anomaly.epoch === null &&
                            anomaly.game === null &&
                            anomaly.kind === "DamagedDeck"
                          ? null
                          : undefined,
            });
        }
    }
    const newAnomalies = inventory.anomalies.filter((anomaly) => {
        const key = `${anomaly.kind}\u0000${anomaly.leaf}`;
        if (reportedInventoryAnomalies.has(key)) return false;
        reportedInventoryAnomalies.add(key);
        return true;
    });
    const unreadable = newAnomalies.filter((anomaly) => anomaly.kind === "Unreadable");
    const damaged = newAnomalies.filter((anomaly) => anomaly.kind !== "Unreadable");
    for (const [anomalies, reasonKey] of [
        [unreadable, "Board.Practice.InventoryUnreadable"],
        [damaged, "Board.Practice.InventoryDamaged"],
    ] as const) {
        if (anomalies.length === 0) continue;
        reportMigrationFailures(
            anomalies.map((anomaly) =>
                anomaly.fileId !== null && anomaly.game !== null
                    ? { identity: { file: anomaly.fileId, game: anomaly.game } }
                    : { label: anomaly.leaf },
            ),
            reasonKey,
        );
    }
}

function sameIdentity(left: PracticeDeckKey, right: { fileId: string; game: number }): boolean {
    return left.file === right.fileId && left.game === right.game;
}

function removeIdentityFailuresAndAnomaliesFromResult(
    result: PracticeMigrationPassResult,
    identity: PracticeDeckKey,
): PracticeMigrationPassResult {
    const key = identityKey(identity);
    return {
        ...result,
        outcomes: result.outcomes.filter(
            (outcome) => identityKey(outcome.identity) !== key || outcome.status !== "failed",
        ),
        inventory: result.inventory
            ? {
                  ...result.inventory,
                  anomalies: result.inventory.anomalies.filter(
                      (anomaly) =>
                          anomaly.fileId === null ||
                          anomaly.game === null ||
                          !sameIdentity(identity, {
                              fileId: anomaly.fileId,
                              game: anomaly.game,
                          }),
                  ),
              }
            : null,
    };
}

function clearPracticeIdentityState(identity: PracticeDeckKey, rerunMigration: boolean): void {
    practiceMigrationFailures.delete(identityKey(identity));
    practiceMigrationFailures.delete(
        identityKey({ file: identity.file, game: PRACTICE_FILE_WIDE_FAILURE_GAME }),
    );
    const previous = practiceMigrationPromise;
    if (!previous) return;
    const cleaned = previous.then((result) =>
        removeIdentityFailuresAndAnomaliesFromResult(result, identity),
    );
    practiceMigrationPromise = rerunMigration ? cleaned.then(() => migrationPass()) : cleaned;
}

/** A delete changes every ordinal in this file, so no cached damage identity survives it. */
export function clearPracticeFileMigrationFailures(fileId: string): void {
    for (const key of practiceMigrationFailures.keys()) {
        if (key.startsWith(`${fileId}\u0000`)) practiceMigrationFailures.delete(key);
    }
}

function inventoryIdentity(identity: { fileId: string; game: number }): string {
    return identityKey({ file: identity.fileId, game: identity.game });
}

function healthyNativeIdentities(inventory: PracticeDeckInventory): Set<string> {
    const damaged = new Set(
        inventory.anomalies
            .filter((anomaly) => anomaly.fileId !== null && anomaly.game !== null)
            .map((anomaly) => inventoryIdentity({ fileId: anomaly.fileId!, game: anomaly.game! })),
    );
    return new Set(
        inventory.decks.map(inventoryIdentity).filter((identity) => !damaged.has(identity)),
    );
}

function legacyDocument(
    storage: Storage,
    legacy: PracticeLegacyDeckKey,
): { raw: string; data: PracticeData } {
    const raw = storage.getItem(legacy.key);
    if (raw === null) {
        throw new Error(i18n.t("Board.Practice.MigrationValueMissing"));
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        throw new Error(i18n.t("Board.Practice.MigrationValueInvalid"), { cause: error });
    }
    const result = practiceDataSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(i18n.t("Board.Practice.MigrationValueInvalid"), { cause: result.error });
    }
    return { raw, data: result.data as unknown as PracticeData };
}

async function outcomeForHeldDeck(
    legacy: PracticeLegacyDeckKey,
): Promise<PracticeMigrationDeckOutcome> {
    try {
        const authority = await readMigrationEpoch(legacy.identity);
        return {
            key: legacy.key,
            identity: legacy.identity,
            status: authority.legacySuperseded ? "superseded" : "alreadyMigrated",
        };
    } catch (error) {
        return failedMigrationOutcome(legacy, error);
    }
}

async function readMigrationEpoch(identity: PracticeDeckKey): Promise<PracticeEpoch> {
    try {
        return await readPracticeEpoch(identity.file, identity.game);
    } catch (error) {
        const appError = errorAsAppError(error);
        if (appError.backendCategory === "invalid-input") {
            practiceMigrationFailures.set(
                identityKey({ file: identity.file, game: PRACTICE_FILE_WIDE_FAILURE_GAME }),
                { error: appError, repairable: true, repairEpoch: null },
            );
        }
        throw error;
    }
}

function failedMigrationOutcome(
    legacy: PracticeLegacyDeckKey,
    error: unknown,
): PracticeMigrationDeckOutcome {
    const appError = errorAsAppError(error);
    const fileFailure = practiceMigrationFailures.get(
        identityKey({ file: legacy.identity.file, game: PRACTICE_FILE_WIDE_FAILURE_GAME }),
    );
    if (!fileFailure) {
        // Repair cannot change a bad legacy value, but preserves an inventory damage finding.
        const known = practiceMigrationFailures.get(identityKey(legacy.identity));
        practiceMigrationFailures.set(identityKey(legacy.identity), {
            error: appError,
            repairable: known?.repairable ?? false,
            repairEpoch: known?.repairEpoch,
        });
    }
    return { key: legacy.key, identity: legacy.identity, status: "failed", error: appError };
}

async function migrateLegacyDeck(
    storage: Storage,
    legacy: PracticeLegacyDeckKey,
): Promise<PracticeMigrationDeckOutcome> {
    try {
        const authority = await readMigrationEpoch(legacy.identity);
        if (authority.legacySuperseded) {
            practiceMigrationFailures.delete(identityKey(legacy.identity));
            return { key: legacy.key, identity: legacy.identity, status: "superseded" };
        }
        const document = legacyDocument(storage, legacy);
        const outcome = await migratePracticeDeck(
            legacy.identity.file,
            legacy.identity.game,
            document.raw,
            authority.epoch,
        );
        if (
            outcome.status === "migrated" &&
            (outcome.entries !== document.data.logs.length ||
                outcome.positions !== document.data.positions.length)
        ) {
            throw new Error(i18n.t("Board.Practice.MigrationCountMismatch"));
        }
        practiceMigrationFailures.delete(identityKey(legacy.identity));
        return {
            key: legacy.key,
            identity: legacy.identity,
            status: outcome.status,
            entries: outcome.entries,
            positions: outcome.positions,
        };
    } catch (error) {
        const appError = errorAsAppError(error);
        if (appError.backendCategory === "conflict") {
            try {
                const authority = await readMigrationEpoch(legacy.identity);
                if (authority.legacySuperseded) {
                    practiceMigrationFailures.delete(identityKey(legacy.identity));
                    return { key: legacy.key, identity: legacy.identity, status: "superseded" };
                }
            } catch (epochError) {
                return failedMigrationOutcome(legacy, epochError);
            }
        }
        return failedMigrationOutcome(legacy, error);
    }
}

async function migrationPass(): Promise<PracticeMigrationPassResult> {
    const scan = scanLegacyPracticeDeckKeys();
    let inventory: PracticeDeckInventory | null = null;
    let inventoryTrusted = true;
    let globalFailure: string | undefined;
    try {
        inventory = await listPracticeDecks();
        reportPracticeInventoryAnomalies(inventory);
    } catch (error) {
        inventoryTrusted = false;
        practiceWritesBlocked = true;
        globalFailure = errorAsAppError(error).message;
    }

    if (!scan.complete || !scan.trusted) {
        practiceWritesBlocked = true;
        if (!scan.complete) globalFailure ??= "saved-data enumeration failed";
        else globalFailure ??= "saved-data enumeration found an invalid deck key";
    }

    const outcomes: PracticeMigrationDeckOutcome[] = [];
    if (scan.complete && inventoryTrusted && inventory) {
        const held = healthyNativeIdentities(inventory);
        let storage: Storage | null;
        try {
            storage = globalThis.localStorage;
        } catch {
            storage = null;
        }
        if (!storage) {
            practiceWritesBlocked = true;
            globalFailure ??= "saved-data storage is unavailable";
        } else {
            for (const legacy of scan.keys) {
                const outcome = held.has(identityKey(legacy.identity))
                    ? await outcomeForHeldDeck(legacy)
                    : await migrateLegacyDeck(storage, legacy);
                outcomes.push(outcome);
            }
        }
    } else {
        for (const legacy of scan.keys) {
            const error = new Error(i18n.t("Board.Practice.MigrationScanFailed"));
            const appError = errorAsAppError(error);
            practiceMigrationFailures.set(identityKey(legacy.identity), {
                error: appError,
                repairable: false,
            });
            outcomes.push({
                key: legacy.key,
                identity: legacy.identity,
                status: "failed",
                error: appError,
            });
        }
    }

    const failures = outcomes.filter((outcome) => outcome.status === "failed");
    if (globalFailure) {
        reportMigrationFailures(
            [
                { label: globalFailure },
                ...failures.map((failure) => ({ identity: failure.identity })),
            ],
            "Board.Practice.MigrationScanFailed",
        );
    } else if (failures.length > 0) {
        reportMigrationFailures(
            failures.map((failure) => ({ identity: failure.identity })),
            "Board.Practice.MigrationFailed",
        );
    }
    if (scan.complete && scan.trusted && inventoryTrusted) practiceWritesBlocked = false;
    let result: PracticeMigrationPassResult = {
        outcomes,
        inventory,
        scanTrusted: scan.trusted,
        inventoryTrusted,
    };
    for (const outcome of outcomes) {
        if (outcome.status !== "failed") {
            result = removeIdentityFailuresAndAnomaliesFromResult(result, outcome.identity);
        }
    }
    return result;
}

function startPracticeMigrationPass(): Promise<PracticeMigrationPassResult> {
    const run = migrationPass().catch((error) => {
        practiceWritesBlocked = true;
        const appError = errorAsAppError(error);
        reportMigrationFailures(
            [{ label: appError.message }],
            "Board.Practice.MigrationScanFailed",
        );
        return {
            outcomes: [],
            inventory: null,
            scanTrusted: false,
            inventoryTrusted: false,
        } satisfies PracticeMigrationPassResult;
    });
    return run;
}

export function ensurePracticeMigration(): Promise<PracticeMigrationPassResult> {
    practiceMigrationPromise ??= startPracticeMigrationPass();
    return practiceMigrationPromise;
}

export function runPracticeMigrationPass(): Promise<PracticeMigrationPassResult> {
    const run = startPracticeMigrationPass();
    practiceMigrationPromise = run;
    return run;
}

export function retireMigratedLegacyDeckKeys(
    storage: Storage,
    outcomes: readonly PracticeMigrationDeckOutcome[],
): void {
    let firstFailure: { error: unknown } | undefined;
    for (const outcome of outcomes) {
        if (outcome.status !== "migrated" && outcome.status !== "alreadyMigrated") continue;
        try {
            storage.removeItem(outcome.key);
        } catch (error) {
            firstFailure ??= { error };
        }
    }
    if (firstFailure) reportPersistError(firstFailure.error);
}

export function retireMigratedLegacyDeckKeysFromBrowser(
    outcomes: readonly PracticeMigrationDeckOutcome[],
): void {
    let storage: Storage;
    try {
        storage = globalThis.localStorage;
    } catch (error) {
        reportPersistError(error);
        return;
    }
    retireMigratedLegacyDeckKeys(storage, outcomes);
}

function migrationBlock(identity: PracticeDeckKey): Error | null {
    if (practiceWritesBlocked) return new Error(i18n.t("Board.Practice.MigrationScanFailed"));
    const failure =
        practiceMigrationFailures.get(
            identityKey({ file: identity.file, game: PRACTICE_FILE_WIDE_FAILURE_GAME }),
        ) ?? practiceMigrationFailures.get(identityKey(identity));
    return failure
        ? new PracticeMigrationBlockedError(failure.error, failure.repairable, failure.repairEpoch)
        : null;
}

async function migrateLegacyDeckInline(identity: PracticeDeckKey): Promise<void> {
    const scan = scanLegacyPracticeDeckKeys();
    if (!scan.complete) {
        practiceWritesBlocked = true;
        throw new Error(i18n.t("Board.Practice.MigrationScanFailed"));
    }
    const legacy = scan.keys.find((entry) => identityKey(entry.identity) === identityKey(identity));
    if (!legacy) return;

    if (!scan.trusted) practiceWritesBlocked = true;

    let inventory: PracticeDeckInventory;
    try {
        inventory = await listPracticeDecks();
    } catch (error) {
        practiceWritesBlocked = true;
        throw error;
    }
    if (healthyNativeIdentities(inventory).has(identityKey(identity))) {
        const outcome = await outcomeForHeldDeck(legacy);
        if (outcome.status === "failed") throw outcome.error;
        retireMigratedLegacyDeckKeysFromBrowser([outcome]);
        return;
    }

    const outcome = await migrateLegacyDeck(globalThis.localStorage, legacy);
    if (outcome.status === "failed") {
        throw outcome.error;
    }
    retireMigratedLegacyDeckKeysFromBrowser([outcome]);
    clearPracticeIdentityState(identity, false);
}

export function resetPracticeMigrationForTests(): void {
    practiceMigrationPromise = undefined;
    practiceMigrationFailures = new Map();
    practiceWritesBlocked = false;
    reportedInventoryAnomalies = new Set();
}

const emptyDeck = (status: PracticeDeckStatus = "loading"): PracticeDeckValue => ({
    positions: [],
    revision: 0,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
    status,
});

function invokePractice<T>(fileId: string | null, call: () => Promise<T>): Promise<T> {
    const run = fileId === null ? call() : afterFileStructureChange(fileId, call);
    return run.catch((error) => {
        // Keep the backend category attached: conflict retry must not branch on the renderer's
        // coarser `validation` category or on a localized message.
        throw normalizeError(error);
    });
}

export async function loadPracticeDeck(fileId: string, game: number): Promise<PracticeDeckLoad> {
    return invokePractice(fileId, () => tauri.loadPracticeDeck(fileId, game));
}

export async function recordPracticeReview(
    fileId: string,
    game: number,
    generation: number,
    revision: number,
    baseRevision: number,
    positionsDocument: string,
    entry: string,
    entryId: string,
    expectedEpoch: string,
): Promise<number> {
    return invokePractice(fileId, () =>
        tauri.recordPracticeReview(fileId, game, expectedEpoch, {
            generation,
            revision,
            baseRevision,
            positionsDocument,
            entry,
            entryId,
        }),
    );
}

export async function syncPracticePositions(
    fileId: string,
    game: number,
    generation: number,
    revision: number,
    positionsDocument: string,
    expectedEpoch: string,
): Promise<number> {
    return invokePractice(fileId, () =>
        tauri.syncPracticePositions(
            fileId,
            game,
            generation,
            revision,
            positionsDocument,
            expectedEpoch,
        ),
    );
}

export async function resetPracticeDeck(
    fileId: string,
    game: number,
    generation: number,
    revision: number,
    positionsDocument: string,
    expectedEpoch: string,
): Promise<number> {
    return invokePractice(fileId, () =>
        tauri.resetPracticeDeck(
            fileId,
            game,
            generation,
            revision,
            positionsDocument,
            expectedEpoch,
        ),
    );
}

export async function loadPracticeReviews(
    fileId: string,
    game: number,
    cursor: string | null,
    limit: number,
    expectedEpoch: string,
): Promise<PracticeReviewPage> {
    return invokePractice(fileId, () =>
        tauri.loadPracticeReviews(fileId, game, cursor, limit, expectedEpoch),
    );
}

export async function migratePracticeDeck(
    fileId: string,
    game: number,
    legacyDocument: string,
    expectedEpoch: string,
): Promise<PracticeMigrationOutcome> {
    return invokePractice(fileId, () =>
        tauri.migratePracticeDeck(fileId, game, legacyDocument, expectedEpoch),
    );
}

export async function acknowledgePracticeOrphans(
    fileId: string,
    game: number,
    generation: number,
    acknowledgedCount: number,
    expectedEpoch: string,
): Promise<null> {
    return invokePractice(fileId, () =>
        tauri.acknowledgePracticeOrphans(
            fileId,
            game,
            generation,
            acknowledgedCount,
            expectedEpoch,
        ),
    );
}

export async function readPracticeEpoch(fileId: string, game: number): Promise<PracticeEpoch> {
    return invokePractice(fileId, () => tauri.practiceEpoch(fileId, game));
}

export async function repairPracticeDeck(
    fileId: string,
    game: number,
    epoch: string | null,
): Promise<null> {
    return invokePractice(fileId, () => tauri.repairPracticeDeck(fileId, game, epoch));
}

export async function listPracticeDecks(): Promise<PracticeDeckInventory> {
    return invokePractice(null, () => tauri.listPracticeDecks());
}

function parsePositionsDocument(document: string): Position[] {
    const parsed: unknown = JSON.parse(document);
    return positionsDocumentSchema.parse(parsed).positions as unknown as Position[];
}

function positionsDocument(positions: Position[]): string {
    return JSON.stringify({ positions });
}

function deckFromSnapshot(snapshot: PracticeDeckSnapshot): PracticeDeckValue {
    return {
        positions: parsePositionsDocument(snapshot.positionsDocument),
        revision: snapshot.revision,
        generation: snapshot.generation,
        unappliedReviews: snapshot.unappliedReviews,
        orphansAcknowledged: snapshot.orphansAcknowledged,
        status: "ready",
    };
}

function deckFromLoad(load: PracticeDeckLoad): PracticeDeckValue {
    return { ...(load.deck ? deckFromSnapshot(load.deck) : emptyDeck("ready")), epoch: load.epoch };
}

function payloadEpoch(deck: PracticeDeckValue): string {
    if (!deck.epoch) throw queuedWriteNotSaved();
    return deck.epoch;
}

function failureState(current: PracticeDeckValue, error: unknown): PracticeDeckValue {
    const practiceError = error instanceof PracticeMigrationBlockedError ? error : null;
    const normalized = normalizeError(practiceError?.appError ?? error);
    return {
        ...current,
        status: "read-failed",
        repairable:
            practiceError?.repairable ??
            (normalized.backendCategory === "invalid-input" &&
                normalized.rootFailure === "unusable"),
        error: normalized,
    };
}

function writeFailureState(current: PracticeDeckValue, error: unknown): PracticeDeckValue {
    return {
        ...current,
        status: "write-blocked",
        error: normalizeError(error),
    };
}

function isMutation(update: PracticeDeckAction): update is PracticeDeckMutation {
    return typeof update === "object" && update !== null && "type" in update;
}

function readyState(value: PracticeDeckValue, positions: Position[]): PracticeDeckValue {
    return {
        ...value,
        positions,
        status: "ready",
        error: undefined,
    };
}

function sameCard(left: Position["card"], right: Position["card"]): boolean {
    return equal(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

type DeckController = {
    identity: PracticeDeckKey;
    mounted: boolean;
    requestSequence: number;
    writeBlocked: boolean;
    committed: PracticeDeckValue | null;
    writeChain: Promise<void>;
    syncTimer: ReturnType<typeof setTimeout> | null;
    syncResolve: (() => void) | null;
};

function reportWriteFailure(error: unknown): void {
    reportPersistError(error);
}

function queuedWriteNotSaved(): Error {
    return new Error(i18n.t("Board.Practice.QueuedWriteNotSaved"));
}

type PracticeWriteDroppedNotice = "rating" | "queued-write";

class PracticeWriteDroppedError extends Error {
    constructor(
        readonly deck: PracticeDeckValue,
        cause: unknown,
        readonly noticeKind: PracticeWriteDroppedNotice,
    ) {
        super(
            i18n.t(
                noticeKind === "rating"
                    ? "Board.Practice.RatingDropped"
                    : "Board.Practice.QueuedWriteNotSaved",
            ),
            { cause },
        );
    }
}

async function hydrate(identity: PracticeDeckKey): Promise<PracticeDeckValue> {
    if (identity.file === "") return emptyDeck("ready");
    let repairEpoch: string | null | undefined;
    let epochError: unknown;
    try {
        await ensurePracticeMigration();
        const blocked = migrationBlock(identity);
        if (blocked) throw blocked;
        // Capture authority before observing damage. A delete during the load makes Repair stale.
        try {
            repairEpoch = (await readPracticeEpoch(identity.file, identity.game)).epoch;
        } catch (error) {
            epochError = error;
        }
        const snapshot = await loadPracticeDeck(identity.file, identity.game);
        return deckFromLoad(snapshot);
    } catch (error) {
        const failed = failureState(emptyDeck(), error);
        if (!failed.repairable) return failed;
        if (error instanceof PracticeMigrationBlockedError) {
            return {
                ...failed,
                repairable: error.repairEpoch !== undefined,
                repairEpoch: error.repairEpoch,
            };
        }
        if (epochError) {
            if (normalizeError(epochError).backendCategory === "invalid-input") repairEpoch = null;
            else return { ...failureState(emptyDeck(), epochError), repairable: false };
        }
        return { ...failed, repairable: repairEpoch !== undefined, repairEpoch };
    }
}

async function persistRating(
    identity: PracticeDeckKey,
    committed: PracticeDeckValue,
    mutation: PracticeRatingMutation,
): Promise<PracticeDeckValue> {
    const baseRevision = committed.revision;
    let revision = committed.revision;
    let generation = committed.generation;
    let positions = mutation.positions;

    for (let retry = 0; ; retry += 1) {
        try {
            const nextRevision = await recordPracticeReview(
                identity.file,
                identity.game,
                generation,
                revision,
                baseRevision,
                positionsDocument(positions),
                JSON.stringify(mutation.entry),
                mutation.entryId,
                payloadEpoch(committed),
            );
            return readyState(
                {
                    ...committed,
                    revision: nextRevision,
                    generation,
                },
                positions,
            );
        } catch (cause) {
            const error = normalizeError(cause);
            if (error.backendCategory !== "conflict") throw error;
            if (retry >= PRACTICE_MAX_CONFLICT_RETRIES) {
                throw new Error(i18n.t("Board.Practice.ConflictRetryExhausted"), {
                    cause: error,
                });
            }

            const reloaded = await loadPracticeDeck(identity.file, identity.game);
            const reloadedDeck = deckFromLoad(reloaded);
            if (reloadedDeck.epoch !== committed.epoch) {
                throw new PracticeWriteDroppedError(reloadedDeck, error, "rating");
            }
            if (!reloaded.deck) {
                throw new Error(i18n.t("Board.Practice.DeckDisappeared"), {
                    cause: error,
                });
            }
            if (reloadedDeck.generation !== committed.generation) {
                throw new PracticeWriteDroppedError(reloadedDeck, error, "rating");
            }
            const boardState = getBoardState(mutation.sourcePosition.fen);
            const reloadedIndex = reloadedDeck.positions.findIndex(
                (position) => getBoardState(position.fen) === boardState,
            );
            const updatedPosition = positions.find(
                (position) => getBoardState(position.fen) === boardState,
            );
            const reloadedPosition =
                reloadedIndex === -1 ? undefined : reloadedDeck.positions[reloadedIndex];
            if (
                !reloadedPosition ||
                !updatedPosition ||
                !sameCard(reloadedPosition.card, mutation.sourcePosition.card)
            ) {
                throw new PracticeWriteDroppedError(reloadedDeck, error, "rating");
            }
            positions = reloadedDeck.positions.map((position, index) =>
                index === reloadedIndex ? { ...position, card: updatedPosition.card } : position,
            );
            revision = reloadedDeck.revision;
            generation = reloadedDeck.generation;
        }
    }
}

async function persistSync(
    identity: PracticeDeckKey,
    committed: PracticeDeckValue,
    positions: Position[],
    computedGeneration: number,
): Promise<PracticeDeckValue> {
    if (committed.generation !== computedGeneration) {
        return readyState(committed, committed.positions);
    }
    let effectiveCommitted = committed;
    if (committed.revision === 0 && committed.generation === 0) {
        await ensurePracticeMigration();
        await migrateLegacyDeckInline(identity);
        const snapshot = await loadPracticeDeck(identity.file, identity.game);
        const reloadedDeck = deckFromLoad(snapshot);
        if (reloadedDeck.epoch !== committed.epoch) {
            throw new PracticeWriteDroppedError(
                reloadedDeck,
                queuedWriteNotSaved(),
                "queued-write",
            );
        }
        effectiveCommitted = reloadedDeck;
    }
    const committedCards = new Map(
        effectiveCommitted.positions.map((position) => [
            getBoardState(position.fen),
            position.card,
        ]),
    );
    const mergedPositions = positions.map((position) => {
        const committedCard = committedCards.get(getBoardState(position.fen));
        return committedCard ? { ...position, card: committedCard } : position;
    });
    const revision = await syncPracticePositions(
        identity.file,
        identity.game,
        effectiveCommitted.generation,
        effectiveCommitted.revision,
        positionsDocument(mergedPositions),
        payloadEpoch(committed),
    );
    return readyState({ ...effectiveCommitted, revision }, mergedPositions);
}

async function persistReset(
    identity: PracticeDeckKey,
    committed: PracticeDeckValue,
    positions: Position[],
): Promise<PracticeDeckValue> {
    const revision = await resetPracticeDeck(
        identity.file,
        identity.game,
        committed.generation,
        committed.revision,
        positionsDocument(positions),
        payloadEpoch(committed),
    );
    clearPracticeIdentityState(identity, false);
    return readyState(
        {
            ...committed,
            revision,
            generation: committed.generation + 1,
            unappliedReviews: 0,
            orphansAcknowledged: true,
        },
        positions,
    );
}

type QueuedWrite = {
    allowWhenBlocked?: boolean;
    task: (committed: PracticeDeckValue | null) => Promise<PracticeDeckValue>;
};

function enqueueWrite(controller: DeckController, write: QueuedWrite): Promise<PracticeDeckValue> {
    const run = controller.writeChain.then(async () => {
        if (controller.writeBlocked && !write.allowWhenBlocked) {
            throw queuedWriteNotSaved();
        }
        if (!write.allowWhenBlocked && !controller.committed) {
            throw queuedWriteNotSaved();
        }
        try {
            const next = await write.task(controller.committed);
            controller.committed = next;
            controller.writeBlocked = next.status !== "ready";
            return next;
        } catch (cause) {
            let error = cause;
            if (
                !(cause instanceof PracticeWriteDroppedError) &&
                normalizeError(cause).backendCategory === "conflict"
            ) {
                const reloaded = await hydrate(controller.identity);
                if (reloaded.epoch !== controller.committed?.epoch) {
                    error = new PracticeWriteDroppedError(reloaded, cause, "queued-write");
                }
            }
            if (error instanceof PracticeWriteDroppedError) {
                controller.committed = error.deck;
                controller.writeBlocked = error.deck.status !== "ready";
            } else {
                controller.writeBlocked = true;
            }
            throw error;
        }
    });
    controller.writeChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function createController(identity: PracticeDeckKey): DeckController {
    return {
        identity,
        mounted: false,
        requestSequence: 0,
        writeBlocked: false,
        committed: null,
        writeChain: Promise.resolve(),
        syncTimer: null,
        syncResolve: null,
    };
}

export function createPracticeDeckAtom(
    identity: PracticeDeckKey,
): WritableAtom<PracticeDeckValue, [PracticeDeckAction], Promise<void> | void> {
    const controller = createController(identity);
    const initial = emptyDeck(identity.file === "" ? "ready" : "loading");
    const stateAtom = atom<PracticeDeckValue>(initial);
    const completeHydration = (
        sequence: number,
        loading: PracticeDeckValue,
        setState: (next: PracticeDeckValue) => void,
        run: Promise<PracticeDeckValue>,
    ): Promise<void> =>
        run.then(
            (next) => {
                // A superseded hydration must not touch the controller a newer one owns.
                if (sequence !== controller.requestSequence) return;
                controller.committed = next.status === "ready" ? next : null;
                controller.writeBlocked = next.status !== "ready";
                if (controller.mounted) setState(next);
            },
            (error) => {
                if (sequence !== controller.requestSequence) return;
                controller.committed = null;
                controller.writeBlocked = true;
                if (controller.mounted) setState(failureState(loading, error));
            },
        );
    const startHydration = (
        sequence: number,
        loading: PracticeDeckValue,
        setState: (next: PracticeDeckValue) => void,
        prelude?: () => Promise<void>,
    ): Promise<void> => {
        const run = controller.writeChain.then(async () => {
            await prelude?.();
            return hydrate(identity);
        });
        return completeHydration(sequence, loading, setState, run);
    };

    stateAtom.onMount = (setState) => {
        controller.mounted = true;
        controller.writeBlocked = false;
        controller.committed = identity.file === "" ? initial : null;
        setState(initial);
        const sequence = ++controller.requestSequence;
        void startHydration(sequence, initial, setState);
        return () => {
            controller.mounted = false;
            controller.requestSequence += 1;
            if (controller.syncTimer) clearTimeout(controller.syncTimer);
            controller.syncTimer = null;
            // A pending tree sync may be dropped on unmount; syncDeck rebuilds it on next open.
            controller.syncResolve?.();
            controller.syncResolve = null;
        };
    };

    const deckAtom = atom(
        (get) => get(stateAtom),
        (get, set, update: PracticeDeckAction) => {
            const current = get(stateAtom);
            const mutation: PracticeDeckMutation = isMutation(update)
                ? update
                : {
                      type: "sync",
                      positions:
                          typeof update === "function"
                              ? update(current).positions
                              : update.positions,
                  };

            if (identity.file === "") {
                if (mutation.type === "sync") {
                    set(stateAtom, readyState(current, mutation.positions));
                }
                return Promise.resolve();
            }

            if (mutation.type === "retry") {
                const sequence = ++controller.requestSequence;
                const loading = emptyDeck("loading");
                controller.writeBlocked = false;
                controller.committed = null;
                set(stateAtom, loading);
                return startHydration(
                    sequence,
                    loading,
                    (next) => set(stateAtom, next),
                    async () => {
                        clearPracticeIdentityState(identity, true);
                        await ensurePracticeMigration();
                    },
                );
            }

            const observeWrite = (
                run: Promise<PracticeDeckValue>,
                sequence: number,
                pending: PracticeDeckValue,
            ): Promise<void> =>
                run.then(
                    (next) => {
                        if (controller.mounted && sequence === controller.requestSequence) {
                            set(stateAtom, next);
                        }
                    },
                    (error) => {
                        reportWriteFailure(error);
                        const resetApplied =
                            mutation.type === "reset" &&
                            normalizeError(error).category === "applied-despite-error";
                        if (resetApplied) clearPracticeIdentityState(identity, false);
                        if (!controller.mounted || sequence !== controller.requestSequence) return;
                        if (error instanceof PracticeWriteDroppedError) {
                            set(stateAtom, error.deck);
                            return;
                        }
                        if (resetApplied) {
                            const committed = controller.committed ?? pending;
                            set(
                                stateAtom,
                                writeFailureState(
                                    {
                                        ...pending,
                                        revision:
                                            committed.revision === PRACTICE_REVISION_MAX
                                                ? 1
                                                : committed.revision + 1,
                                        generation: committed.generation + 1,
                                        unappliedReviews: 0,
                                        orphansAcknowledged: true,
                                    },
                                    error,
                                ),
                            );
                            return;
                        }
                        set(stateAtom, writeFailureState(pending, error));
                    },
                );

            if (mutation.type === "repair") {
                const sequence = ++controller.requestSequence;
                const pending = {
                    ...current,
                    status: "write-pending" as const,
                    error: undefined,
                };
                set(stateAtom, pending);
                const run = enqueueWrite(controller, {
                    allowWhenBlocked: true,
                    task: async () => {
                        if (current.repairEpoch === undefined) throw queuedWriteNotSaved();
                        try {
                            await repairPracticeDeck(
                                identity.file,
                                identity.game,
                                current.repairEpoch,
                            );
                        } catch (error) {
                            if (normalizeError(error).backendCategory !== "conflict") throw error;
                            clearPracticeIdentityState(identity, true);
                            throw new PracticeWriteDroppedError(
                                await hydrate(identity),
                                error,
                                "queued-write",
                            );
                        }
                        controller.writeBlocked = false;
                        clearPracticeIdentityState(identity, true);
                        return hydrate(identity);
                    },
                });
                return observeWrite(run, sequence, pending);
            }

            if (current.status === "loading" || current.status === "read-failed") {
                return Promise.resolve();
            }
            if (controller.writeBlocked || current.status === "write-blocked") {
                reportWriteFailure(queuedWriteNotSaved());
                return Promise.resolve();
            }

            if (mutation.type === "acknowledge") {
                const sequence = ++controller.requestSequence;
                const pending = {
                    ...current,
                    status: "write-pending" as const,
                    error: undefined,
                };
                set(stateAtom, pending);
                const run = enqueueWrite(controller, {
                    task: async (committed) => {
                        if (!committed) throw queuedWriteNotSaved();
                        await acknowledgePracticeOrphans(
                            identity.file,
                            identity.game,
                            committed.generation,
                            committed.unappliedReviews,
                            payloadEpoch(current),
                        );
                        return readyState(
                            { ...committed, orphansAcknowledged: true },
                            committed.positions,
                        );
                    },
                });
                return observeWrite(run, sequence, pending);
            }

            const sequence = ++controller.requestSequence;
            const syncGeneration = current.generation;
            const computedEpoch = current.epoch;
            const pending = {
                ...current,
                positions: mutation.positions,
                status: "write-pending" as const,
                error: undefined,
            };
            set(stateAtom, pending);

            const run = () =>
                enqueueWrite(controller, {
                    task: async (committed) => {
                        if (!committed) throw queuedWriteNotSaved();
                        if (committed.epoch !== computedEpoch) {
                            throw new PracticeWriteDroppedError(
                                committed,
                                queuedWriteNotSaved(),
                                mutation.type === "rating" ? "rating" : "queued-write",
                            );
                        }
                        if (mutation.type === "rating") {
                            return persistRating(controller.identity, committed, mutation);
                        }
                        if (mutation.type === "reset") {
                            return persistReset(controller.identity, committed, mutation.positions);
                        }
                        return persistSync(
                            controller.identity,
                            committed,
                            mutation.positions,
                            syncGeneration,
                        );
                    },
                });

            if (mutation.type !== "sync") {
                return observeWrite(run(), sequence, pending);
            }

            if (controller.syncTimer) clearTimeout(controller.syncTimer);
            controller.syncResolve?.();
            return new Promise<void>((resolve) => {
                controller.syncResolve = resolve;
                controller.syncTimer = setTimeout(() => {
                    controller.syncTimer = null;
                    controller.syncResolve = null;
                    void observeWrite(run(), sequence, pending).finally(resolve);
                }, PRACTICE_SYNC_DEBOUNCE_MS);
            });
        },
    );
    return deckAtom;
}
