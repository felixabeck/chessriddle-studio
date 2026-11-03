import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { flushSync } from "react-dom";
import { deferTreeView, releaseTreeView } from "@/state/deferredTreeView";
import { useStore } from "zustand";
import { normalizeError } from "@/platform/errors";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import type { TreeStore } from "@/state/store/tree";
import { loadFileGame, pickPgnFile, readFileGame } from "@/utils/files";
import { parsePGN } from "@/utils/chess";
import { tauri } from "@/platform/tauri";
import { databaseGameToTree } from "@/utils/databaseGameTree";
import { databaseHandleKey } from "@/utils/db";
import {
  AddGameContext,
  appendBlankGame,
  appendStoreGame,
  getAddGameLease,
  subscribeAddGame,
  isFileBackedTab,
  matchesFileGameTab,
  serializeStoreTree,
  sameTabOwner,
  saveToDatabase,
  useTabActions,
  type FileBackedTab,
} from "@/utils/tabs";
import type { Tab } from "@/utils/tabs";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import {
  getFileFreshness,
  registerFileConflictSave,
  requestFileReconcile,
  setFileFreshness,
  useFileFreshness,
} from "@/state/fileFreshness";
import classes from "./FileFreshnessGate.module.css";
import { useCollectionCurrency } from "@/state/linkedCollections";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { wrappingButton } from "@/components/common/wrappingButton";

function useAddGameLease(store: TreeStore) {
  return useSyncExternalStore(
    useCallback((listener) => subscribeAddGame(store, listener), [store]),
    useCallback(() => getAddGameLease(store), [store]),
  );
}

function useInstallTree(store: TreeStore, tabId: string, onReload: () => void) {
  return useCallback(
    (
      tree: Parameters<ReturnType<typeof store.getState>["setState"]>[0],
      revision: string | null,
    ) => {
      deferTreeView(store);
      try {
        store.getState().setState(tree);
        const hooks = globalThis as {
          __verifyAppRecordTreeApplied?: () => void;
          __verifyAppStallFreshnessApply?: () => void;
        };
        hooks.__verifyAppRecordTreeApplied?.();
        hooks.__verifyAppStallFreshnessApply?.();
        // Children render in this commit. Deferred readers keep the retained snapshot or skip
        // a fresh walk, so the board can show the installed position without a tree walk.
        // Release schedules the replacement walk after this commit.
        flushSync(() => {
          onReload();
          setFileFreshness(tabId, "verified", { verifiedRevision: revision });
        });
      } finally {
        releaseTreeView(store);
      }
    },
    [store, tabId, onReload],
  );
}

type Props = {
  tab: Tab;
  closeTab: (tabId: string) => void;
  children: React.ReactNode;
};

function isUnavailableFileError(error: ReturnType<typeof normalizeError>) {
  return (
    error.backendCategory === "invalid-input" ||
    error.backendCategory === "missing-resource" ||
    error.backendCategory === "conflict"
  );
}

export default function FileFreshnessGate({ tab, closeTab, children }: Props) {
  // Drafts have no stored game to poll or recover. Resolve their target only on explicit save.
  if (tab.gameOrigin.kind === "databaseDraft") return <>{children}</>;
  if (tab.gameOrigin.kind === "database")
    return (
      <DatabaseOriginGate tab={tab} closeTab={closeTab}>
        {children}
      </DatabaseOriginGate>
    );
  if (!isFileBackedTab(tab)) return <>{children}</>;
  return (
    <LinkedFileOriginGate tab={tab} closeTab={closeTab}>
      {children}
    </LinkedFileOriginGate>
  );
}

function DatabaseOriginGate({ tab, closeTab, children }: Props) {
  const currency = useCollectionCurrency(
    tab.gameOrigin.kind === "database" ? tab.gameOrigin.database : null,
  );
  if (!currency.collection)
    return (
      <DatabaseConflictGate tab={tab} closeTab={closeTab}>
        {children}
      </DatabaseConflictGate>
    );
  return (
    <RetiredOriginRecovery
      tab={tab}
      preservedOriginal={currency.collection.status === "preservedOriginal"}
    />
  );
}

