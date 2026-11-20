import { unstable_serialize, type useSWRConfig } from "swr";
import type { FileWorkspaceHandle } from "@/bindings";
import { hasNativeRequestSubscribers, supersedeNativeRequest } from "@/hooks/useNativeRequestOwner";
import { tauri } from "@/platform/tauri";

export type WorkspaceListingCache = Pick<ReturnType<typeof useSWRConfig>, "cache" | "mutate">;

export function workspaceListingKey(workspace: FileWorkspaceHandle) {
    return ["file-workspace", workspace] as const;
}

/** Reconcile once in the submitting workspace's cache without recovering a created object. */
export async function reconcileWorkspaceListing(
    workspace: FileWorkspaceHandle,
    { cache, mutate }: WorkspaceListingCache,
): Promise<void> {
    const key = workspaceListingKey(workspace);
    await supersedeNativeRequest(cache, key);
    // Invalidate first, then await no-data revalidation to settle the actual native fetch.
    // This also clears completed SWR fetches. Inactive keys stay empty for next mount.
    try {
        await mutate(key, undefined, { revalidate: false });
        await mutate(key);
    } catch (cause) {
        if (hasNativeRequestSubscribers(cache, key)) throw cause;
        // SWR removes its provider state on unmount, so its captured mutate can no longer run.
        // No reader owns this cache entry now. Leave it empty for a later mount and still
        // reconcile the original native workspace below.
        cache.delete(unstable_serialize(key));
    }
    if (!hasNativeRequestSubscribers(cache, key)) {
        cache.delete(unstable_serialize(key));
        await tauri.listFileWorkspace(workspace);
    }
}
