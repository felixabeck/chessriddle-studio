import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { GameLink } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { error as logError, warn } from "@/platform/native";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";
import { tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { ChessComGameResponseError } from "@/utils/chess.com/api";
import { createTab, type SetTabs } from "@/utils/tabs";
import { getGameName } from "@/utils/treeReducer";
import { fetchGameLinkPgn, gameLinkSite, gameLinkUrl } from "./gameLink";

/**
 * Serialises drains: `request()` starts one, and a request that arrives while one is running
 * causes exactly one further drain after it. Nothing starts once `signal` is aborted.
 */
export function createDrainScheduler(
    drain: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
): () => Promise<void> {
    let running = false;
    let requestedAgain = false;
    return async () => {
        if (signal.aborted) return;
        if (running) {
            requestedAgain = true;
            return;
        }
        running = true;
        try {
            do {
                requestedAgain = false;
                await drain(signal);
            } while (requestedAgain && !signal.aborted);
        } finally {
            running = false;
        }
    };
}

type OpenContext = {
    setTabs: SetTabs;
    showBoard: () => Promise<unknown>;
    t: (key: string, options?: Record<string, string>) => string;
};

/** Opens one linked game in a new analysis tab. Nothing else is started for it. */
async function openGameLink(link: GameLink, context: OpenContext, signal: AbortSignal) {
    const { setTabs, showBoard, t } = context;
    const site = gameLinkSite(link);
    const notificationId = `game-link:${crypto.randomUUID()}`;
    notifications.show({
        id: notificationId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        title: t("GameLink.OpeningTitle"),
        message: t("GameLink.OpeningMessage", { site }),
    });
    try {
        const tree = await parsePGN(await fetchGameLinkPgn(link));
        if (signal.aborted) return;
        const id = await createTab({
            tab: { name: getGameName(tree.headers), type: "analysis" },
            setTabs,
            initialTree: tree,
            gameOrigin: { kind: "none" },
            signal,
        });
        // A declined tab has already been reported by the admission that declined it.
        if (id !== null) await showBoard();
    } catch (cause) {
        if (signal.aborted) return;
        const title = t("GameLink.Failed", { site });
        if (cause instanceof ChessComGameResponseError) {
            void logError(cause.message);
            notifications.show({
                color: "danger",
                title,
                message: t("ChessCom.InvalidResponse", { value: gameLinkUrl(link) }),
            });
        } else {
            notifyUnlessCancelled(title, cause);
        }
    } finally {
        notifications.hide(notificationId);
    }
}

/**
 * Opens the games the operating system hands to the app (`chessriddle-studio://` links from the
 * browser extension). The links wait natively; this takes them once at mount and again on every
 * wake event, and opens them one after another. Mounted once, below the router.
 */
export function useIncomingGameLinks() {
    const setTabs = useSetAtom(tabsAtom);
    const navigate = useNavigate();
    const { t } = useTranslation();
    const context = useRef<OpenContext | null>(null);
    context.current = { setTabs, showBoard: () => navigate({ to: "/" }), t };
    const request = useRef<() => Promise<void>>(async () => undefined);

    useEffect(() => {
        const controller = new AbortController();
        request.current = createDrainScheduler(async (signal) => {
            let links: GameLink[];
            try {
                links = await tauri.takePendingGameLinks();
            } catch (cause) {
                // The links stay queued natively; the next wake event takes them.
                if (!signal.aborted) void warn(`Failed to take the waiting game links: ${cause}`);
                return;
            }
            for (const link of links) {
                if (signal.aborted || !context.current) return;
                await openGameLink(link, context.current, signal);
            }
        }, controller.signal);
        void request.current();
        return () => controller.abort();
    }, []);

    useTauriListener(tauriSubscriptions.gameLinkPending, () => request.current(), {
        onError: (cause) => void warn(`Game link listener failed: ${cause.message}`),
    });
}