function DatabaseConflictGate({ tab, closeTab, children }: Props) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const { getTab, updateTab } = useTabActions();
  const freshness = useFileFreshness(tab.value);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const onReload = useCallback(() => setReloadCount((count) => count + 1), []);
  const installTree = useInstallTree(store, tab.value, onReload);
  const flight = useRef<AbortController | null>(null);
  const origin = tab.gameOrigin;
  const databaseKey = origin.kind === "database" ? databaseHandleKey(origin.database) : null;
  const gameId = origin.kind === "database" ? origin.gameId : null;
  const identity = { tab, store, databaseKey, gameId };
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    setPending(false);
    return () => {
      flight.current?.abort();
      flight.current = null;
    };
  }, [tab.value, databaseKey, gameId, store]);

  const isCurrent = useCallback(
    (signal: AbortSignal) => {
      const current = getTab(tab.value);
      const latest = identityRef.current;
      return (
        !signal.aborted &&
        latest.store === store &&
        latest.tab.value === tab.value &&
        latest.databaseKey === databaseKey &&
        latest.gameId === gameId &&
        sameTabOwner(current, tab) &&
        current.gameOrigin.kind === "database" &&
        databaseHandleKey(current.gameOrigin.database) === databaseKey &&
        current.gameOrigin.gameId === gameId
      );
    },
    [getTab, tab, store, databaseKey, gameId],
  );

  const runAction = useCallback(async (run: (signal: AbortSignal) => Promise<boolean>) => {
    if (flight.current) return false;
    const controller = new AbortController();
    flight.current = controller;
    setPending(true);
    setPanelError(null);
    try {
      return await run(controller.signal);
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }, []);

  const reload = () =>
    runAction(async (signal) => {
      if (origin.kind !== "database" || !isCurrent(signal)) return false;
      try {
        const result = await tauri.getDbGame(origin.database, origin.gameId, null, { signal });
        if (!isCurrent(signal)) return false;
        if (result.kind === "missing") {
          setFileFreshness(tab.value, "unavailable");
          return false;
        }
        const tree = await databaseGameToTree(result.game);
        if (!isCurrent(signal)) return false;
        installTree(tree, null);
        return true;
      } catch (error) {
        if (isCurrent(signal)) setPanelError(normalizeError(error).message);
        return false;
      }
    });

  const saveAsNew = useCallback(
    (throwOnFailure = false) =>
      runAction(async (signal) => {
        if (origin.kind !== "database" || !isCurrent(signal)) return false;
        const result = await saveToDatabase({
          tab,
          store,
          database: origin.database,
          getTab,
          updateTab,
        });
        if (typeof result === "object" && result.status === "failed") {
          if (!isCurrent(signal)) return false;
          setPanelError(result.error.message);
          if (throwOnFailure) throw result.error;
        }
        return result === "saved" && !store.getState().dirty;
      }),
    [runAction, origin, isCurrent, tab, store, getTab, updateTab],
  );

  useEffect(
    () => registerFileConflictSave(tab.value, () => saveAsNew(true)),
    [tab.value, saveAsNew],
  );

  const conflict = freshness.state === "conflict";
  return (
    <div
      className={classes.gate}
      data-file-freshness={`${freshness.state}:${reloadCount}`}
      data-tab-id={tab.value}
    >
      {conflict || freshness.state === "unavailable" ? (
        <Stack className={classes.panel} align="center" justify="center" h="100%" gap="sm">
          <Text>
            {conflict
              ? t("FileFreshness.ChangedInDatabase")
              : t("FileFreshness.GameNoLongerInDatabase")}
          </Text>
          {(panelError ?? freshness.errorMessage) && (
            <Text className={classes.error}>{panelError ?? freshness.errorMessage}</Text>
          )}
          <Group>
            {conflict && (
              <Button color="gold" onClick={() => void reload()} disabled={pending}>
                {t("FileFreshness.ReloadFromDatabase")}
              </Button>
            )}
            <Button color="gold" onClick={() => void saveAsNew()} disabled={pending}>
              {t("FileFreshness.SaveAsNewGame")}
            </Button>
            {!conflict && (
              <Button variant="default" onClick={() => closeTab(tab.value)} disabled={pending}>
                {t("Tab.Close")}
              </Button>
            )}
          </Group>
        </Stack>
      ) : (
        children
      )}
    </div>
  );
}

function LinkedFileOriginGate({ tab, closeTab, children }: Props & { tab: FileBackedTab }) {
  const tree = useContext(TreeStateContext)!;
  const linked = useStore(tree, (state) => state.linkedSource);
  const { data } = useDatabaseList(!!linked);
  const descriptor = data?.collections?.find((collection) => collection.id === linked?.collection);
  const currency = useCollectionCurrency(descriptor?.database, descriptor);
  if (
    descriptor?.status === "preservedOriginal" ||
    currency.collection?.status === "preservedOriginal"
  )
    return <RetiredOriginRecovery tab={tab} preservedOriginal />;
  return (
    <FileBackedGate tab={tab} closeTab={closeTab}>
      {children}
    </FileBackedGate>
  );
}

