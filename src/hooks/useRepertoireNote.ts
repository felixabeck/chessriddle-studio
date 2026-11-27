import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileWorkspaceAtom, sessionsAtom } from "@/state/atoms";
import {
    type RepertoireSnapshot,
    readRepertoireIndex,
    refreshRepertoireIndex,
} from "@/state/repertoireIndex";
import {
    compareGameToRepertoire,
    type RepertoireComparison,
    resolveUserSide,
} from "@/utils/gameReviewRepertoire";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";

type SettledSnapshot = {
    workspaceKey: string;
    fingerprint: string;
    snapshot: RepertoireSnapshot | null;
};

/**
 * Refreshes the repertoire index on mount and when `fileWorkspaceAtom` or `fingerprint` changes,
 * returning the comparison for the user's side only once a settled snapshot matches the current
 * workspace, fingerprint and side.
 */
export function useRepertoireNote({
    root,
    headers,
    fingerprint,
}: {
    root: TreeNode;
    headers: GameHeaders;
    fingerprint: string;
}): RepertoireComparison | null {
    const workspace = useAtomValue(fileWorkspaceAtom);
    const sessions = useAtomValue(sessionsAtom);
    const workspaceKey = workspace ? fileWorkspaceKey(workspace) : null;
    const userSide = useMemo(() => resolveUserSide(headers, sessions), [headers, sessions]);

    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;
    const [settled, setSettled] = useState<SettledSnapshot | null>(null);

    useEffect(() => {
        setSettled(null);

        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace === null || workspaceKey === null) {
            void refreshRepertoireIndex(null);
            return;
        }

        let cancelled = false;
        void Promise.resolve(refreshRepertoireIndex(currentWorkspace))
            .then(() => {
                if (cancelled) return;
                const snapshot = readRepertoireIndex(currentWorkspace);
                setSettled({ workspaceKey, fingerprint, snapshot });
            })
            .catch(() => {
                // `refreshRepertoireIndex` never rejects; guard against mocked rejections anyway.
            });

        return () => {
            cancelled = true;
        };
    }, [workspaceKey, fingerprint]);

    return useMemo(() => {
        if (!settled || workspaceKey === null) return null;
        if (settled.workspaceKey !== workspaceKey || settled.fingerprint !== fingerprint)
            return null;
        if (!settled.snapshot) return null;
        return compareGameToRepertoire(root, settled.snapshot, userSide);
    }, [settled, workspaceKey, fingerprint, root, userSide]);
}
