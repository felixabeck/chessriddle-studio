/** Engine and player settings owned jointly by renderer storage and native synchronization. */
import { atom } from "jotai";
import { atomWithStorage, unwrap } from "jotai/utils";
import { z } from "zod";
import type { Engine } from "@/utils/engines";
import {
    createEngineOwnerStorage,
    enginesSchema,
    stampLegacyAssessments,
    saveEngineOwnerValue,
    type EngineOwnerSaveReceipt,
    type EngineOwnerCompletionUpdate,
    type EngineOwnerKey,
    engineOwnerCompletionReceipt,
    refuseUntrustedEnginesUpdate,
} from "../engineOwnerStorage";
import { serializeStorageValue } from "../store/debouncedStorage";
import { initializeRendererState } from "./rendererState";

export { enginesSchema } from "../engineOwnerStorage";

type EngineUpdate =
    | { removeLocalId: string }
    | Engine[]
    | Promise<Engine[]>
    | ((current: Engine[]) => Engine[] | Promise<Engine[]>);

function engineOwnerApplication<Value>(key: EngineOwnerKey, current: Value, update: unknown) {
    if (typeof update !== "object" || update === null || !("completionId" in update)) return;
    const completion = update as EngineOwnerCompletionUpdate<Value>;
    const previous = engineOwnerCompletionReceipt(key, completion.completionId);
    const { value, disposition } = previous
        ? { value: current, disposition: previous }
        : completion.apply(current);
    return { value, receipt: { id: completion.completionId, disposition } };
}

/** Serializes functional calculation, renderer persistence and native synchronization together. */
export function createEngineOwnerAtom<Value, Update, Fallback extends Value | undefined>(
    key: EngineOwnerKey,
    schema: z.ZodType<Value, z.ZodTypeDef, unknown>,
    initialValue: Value,
    fallback: Fallback,
    applyUpdate: (current: Value, update: Update) => Value | Promise<Value>,
    options: {
        normalize?: (current: Value, next: Value) => Value;
        publishOnRefusal?: (update: Update | EngineOwnerCompletionUpdate<Value>) => boolean;
    } = {},
) {
    const ownerStorage = createEngineOwnerStorage(key, schema, initialValue);
    const storage: typeof ownerStorage = {
        ...ownerStorage,
        getItem(key, initialValue) {
            initializeRendererState();
            return ownerStorage.getItem(key, initialValue);
        },
    };
    // The outcome and its promise belong to the reading Jotai store. The public storage
    // fallback cannot distinguish confirmed absence from a failed engines read.
    const enginesRead =
        key === "engines"
            ? atom(() => {
                  initializeRendererState();
                  return ownerStorage.readOutcome(key, initialValue);
              })
            : undefined;
    const stored = enginesRead
        ? unwrap(
              atom(async (get) => {
                  const outcome = await get(enginesRead);
                  return "value" in outcome ? outcome.value : fallback;
              }),
              () => fallback,
          )
        : unwrap(atomWithStorage(key, initialValue, storage), () => fallback);
    // Once a write publishes, it takes precedence over asynchronous storage hydration.
    const published = atom<Value | undefined>(undefined);
    let updates = Promise.resolve();
    return atom(
        (get) => get(published) ?? get(stored),
        (
            get,
            set,
            update: Update | EngineOwnerCompletionUpdate<Value>,
        ): Promise<EngineOwnerSaveReceipt> => {
            const run = updates.then(async () => {
                let current = get(published);
                if (current === undefined && enginesRead) {
                    const outcome = await get(enginesRead);
                    current = get(published);
                    if (current === undefined) {
                        if ("value" in outcome) {
                            current = outcome.value;
                        } else {
                            const derived =
                                typeof update === "function" ||
                                isEngineRemoval(update) ||
                                (typeof update === "object" &&
                                    update !== null &&
                                    "completionId" in update);
                            if (derived) return refuseUntrustedEnginesUpdate(outcome.error);
                            // A complete replacement has no trusted previous assessment base.
                            current = initialValue;
                        }
                    }
                }
                current ??= await storage.getItem(key, initialValue);
                const application = engineOwnerApplication(key, current, update);
                let next: Value;
                if (application) {
                    next = application.value;
                } else {
                    next = await applyUpdate(current, update as Update);
                }
                if (options.normalize) next = options.normalize(current, next);
                if (options.publishOnRefusal?.(update)) set(published, next);
                const receipt = await saveEngineOwnerValue(
                    key,
                    serializeStorageValue(next),
                    application?.receipt,
                );
                if (receipt.saved) set(published, next);
                return receipt;
            });
            updates = run.then(
                () => undefined,
                () => undefined,
            );
            return run;
        },
    );
}

function isEngineRemoval(update: unknown): update is { removeLocalId: string } {
    return typeof update === "object" && update !== null && "removeLocalId" in update;
}

export const enginesAtom = createEngineOwnerAtom(
    "engines",
    enginesSchema,
    [],
    undefined,
    (current, update: EngineUpdate) =>
        isEngineRemoval(update)
            ? current.filter(
                  (engine) => engine.type !== "local" || engine.id !== update.removeLocalId,
              )
            : typeof update === "function"
              ? update(current)
              : update,
    {
        normalize: stampLegacyAssessments,
        // Permanent retirement keeps its session-only omission even on refusal.
        publishOnRefusal: isEngineRemoval,
    },
);