function RetiredOriginRecovery({
  tab,
  preservedOriginal = false,
}: {
  tab: Tab;
  preservedOriginal?: boolean;
}) {
  const { t } = useTranslation();
  const tree = useContext(TreeStateContext)!;
  const { updateTab } = useTabActions();
  return (
    <Stack role="alert" p="md">
      <Text className="wrap-anywhere">
        {preservedOriginal
          ? t("Collections.PreservedOriginal")
          : t("Collections.RetiredTab", {
              defaultValue:
                "This database now indexes a PGN collection. Save this game as a new file to preserve your edits.",
            })}
      </Text>
      <Button
        styles={wrappingButton}
        onClick={() => {
          if (updateTab(tab.value, (current) => ({ ...current, gameOrigin: { kind: "none" } })))
            tree.getState().setLinkedSource(null);
        }}
      >
        {t("Collections.KeepEdits", { defaultValue: "Keep these edits as a new game" })}
      </Button>
    </Stack>
  );
}

function FileBackedGate({
  tab,
  closeTab,
  children,
}: Props & {
  tab: FileBackedTab;
}) {
  const { t } = useTranslation();
  const tabId = tab.value;
  const origin = tab.gameOrigin;
  const handle = origin.file.handle;
  const fileKey = fileWorkspaceKey(handle);
  const gameNumber = origin.gameNumber;
  const store = useContext(TreeStateContext)!;
  const { workspace, getTab, updateTab } = useTabActions();
  const freshness = useFileFreshness(tabId);
  const addGameLease = useAddGameLease(store);
  const addingGame =
    !!addGameLease &&
    sameTabOwner(tab, addGameLease.owner) &&
    matchesFileGameTab(tab, addGameLease.owner.gameOrigin);
  const viewMountedRef = useRef(true);
  const sourceStamp = useStore(store, (state) => state.sourceStamp);
  const appendAttempted = useStore(store, (state) => state.appendAttempted);
  const [retryCount, setRetryCount] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"reload" | "append" | null>(null);
  const freshnessErrorMessageRef = useRef(freshness.errorMessage);
  freshnessErrorMessageRef.current = freshness.errorMessage;
  const pendingActionRef = useRef(false);
  const actionControllerRef = useRef<AbortController | null>(null);
  const actionIdentity = { tabId, fileKey, gameNumber, store };
  const actionIdentityRef = useRef(actionIdentity);
  actionIdentityRef.current = actionIdentity;

  const onReload = useCallback(() => setReloadCount((count) => count + 1), []);
  const installDiskTree = useInstallTree(store, tabId, onReload);

  const actionIsCurrent = useCallback(
    (signal: AbortSignal) => {
      if (signal.aborted) return false;
      const currentTab = getTab(tabId);
      return (
        actionIdentityRef.current.tabId === tabId &&
        actionIdentityRef.current.fileKey === fileKey &&
        actionIdentityRef.current.gameNumber === gameNumber &&
        actionIdentityRef.current.store === store &&
        matchesFileGameTab(currentTab, tab.gameOrigin) &&
        sameTabOwner(currentTab, tab)
      );
    },
    [getTab, tabId, fileKey, gameNumber, store, tab],
  );

  useEffect(() => {
    viewMountedRef.current = true;
    return () => {
      viewMountedRef.current = false;
      // The action retains its controller lease until its own finally releases it.
      actionControllerRef.current?.abort();
    };
  }, [tabId, fileKey, gameNumber, store]);

  useEffect(() => {
    if (addingGame || freshness.state !== "unverified") return;
    const capturedEpoch = freshness.epoch;
    const capturedRoot = store.getState().root;
    const capturedStamp = store.getState().sourceStamp;
    setPanelError(freshnessErrorMessageRef.current);
    return requestFileReconcile(tabId, async (signal) => {
      const isObsolete = () =>
        !actionIsCurrent(signal) || getFileFreshness(tabId).epoch !== capturedEpoch;
      try {
        const current = await readFileGame(handle, gameNumber, signal);
        const linkedSource = current.linked ?? null;
        if (isObsolete()) return;
        const latestTree = store.getState();
        if (
          linkedSource &&
          latestTree.dirty &&
          (!latestTree.linkedSource || latestTree.linkedSource.generation !== current.revision)
        ) {
          setFileFreshness(tabId, "conflict", { conflictReason: "changed" });
          return;
        }
        if (latestTree.appendAttempted) {
          setFileFreshness(tabId, "conflict", { conflictReason: "changed" });
          return;
        }
        if (latestTree.sourceStamp === null) {
          if (!current.present || current.pgn.trim() !== serializeStoreTree(store).trim()) {
            setFileFreshness(tabId, "conflict", { conflictReason: "changed" });
            return;
          }
          store.getState().setSourceStamp(current.stamp, current.revision);
          setFileFreshness(tabId, "verified", { verifiedRevision: current.revision });
          return;
        }
        if (!current.present && current.stamp !== capturedStamp) {
          setFileFreshness(tabId, "unavailable");
          setPanelError(t("FileFreshness.GameNoLongerInFile"));
          return;
        }
        if (current.stamp === latestTree.sourceStamp) {
          store.getState().setLinkedSource(linkedSource);
          setFileFreshness(tabId, "verified", { verifiedRevision: current.revision });
          return;
        }
        if (latestTree.dirty || latestTree.root !== capturedRoot) {
          setFileFreshness(tabId, "conflict", { conflictReason: "changed" });
          return;
        }
        const tree = { ...(await parsePGN(current.pgn, undefined, { signal })), linkedSource };
        if (isObsolete()) return;
        const beforeReplace = store.getState();
        if (beforeReplace.dirty || beforeReplace.root !== capturedRoot) {
          setFileFreshness(tabId, "conflict", { conflictReason: "changed" });
          return;
        }
        tree.sourceStamp = current.stamp;
        installDiskTree(tree, current.revision);
      } catch (error) {
        if (isObsolete()) return;
        const normalized = normalizeError(error);
        if (isUnavailableFileError(normalized)) {
          setFileFreshness(tabId, "unavailable");
          if (normalized.backendCategory === "invalid-input") {
            setPanelError(t("FileFreshness.GameNoLongerInFile"));
          }
          return;
        }
        setPanelError(normalized.message);
      }
    });
  }, [
    freshness.state,
    freshness.epoch,
    addingGame,
    retryCount,
    tabId,
    gameNumber,
    store,
    handle,
    sourceStamp,
    actionIsCurrent,
    installDiskTree,
    t,
  ]);

  const appendGame = useCallback(
    (captured: Tab | undefined) =>
      appendBlankGame({
        captured,
        store,
        workspace,
        getTab,
        updateTab,
        uncertainMessage: t("FileFreshness.AddGameMayHaveBeenAdded"),
        changedMessage: t("FileFreshness.AddGameChanged"),
        onError: (error) => {
          if (viewMountedRef.current) notifyUnlessCancelled(t("Common.Error"), error);
        },
      }),
    [workspace, getTab, updateTab, store, t],
  );

  const runAction = useCallback(
    async (action: "reload" | "append", run: (signal: AbortSignal) => Promise<boolean>) => {
      if (pendingActionRef.current) return false;
      pendingActionRef.current = true;
      const controller = new AbortController();
      actionControllerRef.current = controller;
      setPendingAction(action);
      setPanelError(null);
      try {
        return await run(controller.signal);
      } finally {
        if (actionControllerRef.current === controller) {
          actionControllerRef.current = null;
          pendingActionRef.current = false;
          if (viewMountedRef.current) setPendingAction(null);
        }
      }
    },
    [],
  );

  const reloadFromDisk = useCallback(async (): Promise<boolean> => {
    return runAction("reload", async (signal) => {
      try {
        const loaded = await loadFileGame(handle, gameNumber, signal);
        if (!actionIsCurrent(signal)) return false;
        if (!loaded.present && gameNumber < origin.file.numGames) {
          setFileFreshness(tabId, "unavailable");
          setPanelError(t("FileFreshness.GameNoLongerInFile"));
          return false;
        }
        installDiskTree(loaded.tree, loaded.revision);
        setPanelError(null);
        return true;
      } catch (error) {
        if (actionIsCurrent(signal)) {
          const normalized = normalizeError(error);
          if (isUnavailableFileError(normalized)) {
            setFileFreshness(tabId, "unavailable");
          }
          setPanelError(normalized.message);
        }
        return false;
      }
    });
  }, [
    runAction,
    actionIsCurrent,
    handle,
    gameNumber,
    origin.file.numGames,
    tabId,
    installDiskTree,
    t,
  ]);

  const appendAsNewGame = useCallback(
    async (throwOnFailure = false): Promise<boolean> => {
      if (appendAttempted) return false;
      return runAction("append", async (signal) => {
        let admittedOwner: Tab | undefined;
        const ownsCompletion = () =>
          admittedOwner
            ? viewMountedRef.current &&
              actionIdentityRef.current.store === store &&
              sameTabOwner(getTab(tabId), admittedOwner) &&
              isFileBackedTab(admittedOwner) &&
              matchesFileGameTab(getTab(tabId), admittedOwner.gameOrigin)
            : actionIsCurrent(signal);
        try {
          const selected = await pickPgnFile();
          if (!selected || !actionIsCurrent(signal)) return false;

          const result = await appendStoreGame({
            tab,
            store,
            selected,
            pgn: serializeStoreTree(store),
            isCurrent: () => actionIsCurrent(signal),
            updateTab,
            getTab,
            prepareMessage: t("FileFreshness.CouldNotPrepareAppend"),
            onAdmitted: (successor) => {
              admittedOwner = successor;
            },
          });
          if (result === "uncertain") {
            setPanelError(t("FileFreshness.AppendMayHaveBeenAdded"));
          }
          return result === "saved" && !store.getState().dirty;
        } catch (error) {
          if (!ownsCompletion()) return false;
          const normalized = normalizeError(error);
          if (normalized.backendCategory === "stale-game") {
            setPanelError(t("FileFreshness.AppendChanged"));
          } else {
            if (isUnavailableFileError(normalized)) {
              setFileFreshness(tabId, "unavailable");
            }
            setPanelError(normalized.message);
          }
          if (throwOnFailure) throw normalized;
          if (getFileFreshness(tabId).state === "verified") {
            notifyUnlessCancelled(t("Common.Error"), normalized);
          }
          return false;
        }
      });
    },
    [appendAttempted, runAction, actionIsCurrent, store, tabId, tab, t, updateTab, getTab],
  );

  useEffect(
    () => registerFileConflictSave(tabId, () => appendAsNewGame(true)),
    [tabId, appendAsNewGame],
  );

  const state = addingGame ? "appending" : freshness.state;
  const errorMessage = panelError ?? freshness.errorMessage;
  const disabled = pendingAction !== null;
  const wrapper = (content: React.ReactNode) => (
    <div
      className={classes.gate}
      data-file-freshness={`${state}:${reloadCount}`}
      data-tab-id={tabId}
    >
      {content}
    </div>
  );

  if (state === "verified")
    return wrapper(
      <AddGameContext.Provider value={appendGame}>{children}</AddGameContext.Provider>,
    );
  if (state === "appending" || state === "unverified" || state === "overdue") {
    return wrapper(
      <Stack align="center" justify="center" h="100%" gap="sm">
        {state === "appending" ? (
          <>
            <Loader />
            <Text>{t("FileFreshness.AddingGame")}</Text>
          </>
        ) : state === "overdue" ? (
          <Text>{t("FileFreshness.FileNotResponding")}</Text>
        ) : errorMessage ? (
          <>
            <Text>{errorMessage}</Text>
            <Button color="gold" onClick={() => setRetryCount((count) => count + 1)}>
              {t("FileFreshness.Retry")}
            </Button>
          </>
        ) : (
          <>
            <Loader />
            <Text>{t("FileFreshness.CheckingFile")}</Text>
          </>
        )}
      </Stack>,
    );
  }

  const conflict = state === "conflict";
  const uncertainMessage = appendAttempted ? t("FileFreshness.AppendMayHaveBeenAdded") : null;
  return wrapper(
    <Stack className={classes.panel} align="center" justify="center" h="100%" gap="sm">
      <Text>
        {conflict
          ? freshness.conflictReason === "lossy-source"
            ? t("FileFreshness.LossySource", {
                defaultValue:
                  "The game in the file contains moves or comments ChessFable cannot keep. Saving over it would delete them. You can save your version as a new game.",
              })
            : t("FileFreshness.Changed")
          : t("FileFreshness.Unavailable")}
      </Text>
      {uncertainMessage && <Text c="dimmed">{uncertainMessage}</Text>}
      {errorMessage && <Text className={classes.error}>{errorMessage}</Text>}
      <Group>
        {(conflict || appendAttempted) && (
          <Button color="gold" onClick={() => void reloadFromDisk()} disabled={disabled}>
            {t("FileFreshness.ReloadFromDisk")}
          </Button>
        )}
        <Button
          color="gold"
          onClick={() => void appendAsNewGame()}
          disabled={disabled || appendAttempted}
        >
          {t("FileFreshness.SaveAsNewGame")}
        </Button>
        {!conflict && (
          <Button variant="default" onClick={() => closeTab(tabId)} disabled={disabled}>
            {t("Tab.Close")}
          </Button>
        )}
      </Group>
    </Stack>,
  );
}
