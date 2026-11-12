import { useId } from "react";
import type { NormalizedGame, PositionStats } from "@/bindings";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useCollectionCurrency } from "@/state/linkedCollections";
import { type LocalOptions, searchPosition } from "@/utils/db";

export async function fetchLocalOpening(
    options: LocalOptions,
    progressId: string,
    signal?: AbortSignal,
) {
    if (!options.path) throw Error("Missing reference database");
    const [openings, games] = await searchPosition(options, progressId, signal);
    return {
        openings: openings.sort(
            (a, b) =>
                b.white + b.draw + b.black + b.unknown - (a.white + a.draw + a.black + a.unknown),
        ),
        games,
    };
}

export type LocalExplorerResult = {
    openings: PositionStats[];
    games: NormalizedGame[];
    loading: boolean;
    error: string | undefined;
    progressId: string;
};

export function useLocalExplorer(
    options: LocalOptions,
    enabled: boolean,
    progressId?: string,
): LocalExplorerResult {
    const fallbackId = useId();
    const id = progressId ?? `local-explorer:${fallbackId}`;
    const { t } = useTranslation();
    const currency = useCollectionCurrency(options.path);
    const unavailable =
        !!currency.error || (!!currency.collection && currency.collection.status !== "ready");
    const dbType = { type: "local", options } as const;
    const key =
        enabled && options.path && !unavailable
            ? currency.collection
                ? ([dbType, currency.collection.generation] as const)
                : dbType
            : null;
    const owner = useNativeRequestOwner(key);
    const { data, isLoading, error } = useSWR<Awaited<ReturnType<typeof fetchLocalOpening>>, Error>(
        key,
        () => owner!.run((signal) => fetchLocalOpening(options, id, signal)),
    );
    return {
        openings: data?.openings ?? [],
        games: data?.games ?? [],
        loading: isLoading,
        error: unavailable
            ? t("Collections.Unavailable", {
                  defaultValue:
                      "The search index is unavailable. Retry, or select the collection's source file again.",
              })
            : inlineFailureMessage(error, "database", t("Databases.LoadError.Title")),
        progressId: id,
    };
}
