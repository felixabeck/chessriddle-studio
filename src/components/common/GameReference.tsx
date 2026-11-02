import { Alert, Button, Loader, Paper, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom, useStore } from "jotai";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { closingTabsAtom, addRecentFileAtom, tabsAtom } from "@/state/atoms";
import { getCachedTreeStore } from "@/state/store/tree";
import { useOwnerTab } from "@/state/tabScope";
import { openDatabaseGame } from "@/utils/databaseGame";
import {
  lookupGameReference,
  type GameReference,
  type ReferenceOccurrence,
  type ReferenceSearch,
} from "@/utils/gameReferences";
import { getTabTreeKey, runTabCreation, sameTabOwner } from "@/utils/tabs";
import { OpenGameButton, useGameOpen } from "./gameOpen";
import { AppModal } from "./AppModal";
import { TreeStateContext } from "./TreeStateContext";

export const GameReferenceContext = createContext<((reference: GameReference) => void) | null>(
  null,
);

/** The notation surface, rather than each virtualized comment, owns one request and dialog. */
export function GameReferenceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setTabs = useSetAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const workspace = useStore();
  const store = useContext(TreeStateContext)!;
  const [ownerTab] = useOwnerTab();
  const treeKey = ownerTab ? getTabTreeKey(ownerTab) : undefined;
  const request = useRef<AbortController | null>(null);
  const live = useRef(false);
  const [state, setState] = useState<{ reference: GameReference; result?: ReferenceSearch } | null>(
    null,
  );
  const reportError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
  const opener = useGameOpen(
    (occurrence: ReferenceOccurrence) =>
      runTabCreation({
        create: () =>
          openDatabaseGame({
            game: occurrence.game,
            database: occurrence.database,
            setTabs,
            addRecentFile,
          }),
        onSuccess: () => navigate({ to: "/" }),
        onError: reportError,
      }),
    reportError,
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

  const activate = (reference: GameReference) => {
    if (opener.pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ reference });
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
        setState({ reference, result });
        if (
          result.complete &&
          result.candidates.length === 1 &&
          result.candidates[0].verification === "verified"
        ) {
          // Admission has its own contract. Once begun it may finish after this owner retires.
          void opener.activate(result.candidates[0]);
        }
      })
      .catch(() => {
        if (current())
          setState({
            reference,
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
    <GameReferenceContext.Provider value={activate}>
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
                      onOpen={() => opener.activate(candidate)}
                    />
                  </Stack>
                </Paper>
              ))}
              <Button
                variant="default"
                disabled={opener.pending}
                onClick={() => state && activate(state.reference)}
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
