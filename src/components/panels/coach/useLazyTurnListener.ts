import { useStore } from "jotai";
import { warnSafely } from "@/platform/errors";
import { useTauriListener } from "@/platform/useTauriListener";

type Atoms = ReturnType<typeof useStore>;

/**
 * Caches a dynamic module import so concurrent events await the same load and apply in arrival
 * order. A failed import clears the cache so the next event retries.
 */
export function createLazyModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
    let pending: Promise<Module> | undefined;
    return () => {
        pending ??= load().catch((cause: unknown) => {
            pending = undefined;
            throw cause;
        });
        return pending;
    };
}

/**
 * Subscribes once to a turn-event channel and dispatches each payload into a lazily loaded
 * turn-state module.
 */
export function useLazyTurnListener<Payload, Module>({
    subscribe,
    load,
    apply,
    errorLabel,
}: {
    subscribe: (handler: (event: { payload: Payload }) => void) => Promise<() => void>;
    load: () => Promise<Module>;
    apply: (module: Module, atoms: Atoms, payload: Payload) => void;
    errorLabel: string;
}) {
    const atoms = useStore();
    useTauriListener(
        subscribe,
        async (event) => {
            const module = await load();
            apply(module, atoms, event.payload);
        },
        { onError: (error) => warnSafely(`${errorLabel}: ${error.message}`) },
    );
}
