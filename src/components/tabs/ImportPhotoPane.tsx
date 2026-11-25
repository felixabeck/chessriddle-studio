import { Button, Group, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { Clipboard, ImagePlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScoresheetPhotoBatch } from "@/bindings";
import IconAction from "@/components/common/IconAction";
import { useScoresheetErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import { warnSafely } from "@/platform/errors";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";
import {
  assistantAvailableAtom,
  coachEnabledAtom,
  refreshAssistantAvailabilityAtom,
} from "@/state/coachAvailability";
import {
  formatScoresheetIntakeCounts,
  formatScoresheetIntakeError,
  MAX_SCORESHEET_PHOTOS_PER_TAB,
} from "@/state/scoresheetPhotos";
import { requestSettingsNavigation } from "@/state/settingsNavigation";
import classes from "./ImportPhotoPane.module.css";

export type ImportPhotoPaneProps = {
  /** Called before navigating away (e.g. to close the enclosing import dialog). */
  onClose?: () => void;
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

function ImportPhotoPane({ onClose }: ImportPhotoPaneProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const store = useStore();
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const hasConnection = useAtomValue(assistantAvailableAtom);
  const refreshAvailability = useSetAtom(refreshAssistantAvailabilityAtom);
  const errorMessages = useScoresheetErrorMessages();

  const [photos, setPhotos] = useState<string[]>([]);
  const [intakeStatus, setIntakeStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const photosRef = useRef<string[]>(photos);
  photosRef.current = photos;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      if (busyRef.current) return;
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
    if (busyRef.current) return;
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
          disabled={busy || photos.length >= MAX_SCORESHEET_PHOTOS_PER_TAB}
          onClick={() => void handleChoosePhotos()}
        >
          {t("Scoresheet.Intake.ChoosePhotos")}
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<Clipboard size="0.875rem" />}
          disabled={busy || photos.length >= MAX_SCORESHEET_PHOTOS_PER_TAB}
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
    </div>
  );
}

export default ImportPhotoPane;
