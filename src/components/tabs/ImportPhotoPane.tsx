import { Button, Group, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { Clipboard, ImagePlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScoresheetPhotoBatch } from "@/bindings";
import IconAction from "@/components/common/IconAction";
import {
  AiModelButton,
  aiSelectionHint,
  useAiModelSelection,
} from "@/components/panels/coach/AiModelSelection";
import { AiNoticeModal } from "@/components/panels/coach/AiNoticeModal";
import { useScoresheetErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import { coachErrorCode } from "@/platform/coach";
import { normalizeError, warnSafely } from "@/platform/errors";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";
import { tabFamily, tabsAtom } from "@/state/atoms";
import { withNoticeAccepted } from "@/state/coach";
import {
  assistantAvailableAtom,
  coachEnabledAtom,
  refreshAssistantAvailabilityAtom,
} from "@/state/coachAvailability";
import {
  formatScoresheetIntakeCounts,
  formatScoresheetIntakeError,
  MAX_SCORESHEET_PHOTOS_PER_TAB,
  scoresheetNoticeAcceptedAtom,
  setScoresheetPhotos,
} from "@/state/scoresheetPhotos";
import { requestSettingsNavigation } from "@/state/settingsNavigation";
import { buildScoresheetTree } from "@/utils/scoresheet";
import { replaceNewTab, type ReplaceNewTabResult, type Tab } from "@/utils/tabs";
import { getGameName, type TreeState } from "@/utils/treeReducer";
import classes from "./ImportPhotoPane.module.css";

export type ImportPhotoPaneProps = {
  /** Id of the tab that owns the import dialog, used to cancel a read if that tab closes. */
  ownerId?: string;
  /** Called before navigating away or after opening the imported game. */
  onClose?: () => void;
  /** Replaces the owner tab with the built game tree. Defaults to `replaceNewTab`. */
  replaceImportedTab?: (
    submittingOwnerId: string,
    tab: Omit<Tab, "value">,
    tree: TreeState,
  ) => ReplaceNewTabResult | undefined;
  /** Reports whether a native scoresheet reading turn is currently in progress. */
  onReadingChange?: (reading: boolean) => void;
};

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function ScoresheetDropSubscription({
  onDropId,
}: {
  onDropId: (dropId: string, signal: AbortSignal) => Promise<void>;
}) {
  useTauriListener(
    tauriSubscriptions.scoresheetPhotosDropped,
    async (event, signal) => {
      await onDropId(event.payload.drop, signal);
    },
    {
      onError: (error) => warnSafely(`Scoresheet photo drop listener failed: ${error.message}`),
    },
  );
  return null;
}

function ImportPhotoPane({
  ownerId = "",
  onClose,
  replaceImportedTab,
  onReadingChange,
}: ImportPhotoPaneProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const store = useStore();
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const hasConnection = useAtomValue(assistantAvailableAtom);
  const refreshAvailability = useSetAtom(refreshAssistantAvailabilityAtom);
  const errorMessages = useScoresheetErrorMessages();
  const modelSelection = useAiModelSelection();
  const { chosen } = modelSelection;
  const [noticeAccepted, setNoticeAccepted] = useAtom(scoresheetNoticeAcceptedAtom);
  const tabs = useAtomValue(tabsAtom);

  const [photos, setPhotos] = useState<string[]>([]);
  const [intakeStatus, setIntakeStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const photosRef = useRef<string[]>(photos);
  photosRef.current = photos;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const mountedRef = useRef(true);
  const readControllerRef = useRef<AbortController | null>(null);
  const readSubmitIdRef = useRef(0);
  const sawOwnerTabRef = useRef(false);

  const abortActiveRead = useCallback(() => {
    const controller = readControllerRef.current;
    if (controller) {
      readControllerRef.current = null;
      controller.abort();
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortActiveRead();
      onReadingChange?.(false);
    };
  }, [abortActiveRead, onReadingChange]);

  useEffect(() => {
    if (!ownerId) return;
    const ownerPresent = tabs.some((tab) => tab.value === ownerId);
    if (ownerPresent) {
      sawOwnerTabRef.current = true;
    } else if (sawOwnerTabRef.current) {
      abortActiveRead();
    }
  }, [abortActiveRead, ownerId, tabs]);

  useEffect(() => {
    if (coachEnabled) {
      void refreshAvailability();
    }
  }, [coachEnabled, refreshAvailability]);

  const applyBatch = useCallback(
    (batch: ScoresheetPhotoBatch) => {
      const current = photosRef.current;
      const room = Math.max(0, MAX_SCORESHEET_PHOTOS_PER_TAB - current.length);
      const accepted = batch.photos.slice(0, room).map((photo) => photo.dataUrl);
      const extraSkipped = Math.max(0, batch.photos.length - room);
      const totalSkipped = batch.skipped + extraSkipped;
      if (accepted.length > 0) {
        const next = [...current, ...accepted];
        photosRef.current = next;
        setPhotos(next);
      }
      setIntakeStatus(
        formatScoresheetIntakeCounts({ skipped: totalSkipped, failed: batch.failed }, t),
      );
    },
    [t],
  );

  const runIntake = useCallback(
    async (load: () => Promise<ScoresheetPhotoBatch>) => {
      if (busyRef.current || readingRef.current) return;
      setBusy(true);
      busyRef.current = true;
      setIntakeStatus(null);
      try {
        const batch = await load();
        if (!mountedRef.current) return;
        applyBatch(batch);
      } catch (cause) {
        if (!mountedRef.current) return;
        setIntakeStatus(formatScoresheetIntakeError(cause, errorMessages));
      } finally {
        if (mountedRef.current) {
          setBusy(false);
          busyRef.current = false;
        }
      }
    },
    [applyBatch, errorMessages],
  );

  const handleChoosePhotos = useCallback(
    () => runIntake(() => tauri.scoresheetPickPhotos()),
    [runIntake],
  );

  const handlePastePhoto = useCallback(async () => {
    if (busyRef.current || readingRef.current) return;
    if (photosRef.current.length >= MAX_SCORESHEET_PHOTOS_PER_TAB) {
      setIntakeStatus(formatScoresheetIntakeCounts({ skipped: 1, failed: 0 }, t));
      return;
    }
    await runIntake(async () => ({
      photos: [await tauri.scoresheetPastePhoto()],
      skipped: 0,
      failed: 0,
    }));
  }, [runIntake, t]);

  const handleDropId = useCallback(
    async (dropId: string, signal: AbortSignal) => {
      if (readingRef.current) return;
      try {
        const batch = await tauri.scoresheetTakeDroppedPhotos(dropId);
        if (signal.aborted || !mountedRef.current) return;
        applyBatch(batch);
      } catch (cause) {
        if (signal.aborted || !mountedRef.current) return;
        setIntakeStatus(formatScoresheetIntakeError(cause, errorMessages));
      }
    },
    [applyBatch, errorMessages],
  );

  useEffect(() => {
    if (!hasConnection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "v") return;
      if (isEditableElement(document.activeElement) || isEditableElement(event.target)) return;
      event.preventDefault();
      void handlePastePhoto();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasConnection, handlePastePhoto]);

  const handleRemovePhoto = useCallback((index: number) => {
    if (readingRef.current) return;
    setPhotos((current) => {
      const next = current.filter((_, i) => i !== index);
      photosRef.current = next;
      return next;
    });
  }, []);

  const handleOpenSettings = useCallback(() => {
    onClose?.();
    requestSettingsNavigation({ kind: "category", category: "coach" }, store);
    void navigate({ to: "/settings" });
  }, [navigate, onClose, store]);

  const runRead = useCallback(async () => {
    if (readingRef.current) return;
    const connection = chosen.connection;
    const model = chosen.model;
    const submittedPhotos = [...photosRef.current];
    if (!connection || !model || submittedPhotos.length === 0) return;

    const submittingOwnerId = ownerId;
    const submitId = ++readSubmitIdRef.current;
    const controller = new AbortController();
    readControllerRef.current = controller;

    setReading(true);
    readingRef.current = true;
    setReadError(null);
    onReadingChange?.(true);

    const isActiveSubmit = () =>
      mountedRef.current && readSubmitIdRef.current === submitId && !controller.signal.aborted;

    try {
      let game;
      try {
        game = await tauri.scoresheetRead(
          {
            connection: connection.handle,
            model: model.id,
            effort: chosen.effort ?? undefined,
            photos: submittedPhotos,
          },
          { signal: controller.signal },
        );
      } catch (cause) {
        if (!isActiveSubmit()) return;
        const code = coachErrorCode(cause);
        if (code !== "cancelled") {
          setReadError(errorMessages[code]);
        }
        return;
      }

      if (!isActiveSubmit()) return;

      let tree: TreeState;
      try {
        tree = await buildScoresheetTree(game, { signal: controller.signal });
      } catch (cause) {
        if (!isActiveSubmit()) return;
        warnSafely(`Scoresheet tree build failed: ${normalizeError(cause).message.slice(0, 200)}`);
        setReadError(t("Scoresheet.Read.CouldNotOpen"));
        return;
      }

      if (!isActiveSubmit()) return;

      const tab: Omit<Tab, "value"> = {
        name: getGameName(tree.headers),
        gameOrigin: { kind: "none" },
        type: "analysis",
      };
      let result: ReplaceNewTabResult | undefined;
      try {
        result = replaceImportedTab
          ? replaceImportedTab(submittingOwnerId, tab, tree)
          : replaceNewTab({ store, ownerId: submittingOwnerId, tab, tree });
      } catch (cause) {
        warnSafely(`Scoresheet tab open failed: ${normalizeError(cause).message.slice(0, 200)}`);
        result = undefined;
      }

      if (!isActiveSubmit()) return;

      if (result?.kind !== "committed") {
        setReadError(t("Scoresheet.Read.CouldNotOpen"));
        return;
      }

      setScoresheetPhotos(result.id, submittedPhotos);
      store.set(tabFamily(result.id), "photo");
      onClose?.();
    } finally {
      if (readControllerRef.current === controller) {
        readControllerRef.current = null;
      }
      if (mountedRef.current && readSubmitIdRef.current === submitId) {
        setReading(false);
        readingRef.current = false;
        onReadingChange?.(false);
      }
    }
  }, [
    chosen.connection,
    chosen.effort,
    chosen.model,
    errorMessages,
    onClose,
    onReadingChange,
    ownerId,
    replaceImportedTab,
    store,
    t,
  ]);

  const handleReadClick = useCallback(() => {
    if (readingRef.current) return;
    const connection = chosen.connection;
    if (!connection || !chosen.model || photosRef.current.length === 0) return;
    if (!noticeAccepted.includes(connection.handle)) {
      setNoticeOpen(true);
      return;
    }
    void runRead();
  }, [chosen.connection, chosen.model, noticeAccepted, runRead]);

  const handleCancelRead = useCallback(() => {
    abortActiveRead();
    setReading(false);
    readingRef.current = false;
    setReadError(null);
    onReadingChange?.(false);
  }, [abortActiveRead, onReadingChange]);

  const selectionHint = aiSelectionHint(modelSelection, errorMessages, t);
  const canRead =
    !reading && photos.length > 0 && Boolean(chosen.connection) && Boolean(chosen.model);

  if (!hasConnection) {
    return (
      <div className={classes.emptyConnection} data-scoresheet-no-connection>
        <Text size="sm">{t("Scoresheet.Intake.NeedsConnection")}</Text>
        <Button size="xs" variant="default" onClick={handleOpenSettings}>
          {t("Scoresheet.Intake.OpenAiSettings")}
        </Button>
      </div>
    );
  }

  return (
    <div className={classes.pane} data-scoresheet-intake-pane>
      <ScoresheetDropSubscription onDropId={handleDropId} />

      <Group gap="xs" wrap="wrap">
        <Button
          size="xs"
          variant="default"
          leftSection={<ImagePlus size="0.875rem" />}
          disabled={busy || reading || photos.length >= MAX_SCORESHEET_PHOTOS_PER_TAB}
          onClick={() => void handleChoosePhotos()}
        >
          {t("Scoresheet.Intake.ChoosePhotos")}
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<Clipboard size="0.875rem" />}
          disabled={busy || reading || photos.length >= MAX_SCORESHEET_PHOTOS_PER_TAB}
          onClick={() => void handlePastePhoto()}
        >
          {t("Scoresheet.Intake.PasteFromClipboard")}
        </Button>
      </Group>

      <div className={classes.dropHint}>
        <Text size="xs" c="dimmed">
          {t("Scoresheet.Intake.DropHint")}
        </Text>
      </div>

      {photos.length > 0 && (
        <div className={classes.thumbnails} data-scoresheet-thumbnails>
          {photos.map((url, index) => (
            <div key={`${index}-${url.length}`} className={classes.thumbnail}>
              <img
                src={url}
                alt={t("Scoresheet.PhotoAlt", { number: index + 1 })}
                className={classes.thumbnailImage}
              />
              <div className={classes.removeButton}>
                <IconAction
                  label={t("Scoresheet.Intake.RemovePhoto", { number: index + 1 })}
                  size="xs"
                  disabled={reading}
                  onClick={() => handleRemovePhoto(index)}
                >
                  <X size="0.75rem" />
                </IconAction>
              </div>
            </div>
          ))}
        </div>
      )}

      {intakeStatus && (
        <Text size="xs" c="dimmed" role="status" data-scoresheet-intake-status>
          {intakeStatus}
        </Text>
      )}

      <div className={classes.actionRow}>
        <AiModelButton
          state={modelSelection}
          errors={errorMessages}
          position="top-start"
          disabled={reading}
        />
      </div>

      {selectionHint && (
        <Text size="xs" c="dimmed" data-scoresheet-selection-hint>
          {selectionHint}
        </Text>
      )}

      {reading ? (
        <div className={classes.actionRow} data-scoresheet-reading>
          <Text size="xs" c="dimmed" role="status">
            {t("Scoresheet.Read.PendingHint")}
          </Text>
          <Button size="xs" variant="default" onClick={handleCancelRead}>
            {t("Common.Cancel")}
          </Button>
        </div>
      ) : (
        <Button fullWidth radius="md" disabled={!canRead} onClick={handleReadClick}>
          {t("Scoresheet.Read.Button")}
        </Button>
      )}

      {readError && (
        <Text c="danger" size="sm" role="alert" data-scoresheet-read-error>
          {readError}
        </Text>
      )}

      {noticeOpen && chosen.connection && (
        <AiNoticeModal
          title={t("Scoresheet.Notice.Title")}
          body={t("Scoresheet.Notice.Body", { provider: chosen.connection.label })}
          acceptLabel={t("Scoresheet.Notice.Accept")}
          onCancel={() => setNoticeOpen(false)}
          onAccept={() => {
            if (!chosen.connection) return;
            setNoticeAccepted(withNoticeAccepted(noticeAccepted, chosen.connection.handle));
            setNoticeOpen(false);
            void runRead();
          }}
        />
      )}
    </div>
  );
}

export default ImportPhotoPane;
