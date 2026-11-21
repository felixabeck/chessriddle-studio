import { Alert, Button, Loader, Paper, Stack, Text } from "@mantine/core";
import { useStore } from "jotai";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { closingTabsAtom, tabsAtom } from "@/state/atoms";
import { getCachedTreeStore } from "@/state/store/tree";
import { useOwnerTab } from "@/state/tabScope";
import {
  lookupGameReference,
  type GameReference,
  type ReferenceOccurrence,
  type ReferenceSearch,
} from "@/utils/gameReferences";
import { getTabTreeKey, sameTabOwner } from "@/utils/tabs";
import { treeIterator, type TreeNode } from "@/utils/treeReducer";
import { OpenGameButton } from "./gameOpen";
import { useOpenDatabaseGame } from "./useOpenDatabaseGame";
import { AppModal } from "./AppModal";
import { TreeStateContext } from "./TreeStateContext";

type ActivateReference = (reference: GameReference, position?: TreeNode) => void;
export const GameReferenceContext = createContext<ActivateReference | null>(null);

/**
 * Where a cited game should open: the commented position first, then each earlier position of the
 * annotated line back to its root, so a game that left the line opens where it left. A node no
 * longer in the tree contributes only its own position.
 */
export function citationTargetFens(root: TreeNode, position: TreeNode | undefined): string[] {
  if (!position) return [];
  for (const { position: path, node } of treeIterator(root)) {
    if (node !== position) continue;
    const fens = [root.fen];
    let current = root;
    for (const index of path) {
      current = current.children[index];
      fens.push(current.fen);
    }
    return fens.reverse();
  }
  return [position.fen];
}

/** The notation surface, rather than each virtualized comment, owns one request and dialog. */
export function GameReferenceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const workspace = useStore();
  const store = useContext(TreeStateContext)!;
  const [ownerTab] = useOwnerTab();
  const treeKey = ownerTab ? getTabTreeKey(ownerTab) : undefined;
  const request = useRef<AbortController | null>(null);
  const live = useRef(false);
  const [state, setState] = useState<{
    reference: GameReference;
    targetFens: string[];
    result?: ReferenceSearch;
  } | null>(null);
  const opener = useOpenDatabaseGame(
    ({ occurrence, targetFens }: { occurrence: ReferenceOccurrence; targetFens: string[] }) => ({
      game: occurrence.game,
      database: occurrence.database,
      databaseTitle: occurrence.databaseTitle,
      targetFens,
    }),
  );
  const close = () => {
    request.current?.abort();
    request.current = null;
    setState(null);
  };
  useLayoutEffect(() => {
    live.current = true;
    setState(null);
    return () => {
      live.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [store, treeKey]);

  const activate = (reference: GameReference, targetFens: string[]) => {
    if (opener.pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ reference, targetFens });
    const current = () =>
      live.current &&
      request.current === controller &&
      !controller.signal.aborted &&
      (!ownerTab ||
        (sameTabOwner(
          workspace.get(tabsAtom).find((tab) => tab.value === ownerTab.value),
          ownerTab,
        ) &&
          !workspace.get(closingTabsAtom).has(ownerTab.value) &&
          getCachedTreeStore(ownerTab.value) === store));
    void lookupGameReference(reference, controller.signal)
      .then((result) => {
        if (!current()) return;
        setState({ reference, targetFens, result });
        if (
          result.complete &&
          result.candidates.length === 1 &&
          result.candidates[0].verification === "verified"
        ) {
          // Admission has its own contract. Once begun it may finish after this owner retires.
          void opener.activate({ occurrence: result.candidates[0], targetFens });
        }
      })
      .catch(() => {
        if (current())
          setState({
            reference,
            targetFens,
            result: {
              candidates: [],
              complete: false,
              failures: [{ source: "", category: "unexpected" }],
            },
          });
      });
  };
  const result = state?.result;
  const failureMessages = {
    cancelled: t("GameReferences.Failure.cancelled"),
    network: t("GameReferences.Failure.network"),
    "not-found": t("Databases.LoadError.Missing"),
    "applied-despite-error": t("GameReferences.Failure.unexpected"),
    permission: t("Databases.LoadError.Permission"),
    validation: t("GameReferences.Failure.unexpected"),
    unexpected: t("GameReferences.Failure.unexpected"),
    unavailable: t("Collections.Unavailable"),
    omitted: t("GameReferences.Failure.omitted"),
    budget: t("GameReferences.Failure.budget"),
  };
  return (
    <GameReferenceContext.Provider
      value={(reference, position) =>
        activate(reference, citationTargetFens(store.getState().root, position))
      }
    >
      {children}
      <AppModal opened={state !== null} onClose={close} title={t("GameReferences.Title")} size="lg">
        <Stack style={{ overflowWrap: "anywhere" }}>
          <Text size="sm">{state?.reference.label}</Text>
          {!result && (
            <>
              <Loader size="sm" />
              <Text role="status">{t("GameReferences.Searching")}</Text>
            </>
          )}
          {result && (
            <>
              {!result.complete && (
                <Alert color="warning" title={t("GameReferences.Incomplete")}>
                  <Stack gap="xs">
                    {result.failures.map((failure, index) => (
                      <Text size="sm" key={index}>
                        {failure.source || t("GameReferences.Library")}:{" "}
                        {failure.message ||
                          (failure.databaseAdmission
                            ? t("Databases.LoadError.Admission")
                            : failure.backendCategory === "stale-game" ||
                                failure.backendCategory === "conflict"
                              ? t("Collections.Unavailable")
                              : failureMessages[failure.category])}
                      </Text>
                    ))}
                  </Stack>
                </Alert>
              )}
              {result.candidates.length === 0 && (
                <Text>
                  {result.complete ? t("GameReferences.Missing") : t("GameReferences.Prerequisite")}
                </Text>
              )}
              {result.candidates.length > 0 && <Text size="sm">{t("GameReferences.Choose")}</Text>}
              {result.candidates.map((candidate, index) => (
                <Paper withBorder p="sm" key={index}>
                  <Stack gap="xs">
                    <Text fw={500}>
                      {candidate.game.white} – {candidate.game.black}
                    </Text>
                    <Text size="sm">
                      {candidate.game.date ?? "?"} · {candidate.game.event} ·{" "}
                      {candidate.game.round ?? "?"} · {candidate.game.result}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {candidate.source}
                    </Text>
                    <OpenGameButton
                      pending={opener.pending}
                      onOpen={() =>
                        opener.activate({ occurrence: candidate, targetFens: state.targetFens })
                      }
                    />
                  </Stack>
                </Paper>
              ))}
              <Button
                variant="default"
                disabled={opener.pending}
                onClick={() => state && activate(state.reference, state.targetFens)}
              >
                {t("GameReferences.Retry")}
              </Button>
            </>
          )}
        </Stack>
      </AppModal>
    </GameReferenceContext.Provider>
  );
}

export function useGameReference() {
  return useContext(GameReferenceContext);
}
