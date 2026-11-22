import { atom } from "jotai";
import { atomWithStorage, loadable } from "jotai/utils";
import { z } from "zod";
import type { CoachError, ConnectionSummary, ModelInfo } from "@/bindings";
import { coachErrorCode } from "@/platform/coach";
import { warn } from "@/platform/native";
import { tauri } from "@/platform/tauri";
import type { Engine, LocalEngine } from "@/utils/engines";
import { createZodStorage } from "./utils";

/**
 * Whether this build has the Coach. Read once per document: the native switch cannot change while
 * the app runs. A failed read counts as "not available" so nothing of the Coach is rendered.
 */
const coachAvailableAtom = atom(async () => {
    try {
        return await tauri.coachAvailable();
    } catch {
        return false;
    }
});
const coachAvailableLoadableAtom = loadable(coachAvailableAtom);

/** `true` only once the native side has confirmed the Coach; `false` while that is still unknown. */
export const coachEnabledAtom = atom((get) => {
    const available = get(coachAvailableLoadableAtom);
    return available.state === "hasData" && available.data;
});

export type CoachConnectionsState =
    | { status: "loading" }
    | { status: "ready"; connections: ConnectionSummary[] }
    | { status: "failed"; error: CoachError };

const connectionsStateAtom = atom<CoachConnectionsState>({ status: "loading" });
const connectionsRequestAtom = atom(0);

/**
 * The native connection list. It is the only source: nothing about a connection is persisted
 * here. Mounting reads it, writing re-reads it (after a save or removal); the list shown stays in
 * place while a re-read runs, and only the newest read is accepted.
 */
export const coachConnectionsAtom = atom(
    (get) => get(connectionsStateAtom),
    async (get, set) => {
        const request = get(connectionsRequestAtom) + 1;
        set(connectionsRequestAtom, request);
        let next: CoachConnectionsState;
        try {
            next = { status: "ready", connections: await tauri.coachConnections() };
        } catch (cause) {
            next = { status: "failed", error: coachErrorCode(cause) };
        }
        if (get(connectionsRequestAtom) === request) set(connectionsStateAtom, next);
    },
);
coachConnectionsAtom.onMount = (reload) => {
    void reload();
};

export type CoachModelsState =
    | { connection: string | null; status: "idle" | "loading" }
    | { connection: string; status: "ready"; models: ModelInfo[]; truncated: boolean }
    | { connection: string; status: "failed"; error: CoachError };

const modelsStateAtom = atom<CoachModelsState>({ connection: null, status: "idle" });

/**
 * The model list of one connection, as the provider reports it now. Writing a connection handle
 * loads its list (again); only the answer for the connection asked last is accepted.
 */
export const coachModelsAtom = atom(
    (get) => get(modelsStateAtom),
    async (get, set, connection: string | null) => {
        if (connection === null) {
            set(modelsStateAtom, { connection: null, status: "idle" });
            return;
        }
        set(modelsStateAtom, { connection, status: "loading" });
        let next: CoachModelsState;
        try {
            const list = await tauri.coachModels(connection);
            next = { connection, status: "ready", models: list.models, truncated: list.truncated };
        } catch (cause) {
            next = { connection, status: "failed", error: coachErrorCode(cause) };
        }
        const current = get(modelsStateAtom);
        if (current.connection === connection && current.status === "loading") {
            set(modelsStateAtom, next);
        }
    },
);

const MAX_NOTICE_CONNECTIONS = 64;

/**
 * The connections for which the user accepted the first-use notice (what is sent to whom). Kept
 * per connection handle, newest last; without an entry no turn is started for that connection.
 */
export const coachNoticeAcceptedAtom = atomWithStorage<string[]>(
    "coach-notice-accepted",
    [],
    createZodStorage(z.array(z.string().max(64)).max(MAX_NOTICE_CONNECTIONS), localStorage),
);

/** Opens the provider's page where the usage of a ChatGPT plan is managed, in the system browser. */
export function openCoachUsage() {
    tauri.coachOpenUsage().catch((cause: unknown) => {
        void warn(`The usage page could not be opened: ${String(cause)}`);
    });
}

