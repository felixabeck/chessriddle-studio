import equal from "fast-deep-equal";
import type { AsyncStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";
import i18n from "@/i18n";
import { tauri } from "@/platform/tauri";
import { warn } from "@/platform/native";
import { isErrorReported, markErrorReported } from "@/platform/errors";
import { engineSchema, type Engine } from "@/utils/engines";
import { opponentSettingsSchema, type OpponentSettings } from "@/state/opponentSettings";
import { pathRefKey } from "@/utils/pathCapabilities";
import { reportPersistError } from "./persistError";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
import { storageErrorCause } from "./storageError";
import {
    completionReceiptsSchema,
    decodeEngineOwnerValue,
    type CompletionDisposition,
} from "./engineOwnerEnvelope";

export {
    decodeEngineOwnerValue,
    MAX_ENGINE_COMPLETION_RECEIPTS,
    type CompletionDisposition,
} from "./engineOwnerEnvelope";

export const ENGINE_OWNER_KEYS = [
    "engines",
    "game-player1-settings",
    "game-player2-settings",
] as const;
export type EngineOwnerKey = (typeof ENGINE_OWNER_KEYS)[number];

/** Presence, including corrupt or empty bytes, distinguishes an existing profile from a new one. */
export function enginesStorageKeyAbsent(): boolean {
    try {
        return localStorage.getItem("engines") === null;
    } catch {
        return false;
    }
}

export type EngineOwnerCompletionUpdate<Value> = {
    completionId: string;
    apply: (current: Value) => { value: Value; disposition: CompletionDisposition };
};

export function engineOwnerCompletionReceipt(
    key: EngineOwnerKey,
    id: string,
): CompletionDisposition | undefined {
    try {
        return readPersistedEngineOwner(key)?.receipts[id];
    } catch (cause) {
        throw ownerStorageError(cause);
    }
}

function readPersistedEngineOwner(key: EngineOwnerKey, repairInvalidEngines = false) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const decoded = decodeCompressedOrJson(raw);
    const owner = decoded === null ? null : decodeEngineOwnerValue(decoded);
    if (!owner || !parseHydratableOwner(key, owner.value)) {
        if (key !== "engines" || !repairInvalidEngines) throw new Error("invalid owner");
        // Only a decoded owner supplies receipts. Malformed recovered evidence still refuses
        // repair, even when the surrounding bytes do not decode as an owner envelope.
        if (!owner && isRecord(decoded) && "receipts" in decoded) {
            completionReceiptsSchema.parse(decoded.receipts);
        }
        return { value: undefined, receipts: owner?.receipts ?? {} };
    }
    return owner;
}

function encodeEngineOwnerValue(
    value: unknown,
    receipts: Record<string, CompletionDisposition>,
): string {
    return serializeStorageValue({ version: 1, value, receipts });
}

export interface EngineOwnerSaveReceipt {
    operationId: string;
    key: EngineOwnerKey;
    saved: boolean;
    synchronized: boolean;
    error?: unknown;
    completionDisposition?: CompletionDisposition;
}

const schemas: Record<EngineOwnerKey, z.ZodTypeAny> = {
    engines: z.array(engineSchema),
    "game-player1-settings": opponentSettingsSchema,
    "game-player2-settings": opponentSettingsSchema,
};

export interface EngineOwnerInspection {
    capabilityIds: string[];
    attachmentIds: string[];
}

export interface EngineOwnerStartupSnapshot {
    capabilityIds: string[];
    attachmentIds: string[] | null;
    trusted: boolean;
}

function collectEngineIds(engine: Engine, capabilityIds: Set<string>, attachmentIds: Set<string>) {
    if (engine.imageHandle) {
        const id = pathRefKey(engine.imageHandle.id);
        capabilityIds.add(id);
        attachmentIds.add(id);
    }
    for (const setting of engine.settings ?? []) {
        if (setting.type === "resource") {
            for (const resource of setting.resources) {
                const id = pathRefKey(resource.id);
                capabilityIds.add(id);
                attachmentIds.add(id);
            }
        }
    }
    if (engine.type === "local") capabilityIds.add(pathRefKey(engine.handle.id));
}

