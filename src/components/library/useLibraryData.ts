import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import {
    databaseConversionStateAtom,
    fileWorkspaceAtom,
    lastOpenedAtom,
    recentFilesAtom,
} from "@/state/atoms";
import { projectLibrary } from "./libraryData";
import { useWorkspaceListing } from "./useWorkspaceListing";

/** No Library actions or database-view mount effects run in this read-only source. */
export function useLibraryData() {
    const workspace = useAtomValue(fileWorkspaceAtom);
    const recents = useAtomValue(recentFilesAtom);
    const lastOpened = useAtomValue(lastOpenedAtom);
    const conversions = useAtomValue(databaseConversionStateAtom);
    const listing = useWorkspaceListing(workspace);
    const databases = useDatabaseList();
    const { mutate } = useSWRConfig();
    const supported = databases.data?.collections !== undefined;
    useEffect(() => {
        if (supported && listing.data) void mutate("databases");
    }, [supported, listing.data, mutate]);
    return {
        ...projectLibrary({
            entries: listing.data,
            collections: databases.data?.collections,
            databases: databases.data?.databases,
            conversions,
            recents,
            lastOpened,
            listingError: listing.error,
            databaseError: databases.error,
        }),
        collections: databases.data?.collections,
        unreadDatabases: databases.data?.unread ?? [],
        loading: listing.isLoading || databases.isLoading,
        workspace,
        recents,
    };
}
