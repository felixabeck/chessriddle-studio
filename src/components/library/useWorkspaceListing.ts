import type { FileWorkspaceHandle } from "@/bindings";
import { workspaceListingToEntries } from "@/components/files/file";
import { workspaceListingKey } from "@/components/files/workspaceListing";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { tauri } from "@/platform/tauri";
import useSWR from "swr";

/** Read-only listing shared by the Library actions and the New Tab projection. */
export function useWorkspaceListing(workspace: FileWorkspaceHandle | null) {
    const key = workspace ? workspaceListingKey(workspace) : null;
    const owner = useNativeRequestOwner(key);
    return useSWR(key, async () =>
        owner!.run(async (signal) =>
            workspaceListingToEntries(
                await tauri.listFileWorkspace(workspace!, { signal }),
                workspace!,
            ),
        ),
    );
}
