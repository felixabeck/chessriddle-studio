import { Alert, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { AlertCircle, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import type { DatabaseHandle, DbGameHeadersUpdate } from "@/bindings";
import { AppModal } from "@/components/common/AppModal";
import ConfirmModal from "@/components/common/ConfirmModal";
import GameInfo from "@/components/common/GameInfo";
import { inlineFailureMessage, notifyUnlessCancelled } from "@/components/files/notifyError";
import { errorUnlessCancelled } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { databaseGameHeaders } from "@/utils/databaseGameTree";
import { databaseHandleKey } from "@/utils/db";
import type { GameHeaders } from "@/utils/treeReducer";
import { saveDbGameHeaders } from "./databaseMutation";

export type EditGameDataTarget = {
  file: DatabaseHandle;
  gameId: number;
};

type ModalPhase = "loading" | "ready" | "missing" | "load-error";
type StaleReloadState = "idle" | "reloading" | "failed";
type LoadMode = "initial" | "stale-reload";

const MIN_ELO = 0;
const MAX_ELO = 4000;

function isValidElo(value: number | null | undefined): boolean {
  return value == null || (Number.isSafeInteger(value) && value >= MIN_ELO && value <= MAX_ELO);
}

function toHeaderUpdate(headers: GameHeaders): DbGameHeadersUpdate {
  return {
    white: headers.white,
    black: headers.black,
    white_elo: headers.white_elo ?? null,
    black_elo: headers.black_elo ?? null,
    event: headers.event,
    site: headers.site,
    round: headers.round ?? null,
    date: headers.date ?? null,
    result: headers.result,
    time_control: headers.time_control ?? null,
  };
}

function headersEqual(a: DbGameHeadersUpdate, b: DbGameHeadersUpdate): boolean {
  return (
    a.white === b.white &&
    a.black === b.black &&
    a.white_elo === b.white_elo &&
    a.black_elo === b.black_elo &&
    a.event === b.event &&
    a.site === b.site &&
    a.round === b.round &&
    a.date === b.date &&
    a.result === b.result &&
    a.time_control === b.time_control
  );
}

export function EditGameDataModal({
  target,
  onClose,
}: {
  target: EditGameDataTarget | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { cache, mutate: globalMutate } = useSWRConfig();

  const [phase, setPhase] = useState<ModalPhase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialHeaders, setInitialHeaders] = useState<GameHeaders | null>(null);
  const [draft, setDraft] = useState<GameHeaders | null>(null);
  const [loadedStamp, setLoadedStamp] = useState("");
  const [saving, setSaving] = useState(false);
  const [staleReloadState, setStaleReloadState] = useState<StaleReloadState>("idle");
  const [staleReloaded, setStaleReloaded] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const formRef = useRef<HTMLFormElement | null>(null);
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const saveSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadErrorFallbackRef = useRef(t("Databases.LoadError.Title"));
  loadErrorFallbackRef.current = t("Databases.LoadError.Title");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, []);

  const abortInFlightLoad = useCallback(() => {
    loadSeqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
  }, []);

  const resetDialogState = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    setInitialHeaders(null);
    setDraft(null);
    setLoadedStamp("");
    setStaleReloadState("idle");
    setStaleReloaded(false);
    setInlineError(null);
    setConfirmDiscardOpen(false);
  }, []);

  const loadGame = useCallback(
    (file: DatabaseHandle, gameId: number, mode: LoadMode) => {
      abortInFlightLoad();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const seq = loadSeqRef.current;

      if (mode === "initial") {
        resetDialogState();
      } else {
        setStaleReloadState("reloading");
        setInlineError(null);
        setStaleReloaded(false);
      }

      void (async () => {
        try {
          const result = await tauri.getDbGame(file, gameId, null, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || loadSeqRef.current !== seq || !mountedRef.current) {
            return;
          }
          if (result.kind === "missing") {
            setStaleReloadState("idle");
            setPhase("missing");
            return;
          }
          const decoded = databaseGameHeaders(result.game);
          setLoadedStamp(result.game.stamp ?? "");
          setInitialHeaders(decoded);
          if (mode === "initial") {
            setDraft(decoded);
            setPhase("ready");
          } else {
            setStaleReloadState("idle");
            setStaleReloaded(true);
          }
        } catch (error) {
          if (controller.signal.aborted || loadSeqRef.current !== seq || !mountedRef.current) {
            return;
          }
          // Any non-aborted failure — including a cancellation not initiated by this dialog —
          // must reach a terminal error state rather than staying stuck loading/reloading.
          const message =
            inlineFailureMessage(error, "database", loadErrorFallbackRef.current) ??
            loadErrorFallbackRef.current;
          if (mode === "initial") {
            setLoadError(message);
            setPhase("load-error");
          } else {
            setStaleReloadState("failed");
            setInlineError(message);
          }
        }
      })();

      return () => {
        controller.abort();
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
        }
      };
    },
    [abortInFlightLoad, resetDialogState],
  );

  useEffect(() => {
    if (!target) {
      abortInFlightLoad();
      saveSeqRef.current += 1;
      resetDialogState();
      setSaving(false);
      savingRef.current = false;
      return;
    }

    return loadGame(target.file, target.gameId, "initial");
  }, [abortInFlightLoad, loadGame, resetDialogState, target]);

  useEffect(() => {
    if (phase !== "ready" || target === null) return;
    formRef.current?.querySelector<HTMLInputElement>("input[data-autofocus]")?.focus();
  }, [phase, target]);

  const dirty = useMemo(() => {
    if (!initialHeaders || !draft) return false;
    return !headersEqual(toHeaderUpdate(initialHeaders), toHeaderUpdate(draft));
  }, [draft, initialHeaders]);

  const eloInvalid =
    draft !== null && (!isValidElo(draft.white_elo) || !isValidElo(draft.black_elo));

  const canSave =
    target !== null &&
    phase === "ready" &&
    draft !== null &&
    dirty &&
    !eloInvalid &&
    !saving &&
    staleReloadState === "idle";

  const handleSave = useCallback(async () => {
    if (!target || !draft || !canSave || savingRef.current) return;
    const snapshotTarget = target;
    const payload = toHeaderUpdate(draft);
    const expectedStamp = loadedStamp;
    const saveSeq = ++saveSeqRef.current;

    savingRef.current = true;
    setSaving(true);
    setInlineError(null);
    setStaleReloaded(false);

    try {
      await saveDbGameHeaders({
        file: snapshotTarget.file,
        gameId: snapshotTarget.gameId,
        headers: payload,
        expectedStamp,
        cache,
        mutate: globalMutate,
        refreshFailedTitle: t("Databases.Game.SavedRefreshFailed"),
        onSaved: () => {
          if (mountedRef.current && saveSeqRef.current === saveSeq) {
            onCloseRef.current();
          }
        },
      });
    } catch (error) {
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      const appError = errorUnlessCancelled(error);
      if (!appError) return;
      if (appError.backendCategory === "stale-game") {
        loadGame(snapshotTarget.file, snapshotTarget.gameId, "stale-reload");
        return;
      }
      if (appError.backendCategory === "missing-resource") {
        if (appError.rootFailure == null) {
          setPhase("missing");
          return;
        }
        setInlineError(
          inlineFailureMessage(error, "database", loadErrorFallbackRef.current) ?? appError.message,
        );
        return;
      }
      if (appError.backendCategory === "invalid-input") {
        setInlineError(
          inlineFailureMessage(error, "database", appError.message) ?? appError.message,
        );
        return;
      }
      notifyUnlessCancelled(t("Common.Error"), error, "database");
    } finally {
      if (saveSeqRef.current === saveSeq) {
        savingRef.current = false;
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    }
  }, [cache, canSave, draft, globalMutate, loadGame, loadedStamp, t, target]);

  const closeImmediately = useCallback(() => {
    if (savingRef.current) return;
    setConfirmDiscardOpen(false);
    abortInFlightLoad();
    onClose();
  }, [abortInFlightLoad, onClose]);

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (phase === "ready" && dirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    closeImmediately();
  }, [closeImmediately, dirty, phase]);

  const handleFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const eventTarget = event.target;
    if (!(eventTarget instanceof HTMLElement)) return;
    if (eventTarget.getAttribute("data-draft-text-input") === "true") {
      event.preventDefault();
      if (canSave) {
        void handleSave();
      }
      return;
    }
    // Enter in Date, Result, or Time control never submits the form.
    if (eventTarget instanceof HTMLInputElement) {
      event.preventDefault();
    }
  };

  const documentId = target ? `${databaseHandleKey(target.file)}:${target.gameId}` : undefined;

  return (
    <>
      <AppModal
        opened={target !== null}
        onClose={requestClose}
        title={t("Databases.Game.EditData")}
        size="lg"
        pending={saving}
      >
        {phase === "loading" && (
          <Stack gap="md">
            <Center py="xl">
              <Loader />
            </Center>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeImmediately}>
                {t("Common.Cancel")}
              </Button>
            </Group>
          </Stack>
        )}

        {phase === "missing" && (
          <Stack gap="md">
            <Text>{t("Databases.Game.NoLongerExists")}</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeImmediately}>
                {t("Databases.Game.Close")}
              </Button>
            </Group>
          </Stack>
        )}

        {phase === "load-error" && (
          <Stack gap="md">
            <Alert color="danger" role="alert" icon={<AlertCircle size="1rem" />}>
              {loadError}
            </Alert>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeImmediately}>
                {t("Databases.Game.Close")}
              </Button>
            </Group>
          </Stack>
        )}

        {phase === "ready" && draft && target && (
          <form
            ref={formRef}
            onKeyDown={handleFormKeyDown}
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <Stack gap="md">
              {staleReloaded && (
                <Alert color="warning" role="status" icon={<TriangleAlert size="1rem" />}>
                  {t("Databases.Game.EditStaleReloaded")}
                </Alert>
              )}
              {eloInvalid && (
                <Alert color="danger" role="alert" icon={<AlertCircle size="1rem" />}>
                  {t("Databases.Game.EloRangeError", { min: MIN_ELO, max: MAX_ELO })}
                </Alert>
              )}
              {inlineError && (
                <Alert color="danger" role="alert" icon={<AlertCircle size="1rem" />}>
                  {inlineError}
                </Alert>
              )}
              <GameInfo headers={draft} onHeadersChange={setDraft} documentId={documentId} />
              <Group justify="flex-end">
                {staleReloadState === "failed" && (
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => loadGame(target.file, target.gameId, "stale-reload")}
                  >
                    {t("Common.Reload")}
                  </Button>
                )}
                <Button type="button" variant="default" disabled={saving} onClick={requestClose}>
                  {t("Common.Cancel")}
                </Button>
                <Button type="submit" disabled={!canSave} loading={saving}>
                  {t("Common.Save")}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </AppModal>

      <ConfirmModal
        title={t("Databases.Game.DiscardChangesTitle")}
        description={t("Databases.Game.DiscardChangesDescription")}
        confirmLabel={t("Databases.Game.DiscardChangesConfirm")}
        opened={confirmDiscardOpen}
        onClose={() => setConfirmDiscardOpen(false)}
        onConfirm={closeImmediately}
      />
    </>
  );
}