function inspectParsedEngineOwner(key: EngineOwnerKey, parsed: unknown): EngineOwnerInspection {
    const capabilityIds = new Set<string>();
    const attachmentIds = new Set<string>();

    if (key === "engines") {
        for (const engine of parsed as Engine[]) {
            collectEngineIds(engine, capabilityIds, attachmentIds);
        }
    } else {
        const opponent = parsed as OpponentSettings;
        if (opponent.type === "engine") {
            if (opponent.engine) {
                collectEngineIds(opponent.engine, capabilityIds, attachmentIds);
            }
            for (const setting of opponent.engineSettings ?? []) {
                if (setting.type === "resource") {
                    for (const resource of setting.resources) {
                        const id = pathRefKey(resource.id);
                        capabilityIds.add(id);
                        attachmentIds.add(id);
                    }
                }
            }
        }
    }

    return {
        capabilityIds: [...capabilityIds].sort(),
        attachmentIds: [...attachmentIds].sort(),
    };
}

/** Strict owner validation used by startup evidence and every durable write. */
export function inspectEngineOwnerValue(
    key: EngineOwnerKey,
    value: unknown,
): EngineOwnerInspection | null {
    const owner = decodeEngineOwnerValue(value);
    if (!owner) return null;
    const parsed = schemas[key].safeParse(owner.value);
    if (!parsed.success || !equal(owner.value, parsed.data)) return null;
    return inspectParsedEngineOwner(key, parsed.data);
}

export function collectAttachmentIds(key: EngineOwnerKey, value: unknown): string[] | null {
    return inspectEngineOwnerValue(key, value)?.attachmentIds ?? null;
}

/** Reads each owner key once, preserving strict raw evidence for both startup owner families. */
export function collectOriginalEngineOwnerSnapshot(local: Storage): EngineOwnerStartupSnapshot {
    const capabilityIds = new Set<string>();
    const attachmentIds = new Set<string>();
    let trusted = true;

    for (const key of ENGINE_OWNER_KEYS) {
        const inspected = readOwner(key, local);
        if (inspected === null) {
            trusted = false;
            continue;
        }
        inspected.capabilityIds.forEach((id) => capabilityIds.add(id));
        inspected.attachmentIds.forEach((id) => attachmentIds.add(id));
    }

    return {
        capabilityIds: [...capabilityIds].sort(),
        attachmentIds: trusted ? [...attachmentIds].sort() : null,
        trusted,
    };
}

function readOwner(key: EngineOwnerKey, local?: Storage): EngineOwnerInspection | null {
    try {
        const raw = (local ?? localStorage).getItem(key);
        if (raw === null) return { capabilityIds: [], attachmentIds: [] };
        const decoded = decodeCompressedOrJson(raw);
        return decoded === null ? null : inspectEngineOwnerValue(key, decoded);
    } catch {
        return null;
    }
}

let sequence = Promise.resolve();

const LEGACY_OWNER_CONFLICT = "persisted engine owner changed during identity migration";

function ownerStorageError(cause: unknown) {
    return new Error(`${i18n.t("Engines.SaveError")} ${storageErrorCause(cause)}`, { cause });
}

function reportOwnerStorageError(cause: unknown) {
    const error = typeof cause === "object" && cause !== null ? cause : new Error(String(cause));
    if (!isErrorReported(error)) {
        reportPersistError(error);
        markErrorReported(error);
    }
    return error;
}

export function refuseUntrustedEnginesUpdate(cause: unknown): EngineOwnerSaveReceipt {
    const error = reportOwnerStorageError(ownerStorageError(cause));
    return {
        operationId: crypto.randomUUID(),
        key: "engines",
        saved: false,
        synchronized: false,
        error,
    };
}

