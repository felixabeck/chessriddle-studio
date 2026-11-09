import { useEffect, useRef, useState } from "react";
import type { CollectionDescriptor } from "@/bindings";
import { useCollectionCurrencies } from "@/state/linkedCollections";
import { query_games } from "@/utils/db";
import { capabilityKey } from "@/utils/pathCapabilities";
import {
    boundPlayerQuery,
    OwnGamesFeed,
    ownCollections,
    type OwnGamesSnapshot,
} from "./ownGamesFeed";

/** Pass active only for Games, or All with search text. Absent collections disable the feed. */
export function useOwnGamesFeed(
    collections: readonly CollectionDescriptor[] | undefined,
    query: string,
    active: boolean,
) {
    const enabled = active && collections !== undefined;
    useCollectionCurrencies(enabled ? collections : []);
    const boundedQuery = boundPlayerQuery(query);
    const identity = JSON.stringify([
        enabled,
        boundedQuery,
        enabled
            ? collections.map((collection) => [
                  collection.id,
                  collection.generation,
                  collection.status,
                  collection.database ? capabilityKey(collection.database) : null,
              ])
            : [],
    ]);
    const inputs = useRef({ collections, boundedQuery });
    inputs.current = { collections, boundedQuery };
    const session = useRef<{ identity: string; feed: OwnGamesFeed } | null>(null);
    const [state, setState] = useState<{ identity: string; snapshot: OwnGamesSnapshot }>();
    useEffect(() => {
        if (!enabled) return;
        const feed = new OwnGamesFeed(
            inputs.current.collections!,
            inputs.current.boundedQuery,
            query_games,
            (snapshot) => {
                if (session.current?.feed === feed) setState({ identity, snapshot });
            },
        );
        session.current = { identity, feed };
        void feed.showMore();
        return () => {
            session.current = null;
            feed.dispose();
        };
    }, [identity, enabled]);
    const snapshot: OwnGamesSnapshot =
        state?.identity === identity && session.current?.identity === identity
            ? state.snapshot
            : {
                  games: [],
                  loading: enabled,
                  hasMore:
                      enabled &&
                      ownCollections(collections ?? []).some(
                          (collection) => collection.status === "ready",
                      ),
                  failedCollections: [],
                  incompleteCount: enabled
                      ? ownCollections(collections ?? []).filter(
                            (collection) => collection.status !== "ready",
                        ).length
                      : 0,
              };
    return {
        ...snapshot,
        active: enabled,
        showMore: () =>
            session.current?.identity === identity
                ? session.current.feed.showMore()
                : Promise.resolve(),
    };
}
