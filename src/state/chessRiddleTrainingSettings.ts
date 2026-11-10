import type { AccountError, TrainingSettings } from "@/bindings";
import { ChessRiddleCommandError } from "@/platform/chessriddle";
import { tauri } from "@/platform/tauri";

export const defaultTrainingSettings: TrainingSettings = {
    difficulty: 0,
    motif: null,
    showTimer: false,
    timerMode: "up",
    timerDuration: 300,
};
type Api = Pick<
    typeof tauri,
    "chessriddleTrainingSettings" | "chessriddleSaveTrainingSettings" | "chessriddleTrainingMotifs"
>;
type State = {
    status: "idle" | "loading" | "ready" | "unavailable";
    values: TrainingSettings;
    motifs: string[];
    error: AccountError | null;
    motifError: AccountError | null;
    saveError: AccountError | null;
    saving: boolean;
    reconciling: boolean;
};

/** One account-scoped, memory-only settings owner. Reset retires every pending response. */
export function createTrainingSettingsStore(api: Api) {
    const initial = (): State => ({
        status: "idle",
        values: { ...defaultTrainingSettings },
        motifs: [],
        error: null,
        motifError: null,
        saveError: null,
        saving: false,
        reconciling: false,
    });
    let state = initial();
    let confirmed = { ...defaultTrainingSettings };
    let generation = Symbol();
    let loading: Promise<void> | null = null;
    let motifRequest: symbol | null = null;
    let desired: TrainingSettings | null = null;
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<State>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const readSettings = async (identity: symbol) => {
        try {
            const values = await api.chessriddleTrainingSettings();
            if (generation === identity) {
                confirmed = values;
                publish({ values, status: "ready", error: null });
            }
        } catch (cause) {
            if (generation !== identity) return;
            const code = new ChessRiddleCommandError(cause).code;
            confirmed = { ...defaultTrainingSettings };
            publish({
                status: "unavailable",
                values: { ...defaultTrainingSettings },
                error: code === "updateRequired" ? null : code,
            });
        }
    };
    const readMotifs = async () => {
        const identity = generation;
        const request = Symbol();
        motifRequest = request;
        try {
            const motifs = await api.chessriddleTrainingMotifs();
            if (generation === identity && motifRequest === request)
                publish({ motifs, motifError: null });
        } catch (cause) {
            if (generation === identity && motifRequest === request)
                publish({ motifs: [], motifError: new ChessRiddleCommandError(cause).code });
        } finally {
            if (motifRequest === request) motifRequest = null;
        }
    };
    const load = (force = false): Promise<void> => {
        if (loading) return loading;
        if (!force && state.status !== "idle") return Promise.resolve();
        const identity = generation;
        publish({ status: "loading", error: null });
        const promise = Promise.all([readSettings(identity), readMotifs()])
            .then(() => {})
            .finally(() => {
                if (loading === promise) loading = null;
            });
        loading = promise;
        return promise;
    };
    const drain = async () => {
        if (state.saving || state.reconciling || !desired) return;
        const identity = generation;
        publish({ saving: true, saveError: null });
        try {
            while (desired && generation === identity) {
                const values = desired;
                desired = null;
                const saved = await api.chessriddleSaveTrainingSettings(values);
                if (generation === identity) {
                    confirmed = saved;
                    publish({ values: desired ?? saved });
                }
            }
        } catch (cause) {
            if (generation !== identity) return;
            desired = null;
            publish({ saveError: new ChessRiddleCommandError(cause).code, reconciling: true });
            await readSettings(identity);
        } finally {
            if (generation === identity) publish({ saving: false, reconciling: false });
        }
    };
    return {
        get: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        load,
        async settled() {
            while (state.saving || state.reconciling) {
                await new Promise<void>((resolve) => {
                    const listener = () => {
                        if (state.saving || state.reconciling) return;
                        listeners.delete(listener);
                        resolve();
                    };
                    listeners.add(listener);
                });
            }
        },
        retryMotifs: readMotifs,
        effective: (snapshot = state) => ({
            ...confirmed,
            motif:
                confirmed.motif && snapshot.motifs.includes(confirmed.motif)
                    ? confirmed.motif
                    : null,
        }),
        change(patch: Partial<TrainingSettings>) {
            if (state.status !== "ready" || state.reconciling) return;
            desired = { ...state.values, ...patch };
            publish({ values: desired });
            void drain();
        },
        reset() {
            generation = Symbol();
            loading = null;
            motifRequest = null;
            desired = null;
            confirmed = { ...defaultTrainingSettings };
            state = initial();
            listeners.forEach((listener) => listener());
        },
    };
}

export const trainingSettings = createTrainingSettingsStore({
    chessriddleTrainingSettings: () => tauri.chessriddleTrainingSettings(),
    chessriddleSaveTrainingSettings: (settings) => tauri.chessriddleSaveTrainingSettings(settings),
    chessriddleTrainingMotifs: () => tauri.chessriddleTrainingMotifs(),
});