function enqueueEngineOwnerSave(
    key: EngineOwnerKey,
    encodedValue: string,
    expectedRaw?: string,
    completion?: { id: string; disposition: CompletionDisposition },
): Promise<EngineOwnerSaveReceipt> {
    const operationId = crypto.randomUUID();
    const run = sequence.then(async (): Promise<EngineOwnerSaveReceipt> => {
        const decoded = decodeCompressedOrJson(encodedValue);
        const incoming = decoded === null ? null : decodeEngineOwnerValue(decoded);
        const changedIds = incoming === null ? null : collectAttachmentIds(key, incoming.value);
        if (changedIds === null) {
            const error = new Error("refusing to persist an invalid engine owner record");
            reportOwnerStorageError(error);
            return { operationId, key, saved: false, synchronized: false, error };
        }

        let previous: ReturnType<typeof decodeEngineOwnerValue>;
        try {
            previous = readPersistedEngineOwner(key, key === "engines");
        } catch (cause) {
            const error = ownerStorageError(cause);
            reportOwnerStorageError(error);
            return { operationId, key, saved: false, synchronized: false, error };
        }
        const receipts = { ...previous?.receipts };
        if (completion) {
            if (receipts[completion.id]) {
                return {
                    operationId,
                    key,
                    saved: true,
                    synchronized: true,
                    completionDisposition: receipts[completion.id],
                };
            }
            receipts[completion.id] = completion.disposition;
        }
        if (!completionReceiptsSchema.safeParse(receipts).success) {
            const error = ownerStorageError("completion receipt limit");
            reportOwnerStorageError(error);
            return { operationId, key, saved: false, synchronized: false, error };
        }
        const encodedOwner = encodeEngineOwnerValue(incoming?.value, receipts);

        const union = new Set(changedIds);
        let allTrusted = true;
        for (const ownerKey of ENGINE_OWNER_KEYS) {
            if (ownerKey === key) continue;
            const owner = readOwner(ownerKey);
            allTrusted &&= owner !== null;
            owner?.attachmentIds.forEach((id) => union.add(id));
        }
        const retainedIds = [...union].sort().map((id) => ({ id }));
        try {
            await tauri.reconcileEngineAttachments({
                action: "prepare",
                retained_ids: retainedIds,
            });
        } catch (cause) {
            const error = reportOwnerStorageError(cause);
            return { operationId, key, saved: false, synchronized: false, error };
        }
        try {
            if (expectedRaw !== undefined && localStorage.getItem(key) !== expectedRaw) {
                return {
                    operationId,
                    key,
                    saved: false,
                    synchronized: false,
                    error: new Error(LEGACY_OWNER_CONFLICT),
                };
            }
            localStorage.setItem(key, encodedOwner);
        } catch (cause) {
            const error = ownerStorageError(cause);
            reportOwnerStorageError(error);
            return { operationId, key, saved: false, synchronized: false, error };
        }
        if (!allTrusted) return { operationId, key, saved: true, synchronized: false };
        try {
            await tauri.reconcileEngineAttachments({
                action: "reconcile",
                retained_ids: retainedIds,
                abandoned_ids: [],
                startup: false,
            });
            return {
                operationId,
                key,
                saved: true,
                synchronized: true,
                completionDisposition: completion?.disposition,
            };
        } catch (cause) {
            const error = reportOwnerStorageError(cause);
            return { operationId, key, saved: true, synchronized: false, error };
        }
    });
    sequence = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export function saveEngineOwnerValue(
    key: EngineOwnerKey,
    encodedValue: string,
    completion?: { id: string; disposition: CompletionDisposition },
): Promise<EngineOwnerSaveReceipt> {
    return enqueueEngineOwnerSave(key, encodedValue, undefined, completion);
}

/** Only a successful native snapshot can authorize pruning. An uncertain acknowledgement keeps
 * evidence until a later snapshot proves the operation is absent. Ordinary writes retain it. */
export function pruneEngineCompletionReceipts(pendingIds: ReadonlySet<string>): Promise<void> {
    const run = sequence
        .then(() => {
            for (const key of ENGINE_OWNER_KEYS) {
                const owner = readPersistedEngineOwner(key);
                if (!owner) continue;
                const retained = Object.fromEntries(
                    Object.entries(owner.receipts).filter(([id]) => pendingIds.has(id)),
                );
                if (Object.keys(retained).length !== Object.keys(owner.receipts).length) {
                    localStorage.setItem(key, encodeEngineOwnerValue(owner.value, retained));
                }
            }
        })
        .catch((cause) => {
            const error = ownerStorageError(cause);
            reportOwnerStorageError(error);
            throw error;
        });
    sequence = run.catch(() => undefined);
    return run;
}

function migrateEngineOwnerValue(
    key: EngineOwnerKey,
    encodedValue: string,
    expectedRaw: string,
): Promise<EngineOwnerSaveReceipt> {
    return enqueueEngineOwnerSave(key, encodedValue, expectedRaw);
}

function enqueueNativeAttachmentAction(
    action: Parameters<typeof tauri.reconcileEngineAttachments>[0],
) {
    const run = sequence.then(() => tauri.reconcileEngineAttachments(action));
    sequence = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export function abandonEngineAttachments(ids: Array<{ id: string }>) {
    if (ids.length === 0) return Promise.resolve();
    return enqueueNativeAttachmentAction({
        action: "reconcile",
        retained_ids: null,
        abandoned_ids: ids,
        startup: false,
    });
}

export function reconcileStartupEngineAttachments(
    retainedIds: Array<{ id: string }> | null,
    prerequisite: Promise<unknown>,
) {
    // Reserve this position synchronously. A save beginning while native startup is delayed queues
    // behind the original snapshot instead of being retired by that older evidence afterwards.
    const run = sequence.then(async () => {
        await prerequisite;
        if (retainedIds === null) return;
        await tauri.reconcileEngineAttachments({
            action: "reconcile",
            retained_ids: retainedIds,
            abandoned_ids: [],
            startup: true,
        });
    });
    sequence = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IDENTITY_PREFIX = "legacy-engine-identity:";
const FNV1A_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_PRIME = 0x100000001b3n;
const POSITION_PREFIX = "legacy-engine-position:";

/** FNV-1a over an unambiguous pair of UTF-16 strings, with fixed 64-bit state. */
function legacyIdentity(handleId: string, name: string): string {
    let digest = FNV1A_OFFSET_BASIS;
    const pair = JSON.stringify([handleId, name]);
    for (let index = 0; index < pair.length; index++) {
        digest = BigInt.asUintN(64, (digest ^ BigInt(pair.charCodeAt(index))) * FNV1A_PRIME);
    }
    return `${IDENTITY_PREFIX}${digest.toString(16).padStart(16, "0")}`;
}

function recordIdentity(value: unknown): string | null {
    if (!isRecord(value) || value.type !== "local" || typeof value.name !== "string") return null;
    const handle = value.handle;
    if (!isRecord(handle) || !isRecord(handle.id) || typeof handle.id.id !== "string") return null;
    return legacyIdentity(handle.id.id, value.name);
}

function identityGroups(values: readonly unknown[]): Map<string, number> {
    const groups = new Map<string, number>();
    for (const value of values) {
        const identity = recordIdentity(value);
        if (identity !== null) groups.set(identity, (groups.get(identity) ?? 0) + 1);
    }
    return groups;
}

/** Assign on copies before element defaults; reserve even ids on invalid raw entries. */
function assignLegacyIds(decoded: unknown): unknown {
    if (!Array.isArray(decoded)) return decoded;
    const reserved = new Set<string>(
        decoded.flatMap((value) =>
            isRecord(value) && typeof value.id === "string" ? [value.id] : [],
        ),
    );
    const groups = identityGroups(decoded);
    const seen = new Set<string>();
    return decoded.map((value, index) => {
        if (!isRecord(value)) return value;
        if (typeof value.id === "string" && !seen.has(value.id)) {
            seen.add(value.id);
            return { ...value };
        }
        const identity = recordIdentity(value);
        let id =
            typeof value.id !== "string" &&
            identity !== null &&
            groups.get(identity) === 1 &&
            !reserved.has(identity) &&
            !seen.has(identity)
                ? identity
                : `${POSITION_PREFIX}${index}`;
        // A raw record can already hold a positional id. Bounded probing reserves the whole list.
        for (let suffix = 0; reserved.has(id) || seen.has(id); suffix++) {
            id = `${POSITION_PREFIX}${index}:${suffix}`;
        }
        seen.add(id);
        return { ...value, id };
    });
}

function assessLegacyEngines(engines: Engine[]): Engine[] {
    const groups = identityGroups(engines);
    return engines.map((engine) => {
        if (engine.type !== "local" || Object.hasOwn(engine, "legacyAssessment")) return engine;
        const identity = legacyIdentity(engine.handle.id.id, engine.name);
        const derived =
            engine.id.startsWith(IDENTITY_PREFIX) || engine.id.startsWith(POSITION_PREFIX);
        return {
            ...engine,
            legacyAssessment: derived
                ? null
                : {
                      identity,
                      ambiguous: (groups.get(identity) ?? 0) > 1,
                  },
        };
    });
}

const zodArray = <Input, Output>(itemSchema: z.ZodType<Output, z.ZodTypeDef, Input>) => {
    const catchValue = {} as never;
    return z
        .array(itemSchema.catch(catchValue))
        .transform((items) => items.filter((item): item is Output => item !== catchValue))
        .catch([]) as z.ZodType<Output[], z.ZodTypeDef, Input[]>;
};

export const enginesSchema = z
    .preprocess(assignLegacyIds, zodArray(engineSchema))
    .transform(assessLegacyEngines);

/** Only the engines owner controls assessment, including copies submitted by editors. */
export function stampLegacyAssessments(current: Engine[], next: Engine[]): Engine[] {
    const previous = new Map(current.map((engine) => [engine.id, engine]));
    return next.map((engine) => {
        const { legacyAssessment: _submitted, ...copy } = engine as Engine & {
            legacyAssessment?: unknown;
        };
        if (engine.type !== "local") return copy as Engine;
        const existing = previous.get(engine.id);
        if (existing?.type === "local") {
            return Object.hasOwn(existing, "legacyAssessment")
                ? ({ ...copy, legacyAssessment: existing.legacyAssessment } as Engine)
                : (copy as Engine);
        }
        return { ...copy, legacyAssessment: null } as Engine;
    });
}

function compareLegacyEngineFields(raw: unknown, parsed: unknown): boolean {
    if (!isRecord(raw) || !isRecord(parsed)) return false;
    const { id: _rawId, ...rawWithoutId } = raw;
    const { id: _parsedId, ...parsedWithoutId } = parsed;
    return equal(rawWithoutId, parsedWithoutId);
}

function isAllowedEngineIdentityRepair(
    raw: unknown,
    parsed: unknown,
    rawIds: Set<string>,
    seenRawIds: Set<string>,
    seenParsedIds: Set<string>,
): boolean {
    if (!isRecord(raw) || !isRecord(parsed) || typeof parsed.id !== "string") return false;
    if (!compareLegacyEngineFields(raw, parsed)) return false;
    if (typeof raw.id !== "string") {
        return !rawIds.has(parsed.id) && !seenParsedIds.has(parsed.id);
    }
    if (raw.id === parsed.id) return true;
    return seenRawIds.has(raw.id) && !rawIds.has(parsed.id) && !seenParsedIds.has(parsed.id);
}

function isLegacyIdentityMigration(key: EngineOwnerKey, raw: unknown, parsed: unknown): boolean {
    let migrated = false;
    if (key === "engines") {
        if (!Array.isArray(raw) || !Array.isArray(parsed) || raw.length !== parsed.length) {
            return false;
        }
        const rawIds = new Set(
            raw.flatMap((value) =>
                isRecord(value) && typeof value.id === "string" ? [value.id] : [],
            ),
        );
        const seenRawIds = new Set<string>();
        const seenParsedIds = new Set<string>();
        for (const [index, value] of raw.entries()) {
            const parsedValue = parsed[index];
            // Assessment is the only extra field the engines owner may introduce. Existing
            // evidence, and every field on a player snapshot, must remain byte-for-byte exact.
            const comparisonValue =
                isRecord(value) &&
                value.type === "local" &&
                !Object.hasOwn(value, "legacyAssessment") &&
                isRecord(parsedValue) &&
                Object.hasOwn(parsedValue, "legacyAssessment")
                    ? { ...value, legacyAssessment: parsedValue.legacyAssessment }
                    : value;
            if (
                !isAllowedEngineIdentityRepair(
                    comparisonValue,
                    parsedValue,
                    rawIds,
                    seenRawIds,
                    seenParsedIds,
                )
            ) {
                return false;
            }
            if (isRecord(value) && typeof value.id === "string") seenRawIds.add(value.id);
            seenParsedIds.add((parsedValue as { id: string }).id);
            migrated ||= !equal(value, parsedValue);
        }
        return migrated;
    }
    if (!isRecord(raw) || !isRecord(parsed) || raw.type !== "engine" || parsed.type !== "engine") {
        return false;
    }
    const { engine: rawEngine, ...rawWithoutEngine } = raw;
    const { engine: parsedEngine, ...parsedWithoutEngine } = parsed;
    if (!equal(rawWithoutEngine, parsedWithoutEngine)) return false;
    if (rawEngine === null || parsedEngine === null) return false;
    const wasMissing = isRecord(rawEngine) && typeof rawEngine.id !== "string";
    return (
        wasMissing &&
        isRecord(parsedEngine) &&
        typeof parsedEngine.id === "string" &&
        compareLegacyEngineFields(rawEngine, parsedEngine)
    );
}

function parseHydratableOwner(
    key: EngineOwnerKey,
    decoded: unknown,
    schema: z.ZodTypeAny = schemas[key],
) {
    const owner = decodeEngineOwnerValue(decoded);
    if (!owner) return null;
    decoded = owner.value;
    let input = key === "engines" ? assignLegacyIds(decoded) : decoded;
    let trustedEngines = true;
    if (
        key !== "engines" &&
        isRecord(decoded) &&
        decoded.type === "engine" &&
        isRecord(decoded.engine) &&
        typeof decoded.engine.id !== "string"
    ) {
        const identity = recordIdentity(decoded.engine);
        if (identity === null) return null;
        const evidence = readHydratableEngines();
        trustedEngines = evidence !== null;
        const engines = evidence ?? [];
        const claims = engines.filter(
            (engine) =>
                engine.type === "local" &&
                engine.legacyAssessment?.identity === identity &&
                !engine.legacyAssessment.ambiguous,
        );
        const id = engines.some((engine) => engine.id === identity)
            ? identity
            : claims.length === 1
              ? claims[0].id
              : identity;
        input = { ...decoded, engine: { ...decoded.engine, id } };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return null;
    if (equal(decoded, parsed.data)) return { value: parsed.data, migrate: false };
    if (!isLegacyIdentityMigration(key, decoded, parsed.data)) return null;
    return { value: parsed.data, migrate: trustedEngines };
}

function readHydratableEngines(): Engine[] | null {
    try {
        const raw = localStorage.getItem("engines");
        if (raw === null) return [];
        const decoded = decodeCompressedOrJson(raw);
        if (decoded === null) return null;
        const hydrated = parseHydratableOwner("engines", decoded, enginesSchema);
        if (!hydrated) return null;
        const engines = hydrated.value as Engine[];
        const rawList = decodeEngineOwnerValue(decoded)?.value as Record<string, unknown>[];
        if (
            !rawList.some(
                (engine) => engine.type === "local" && Object.hasOwn(engine, "legacyAssessment"),
            )
        ) {
            return engines;
        }
        // Player fallback assessment is permitted only before any local record was assessed.
        return engines.map((engine, index) => {
            if (engine.type !== "local" || Object.hasOwn(rawList[index], "legacyAssessment"))
                return engine;
            const { legacyAssessment: _assessment, ...unassessed } = engine;
            return unassessed;
        });
    } catch {
        return null;
    }
}

export function createEngineOwnerStorage<Value>(
    key: EngineOwnerKey,
    schema: z.ZodType<Value, z.ZodTypeDef, unknown>,
    initialValue: Value,
): AsyncStorage<Value> & {
    readOutcome: (
        storageKey: string,
        initialValue: Value,
    ) => Promise<{ value: Value } | { error: unknown }>;
} {
    const readOutcome = async (
        storageKey: string,
        initialValue: Value,
        allowMigrationRetry: boolean,
    ): Promise<{ value: Value } | { error: unknown }> => {
        if (storageKey !== key) throw new Error("engine owner storage key mismatch");
        let raw: string | null;
        try {
            raw = localStorage.getItem(key);
        } catch (error) {
            warn(`Unable to read persisted value for ${key}`);
            return { error };
        }
        if (raw === null) return { value: initialValue };
        const decoded = decodeCompressedOrJson(raw);
        const hydrated = decoded === null ? null : parseHydratableOwner(key, decoded, schema);
        if (!hydrated) {
            warn(`Invalid persisted value for ${key}`);
            return { error: new Error("invalid owner") };
        }
        if (!hydrated.migrate || !allowMigrationRetry) return { value: hydrated.value as Value };

        const migrated = await migrateEngineOwnerValue(
            key,
            serializeStorageValue(hydrated.value),
            raw,
        );
        if (!migrated.saved && migrated.error instanceof Error) {
            if (migrated.error.message === LEGACY_OWNER_CONFLICT) {
                return readOutcome(storageKey, initialValue, false);
            }
            return { value: hydrated.value as Value };
        }
        return { value: hydrated.value as Value };
    };
    const storage = {
        readOutcome(storageKey: string, initialValue: Value) {
            return readOutcome(storageKey, initialValue, true);
        },
        async getItem(storageKey: string, initialValue: Value): Promise<Value> {
            const outcome = await readOutcome(storageKey, initialValue, true);
            return "value" in outcome ? outcome.value : initialValue;
        },
        async setItem(storageKey: string, value: Value) {
            if (storageKey !== key) throw new Error("engine owner storage key mismatch");
            return saveEngineOwnerValue(key, serializeStorageValue(value));
        },
        async removeItem(storageKey: string) {
            if (storageKey !== key) throw new Error("engine owner storage key mismatch");
            return saveEngineOwnerValue(key, serializeStorageValue(initialValue));
        },
    };
    // Jotai forwards the async storage result from atom writes. AsyncStorage narrows that result
    // to Promise<void>, while the dedicated owner atom recovers the runtime receipt.
    return storage as unknown as AsyncStorage<Value> & Pick<typeof storage, "readOutcome">;
}

export function resetEngineOwnerCoordinatorForTests() {
    sequence = Promise.resolve();
}
