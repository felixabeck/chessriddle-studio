import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { atom, type createStore } from "jotai";
import type { OpponentAccount } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { publishDatabaseList } from "@/hooks/useDatabaseList";
import { opponentLinksAtom } from "@/state/atoms";
import {
    findLinkWithAccount,
    findOpponentLink,
    MAX_OPPONENT_ACCOUNTS,
    type OpponentLink,
    sameOpponentAccount,
    withOpponentAccount,
} from "@/state/opponentLinks";
import type { DatabaseList } from "@/utils/db";
import type { DatabaseRouteTarget } from "./databaseRoute";
import { openOpponentCard } from "./openOpponentCard";
import {
    isOpponentImportRunning,
    type OpponentFlowDeps,
    runOpponentImport,
} from "./opponentImport";
import { reportOpponentImport, reportOpponentUnavailable } from "./opponentImportNotice";

type Store = ReturnType<typeof createStore>;

export type OnlineOpponentDeps = OpponentFlowDeps & {
    navigate: (target: DatabaseRouteTarget) => unknown;
    t: TFunction;
};

/** The opponent link whose download progress modal is requested from the Library entry. */
export const onlineOpponentDownloadAtom = atom<string | null>(null);

/**
 * Link id currently shown by a mounted `OnlineOpponentDownload` modal, or `null`.
 * Written only by the mounted modal (and cleared when closing it), so leaving `/library`
 * before or while a download runs never looks like a visible modal when it finishes.
 */
let shownEntryModalLink: string | null = null;
const entryContinuations = new Set<string>();

/**
 * Registers `linkId` as currently displayed by the mounted `OnlineOpponentDownload` modal and
 * returns a cleanup that clears it on unmount or when the displayed link changes.
 */
export function registerShownEntryModal(linkId: string): () => void {
    shownEntryModalLink = linkId;
    return () => {
        if (shownEntryModalLink === linkId) shownEntryModalLink = null;
    };
}

/**
 * Dismisses the entry's download modal for `linkId` without stopping the import, clearing both
 * the mounted-modal marker and the modal request atom.
 */
export function closeOnlineOpponentModal(store: Store, linkId: string): void {
    if (shownEntryModalLink === linkId) shownEntryModalLink = null;
    if (store.get(onlineOpponentDownloadAtom) === linkId) {
        store.set(onlineOpponentDownloadAtom, null);
    }
}

function startOrJoinEntryImport(deps: OnlineOpponentDeps, link: OpponentLink): void {
    const startedByEntry = !isOpponentImportRunning(link.id);
    const title = deps.t("Databases.Opponent.DatabaseTitle", {
        defaultValue: "{{name}} (online)",
        name: link.playerName,
    });
    deps.store.set(onlineOpponentDownloadAtom, link.id);
    const run = runOpponentImport(deps, link.id, title);
    if (!entryContinuations.has(link.id)) {
        entryContinuations.add(link.id);
        const openCard = () => {
            void openOpponentCard(deps.store, deps.navigate, deps.mutateCache, link.id);
        };
        void run.then(
            (result) => {
                entryContinuations.delete(link.id);
                const modalWasShown = shownEntryModalLink === link.id;
                closeOnlineOpponentModal(deps.store, link.id);
                if (startedByEntry) {
                    if (result.kind === "imported") {
                        if (modalWasShown) {
                            reportOpponentImport(deps.t, result);
                            openCard();
                        } else {
                            reportOpponentImport(deps.t, result, openCard);
                        }
                    } else {
                        reportOpponentImport(deps.t, result);
                    }
                } else if (result.kind === "imported" && modalWasShown) {
                    openCard();
                }
            },
            (error) => {
                entryContinuations.delete(link.id);
                closeOnlineOpponentModal(deps.store, link.id);
                notifyUnlessCancelled(deps.t("Common.Error"), error, "database");
            },
        );
    }
}

/**
 * Handles a confirmed online account from the Library entry: opens an already downloaded card,
 * adds the account to an existing same-named opponent or creates a new online-only opponent, and
 * starts or joins the download.
 */
export async function enterOnlineOpponent(
    deps: OnlineOpponentDeps,
    account: OpponentAccount,
): Promise<void> {
    let listing: DatabaseList | undefined;
    try {
        listing = await publishDatabaseList(deps.mutateCache);
    } catch (error) {
        notifyUnlessCancelled(deps.t("Common.Error", { defaultValue: "Error" }), error, "database");
        return;
    }

    const links = deps.store.get(opponentLinksAtom);
    const existingWithAccount = findLinkWithAccount(links, account);
    if (existingWithAccount) {
        if (existingWithAccount.database) {
            const entry = listing?.databases.find(
                (database) => database.filename === existingWithAccount.database,
            );
            if (entry) {
                if (entry.type === "success") {
                    await openOpponentCard(
                        deps.store,
                        deps.navigate,
                        deps.mutateCache,
                        existingWithAccount.id,
                    );
                    return;
                }
                reportOpponentUnavailable(deps.t);
                return;
            }
            if (listing?.unread.some((item) => item.filename === existingWithAccount.database)) {
                reportOpponentUnavailable(deps.t);
                return;
            }
        }
        startOrJoinEntryImport(deps, existingWithAccount);
        return;
    }

    const existingWithName = findOpponentLink(links, account.username);
    if (existingWithName) {
        if (isOpponentImportRunning(existingWithName.id)) {
            notifications.show({
                color: "warning",
                message: deps.t("Databases.Opponent.AddWhileDownloading", {
                    defaultValue:
                        "The games of {{name}} are being downloaded. You can add this account once it has finished.",
                    name: existingWithName.playerName,
                }),
            });
            return;
        }
        if (existingWithName.accounts.length >= MAX_OPPONENT_ACCOUNTS) {
            notifications.show({
                color: "warning",
                message: deps.t("Databases.Opponent.AccountLimit", {
                    defaultValue:
                        "{{name}} already has {{max}} linked accounts, the maximum allowed.",
                    name: existingWithName.playerName,
                    max: MAX_OPPONENT_ACCOUNTS,
                }),
            });
            return;
        }
    }

    const playerName = existingWithName?.playerName ?? account.username;
    const targetId = existingWithName?.id ?? crypto.randomUUID();
    let targetLink: OpponentLink | undefined;
    deps.store.set(opponentLinksAtom, (current) => {
        const next = withOpponentAccount(current, playerName, account, targetId);
        targetLink = next.find((link) => link.id === targetId);
        return next;
    });
    if (!targetLink || !targetLink.accounts.some((other) => sameOpponentAccount(other, account))) {
        return;
    }
    startOrJoinEntryImport(deps, targetLink);
}
