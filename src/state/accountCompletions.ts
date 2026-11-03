import type { createStore } from "jotai";
import type { AccountCompletion, AccountImportRequest } from "@/bindings";
import { tauri, tauriSubscriptions, TauriCommandError } from "@/platform/tauri";
import { markErrorReported } from "@/platform/errors";
import { notifyListenerError, notifyUnlessCancelled } from "@/components/files/notifyError";
import { notifications } from "@mantine/notifications";
import i18n from "@/i18n";
import { accountCompletionsAtom, databaseConversionStateAtom } from "./atoms";

export const accountCompletionKey = (request: Pick<AccountImportRequest, "provider" | "account">) =>
    `${request.provider}_${request.account.toLowerCase()}`;

type Surface = {
    refresh: (importFailed: boolean) => Promise<void>;
    collectionNotice: (visible: boolean) => void;
};
type Store = ReturnType<typeof createStore>;

function report(error: unknown) {
    notifyUnlessCancelled(i18n.t("Common.Error"), error, "database");
    markErrorReported(error);
    return error;
}

function createAccountObserver(store: Store) {
    const surfaces = new Map<string, Set<Surface>>();
    const applications = new Map<string, { attempt: number; result: Promise<void> }>();
    let live = 0;
    let sequence = Promise.resolve();
    let observations = Promise.resolve();
    let unlisten: (() => void) | undefined;
    let initialization: Promise<void> | undefined;
    let active = true;

    function apply(completion: AccountCompletion): Promise<void> {
        if (!active || completion.outcome.state === "running") return Promise.resolve();
        const previous = applications.get(completion.id);
        if (previous?.attempt === completion.attempt) return previous.result;
        const surface = surfaces
            .get(accountCompletionKey(completion.request))
            ?.values()
            .next().value;
        if (!surface) return Promise.resolve();
        const failure =
            completion.outcome.state === "failed"
                ? new TauriCommandError(completion.outcome.result)
                : undefined;
        const result = sequence
            .then(async () => {
                if (!active) return;
                const retained = await tauri.pendingAccountCompletions();
                if (!active) return;
                if (!retained.some((entry) => entry.id === completion.id)) {
                    // A delayed command or snapshot keeps its rejection after another observer's ack.
                    if (failure) {
                        markErrorReported(failure);
                        throw failure;
                    }
                    return;
                }
                store.set(databaseConversionStateAtom, (previous) =>
                    previous.filter((entry) => entry.id !== `conversion:${completion.id}`),
                );
                if (completion.publication && completion.publication.durability !== "Durable") {
                    notifications.show({
                        message: i18n.t("Home.Accounts.DownloadDurabilityUncertain"),
                        color: "warning",
                    });
                }
                if (failure) {
                    report(failure);
                } else if (completion.outcome.state === "succeeded") {
                    surface.collectionNotice(completion.outcome.result.collectionNotice);
                }
                try {
                    if (completion.publication) await surface.refresh(!!failure);
                } catch (error) {
                    throw report(error);
                }
                if (!active) return;
                await tauri.acknowledgeAccountCompletion(completion.id);
                if (!active) return;
                if (!completion.deletionPending) {
                    store.set(accountCompletionsAtom, (previous) => {
                        const next = new Map(previous);
                        next.delete(accountCompletionKey(completion.request));
                        return next;
                    });
                }
                if (failure) throw failure;
            })
            .catch((error) => {
                throw failure ? report(failure) : error;
            })
            .finally(() => {
                // Only unfinished deletion needs a local receipt. Other replays read native absence.
                if (!completion.deletionPending) applications.delete(completion.id);
            });
        applications.set(completion.id, { attempt: completion.attempt, result });
        sequence = result.catch(() => undefined);
        return result;
    }

    async function readSnapshot() {
        const snapshot = await tauri.pendingAccountCompletions();
        if (!active) return;
        const known = new Set(
            [...store.get(accountCompletionsAtom).values(), ...snapshot].map(
                (entry) => `conversion:${entry.id}`,
            ),
        );
        store.set(databaseConversionStateAtom, (previous) => {
            const importing = new Map(
                snapshot
                    .filter((entry) => entry.importing)
                    .map((entry) => [`conversion:${entry.id}`, entry]),
            );
            const next = previous.filter(
                (entry) => !known.has(entry.id) || importing.delete(entry.id),
            );
            for (const [id, completion] of importing) {
                const { target, account, provider } = completion.request;
                if (completion.outcome.state === "running" && target.kind === "unlinked") {
                    next.push({
                        id,
                        totalGames: 0,
                        elapsedSeconds: 0,
                        targetDatabase: target.database,
                        targetDatabaseTitle: target.title,
                        sourceFileName: `${account}_${provider}.pgn`,
                    });
                }
            }
            return next;
        });
        store.set(
            accountCompletionsAtom,
            new Map(snapshot.map((entry) => [accountCompletionKey(entry.request), entry])),
        );
        for (const completion of snapshot) await apply(completion).catch(notifyListenerError);
    }

    function refresh() {
        const run = observations.then(readSnapshot);
        observations = run.catch(() => undefined);
        return run;
    }

    function initialize() {
        initialization ??= (async () => {
            // Subscribe before the snapshot so a terminal result cannot fall into a delivery gap.
            const disposeSubscription = await tauriSubscriptions.completionChanged(() => {
                if (active) void refresh().catch(notifyListenerError);
            });
            if (!active) return disposeSubscription();
            unlisten = disposeSubscription;
            window.addEventListener("pagehide", dispose, { once: true });
        })().catch((error) => {
            initialization = undefined;
            throw error;
        });
        return initialization;
    }

    function dispose() {
        active = false;
        unlisten?.();
        window.removeEventListener("pagehide", dispose);
        observers.delete(store);
    }

    return {
        observe(key: string, surface: Surface) {
            let views = surfaces.get(key);
            if (!views) surfaces.set(key, (views = new Set()));
            views.add(surface);
            void initialize().then(refresh).catch(notifyListenerError);
            return () => {
                views.delete(surface);
                if (!views.size) surfaces.delete(key);
                if (!surfaces.size && !live) dispose();
            };
        },
        async run(request: AccountImportRequest) {
            live++;
            try {
                const completion = await tauri.importAccountGames(request);
                await apply(completion);
                if (completion.outcome.state === "failed") {
                    throw new TauriCommandError(completion.outcome.result);
                }
            } finally {
                live--;
                if (!surfaces.size) dispose();
            }
        },
    };
}

const observers = new WeakMap<Store, ReturnType<typeof createAccountObserver>>();
function observerFor(store: Store) {
    let observer = observers.get(store);
    if (!observer) {
        observer = createAccountObserver(store);
        observers.set(store, observer);
    }
    return observer;
}

export function observeAccountCompletions(store: Store, key: string, surface: Surface) {
    return observerFor(store).observe(key, surface);
}

/** The caller still rejects with its own command-path error, marked by the shared reporter. */
export async function runAccountImport(store: Store, request: AccountImportRequest): Promise<void> {
    return observerFor(store).run(request);
}