/**
 * Whether the user has seen, once, that a ChatGPT sign-in means requests use their ChatGPT plan.
 * The provider asks for that notice at the first sign-in and not again.
 */
export const coachPlanNoticeSeenAtom = atomWithStorage<boolean>(
    "coach-plan-notice-seen",
    false,
    createZodStorage(z.boolean(), localStorage),
);

export function withCoachNoticeAccepted(accepted: readonly string[], connection: string) {
    return [...accepted.filter((handle) => handle !== connection), connection].slice(
        -MAX_NOTICE_CONNECTIONS,
    );
}

/** `null` effort means "provider default": no effort level is sent. */
const selectionSchema = z.object({
    connection: z.string().max(64).nullable(),
    model: z.string().max(200).nullable(),
    effort: z.string().max(32).nullable(),
});

export type CoachSelection = z.output<typeof selectionSchema>;

const NO_SELECTION: CoachSelection = { connection: null, model: null, effort: null };

/** What the user last chose. It names native things, so every read goes through `effectiveCoachSelection`. */
export const coachSelectionAtom = atomWithStorage<CoachSelection>(
    "coach-selection",
    NO_SELECTION,
    createZodStorage(selectionSchema, localStorage),
);

export const COACH_EFFORT_LEVELS = ["low", "medium", "high"] as const;

/** The effort levels the selector offers for a model: the provider's own list, or the common three. */
export function coachEffortLevels(model: ModelInfo | null): readonly string[] {
    return model && model.effortLevels.length > 0 ? model.effortLevels : COACH_EFFORT_LEVELS;
}

/**
 * The effort that applies when the user chose none: for a model whose provider reports its levels,
 * an explicit level (`medium` if offered, else the provider's stated default, else the first); for
 * every other model nothing is sent.
 */
export function defaultCoachEffort(model: ModelInfo | null): string | null {
    if (!model || model.effortLevels.length === 0) return null;
    if (model.effortLevels.includes("medium")) return "medium";
    return model.defaultEffort ?? model.effortLevels[0];
}

export type EffectiveCoachSelection = {
    connection: ConnectionSummary | null;
    model: ModelInfo | null;
    effort: string | null;
};

/**
 * The stored selection checked against what exists now. A connection or model that is gone yields
 * "none selected"; it is never replaced by another one. `models` is `null` while the list is not
 * loaded, which leaves the stored model and effort undecided rather than cleared.
 */
export function effectiveCoachSelection(
    selection: CoachSelection,
    connections: readonly ConnectionSummary[],
    models: readonly ModelInfo[] | null,
): EffectiveCoachSelection {
    const connection =
        connections.find((candidate) => candidate.handle === selection.connection) ?? null;
    if (!connection || !models) return { connection, model: null, effort: null };
    const model = models.find((candidate) => candidate.id === selection.model) ?? null;
    if (!model) return { connection, model: null, effort: null };
    const reported = model.effortLevels.length > 0;
    const offered = coachEffortLevels(model);
    const effort =
        selection.effort !== null && offered.includes(selection.effort)
            ? selection.effort
            : reported
              ? defaultCoachEffort(model)
              : null;
    return { connection, model, effort };
}

/** The engine the user picked for the Coach, by its immutable id. */
export const coachEngineAtom = atomWithStorage<string | null>(
    "coach-engine",
    null,
    createZodStorage(z.string().max(128).nullable(), localStorage),
);

function usable(engine: Engine): engine is LocalEngine {
    return engine.type === "local" && engine.loaded === true;
}

/** The loaded local engines the Coach can run. */
export function coachEngines(engines: readonly Engine[] | undefined): LocalEngine[] {
    return engines?.filter(usable) ?? [];
}

/** The picked engine while it is still a loaded local engine, otherwise the first one, otherwise none. */
export function effectiveCoachEngine(
    engines: readonly Engine[] | undefined,
    picked: string | null,
): LocalEngine | null {
    const candidates = coachEngines(engines);
    return candidates.find((engine) => engine.id === picked) ?? candidates[0] ?? null;
}
