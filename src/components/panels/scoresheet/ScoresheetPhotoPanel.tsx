import { Button, Group, Text } from "@mantine/core";
import { Check, ChevronLeft, ChevronRight, ImagePlus, Maximize2, Minimize2 } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import IconAction from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useScoresheetErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import { coachErrorCode } from "@/platform/coach";
import { tauri } from "@/platform/tauri";
import {
  cacheStoredScoresheetPhotos,
  clearUnsavedScoresheetPhotos,
  formatScoresheetIntakeCounts,
  formatScoresheetIntakeError,
  setUnsavedScoresheetPhotos,
  useResolvedScoresheetPhotos,
} from "@/state/scoresheetPhotos";
import { useOwnerTabId } from "@/state/tabScope";
import { formatMoveNumber } from "@/utils/format";
import {
  getScoresheetPhotoIds,
  planScoresheetContinuation,
  withScoresheetPhotoIds,
} from "@/utils/scoresheet";
import {
  countMainPly,
  deriveScoresheetRemaining,
  getMainLineUnsurePaths,
  getNodeAtPath,
} from "@/utils/treeReducer";
import classes from "./ScoresheetPhotoPanel.module.css";

/** Formats remaining sheet tokens starting at `nextPly` into numbered move text. */
export function formatScoresheetRemainingTokens(
  nextPly: number,
  tokens: readonly string[],
  initialHalfMoves = 0,
): string {
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const halfMoves = initialHalfMoves + nextPly + i + 1;
    const isWhite = halfMoves % 2 === 1;
    if (isWhite || i === 0) {
      parts.push(`${formatMoveNumber(halfMoves)} ${tokens[i]}`);
    } else {
      parts.push(tokens[i]);
    }
  }
  return parts.join(" ");
}

/**
 * Picks the next or previous main-line unsure path relative to `position`, wrapping around.
 * Returns `null` when `unsurePaths` is empty.
 */
export function adjacentUnsurePath(
  unsurePaths: readonly number[][],
  position: readonly number[],
  direction: "previous" | "next",
): number[] | null {
  if (unsurePaths.length === 0) return null;
  const firstDeviation = position.findIndex((index) => index !== 0);
  const onMainLine = firstDeviation === -1;
  const mainDepth = onMainLine ? position.length : firstDeviation;

  if (direction === "next") {
    return unsurePaths.find((path) => path.length > mainDepth) ?? unsurePaths[0];
  }
  for (let i = unsurePaths.length - 1; i >= 0; i--) {
    const ply = unsurePaths[i].length;
    if (onMainLine ? ply < mainDepth : ply <= mainDepth) return unsurePaths[i];
  }
  return unsurePaths[unsurePaths.length - 1];
}

function ScoresheetPhotoPanel() {
  const { t } = useTranslation();
  const tabId = useOwnerTabId();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const position = useStore(store, (s) => s.position);
  const review = useStore(store, (s) => s.scoresheetReview);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const goToMove = useStore(store, (s) => s.goToMove);
  const clearUnsureMark = useStore(store, (s) => s.clearUnsureMark);
  const continueScoresheet = useStore(store, (s) => s.continueScoresheet);

  const photoIds = useMemo(() => getScoresheetPhotoIds(headers), [headers]);
  const resolved = useResolvedScoresheetPhotos(tabId, photoIds);
  const { slots, readError, storeError, retry } = resolved;

  const [fullSize, setFullSize] = useState(false);
  const [page, setPage] = useState(0);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [intakeStatus, setIntakeStatus] = useState<string | null>(null);
  const [scrollbarInsets, setScrollbarInsets] = useState({ right: 0, bottom: 0 });
  const errorMessages = useScoresheetErrorMessages();
  const mountedRef = useRef(true);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const pickRequestRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const measureScrollbarInsets = useCallback(() => {
    const el = viewportRef.current;
    const nextRight = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
    const nextBottom = el ? Math.max(0, el.offsetHeight - el.clientHeight) : 0;
    setScrollbarInsets((prev) =>
      prev.right === nextRight && prev.bottom === nextBottom
        ? prev
        : { right: nextRight, bottom: nextBottom },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    pickRequestRef.current += 1;
    setIntakeStatus(null);
    setPage(0);
    setLoadingPhotos(false);
  }, [tabId]);

  const handleLoadPhotoAgain = useCallback(async () => {
    if (loadingPhotos) return;
    const ownerTab = tabIdRef.current;
    const requestId = ++pickRequestRef.current;
    setLoadingPhotos(true);
    setIntakeStatus(null);
    try {
      const batch = await tauri.scoresheetPickPhotos();
      if (!mountedRef.current || pickRequestRef.current !== requestId) return;
      const pickedUrls = batch.photos.map((photo) => photo.dataUrl);
      if (pickedUrls.length > 0) {
        try {
          const ids = await tauri.scoresheetStorePhotos(pickedUrls);
          if (!mountedRef.current || pickRequestRef.current !== requestId) return;
          cacheStoredScoresheetPhotos(ids, pickedUrls);
          clearUnsavedScoresheetPhotos(ownerTab);
          setHeaders(withScoresheetPhotoIds(store.getState().headers, ids));
        } catch (storeCause) {
          if (!mountedRef.current || pickRequestRef.current !== requestId) return;
          setUnsavedScoresheetPhotos(ownerTab, pickedUrls, coachErrorCode(storeCause));
        }
        setPage(0);
      }
      setIntakeStatus(formatScoresheetIntakeCounts(batch, t));
    } catch (cause) {
      if (!mountedRef.current || pickRequestRef.current !== requestId) return;
      setIntakeStatus(formatScoresheetIntakeError(cause, errorMessages));
    } finally {
      if (mountedRef.current && pickRequestRef.current === requestId) {
        setLoadingPhotos(false);
      }
    }
  }, [errorMessages, loadingPhotos, setHeaders, store, t]);

  const totalPages = slots.length;
  const safePage = totalPages > 0 ? Math.min(page, totalPages - 1) : 0;
  const currentSlot = totalPages > 0 ? slots[safePage] : null;
  const currentPhotoUrl = currentSlot?.status === "ok" ? currentSlot.dataUrl : null;

  useEffect(() => {
    measureScrollbarInsets();
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScrollbarInsets);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureScrollbarInsets, fullSize, safePage, currentPhotoUrl]);

  const unsurePaths = useMemo(() => (review ? getMainLineUnsurePaths(root) : []), [review, root]);
  const onMainLine = position.length > 0 && position.every((index) => index === 0);
  const currentIsUnsure =
    review !== undefined && onMainLine && getNodeAtPath(root, position).unsure === true;

  const remaining = useMemo(
    () =>
      review?.stopped
        ? deriveScoresheetRemaining(review.stopped, countMainPly(root), root.halfMoves)
        : null,
    [review?.stopped, root],
  );
  const remainingText = useMemo(
    () =>
      remaining
        ? formatScoresheetRemainingTokens(remaining.nextPly, remaining.tokens, root.halfMoves)
        : "",
    [remaining, root.halfMoves],
  );
  const continuationPlan = useMemo(
    () => planScoresheetContinuation(root, position, review),
    [root, position, review],
  );

  const jumpUnsure = (direction: "previous" | "next") => {
    const target = adjacentUnsurePath(unsurePaths, position, direction);
    if (target) goToMove(target);
  };

  const viewportStyle = {
    "--scoresheet-scrollbar-right": `${scrollbarInsets.right}px`,
    "--scoresheet-scrollbar-bottom": `${scrollbarInsets.bottom}px`,
  } as CSSProperties;

  const pageControls =
    totalPages > 1 ? (
      <div className={classes.pageOverlay} data-scoresheet-page-overlay>
        <Group gap={4} wrap="nowrap">
          <IconAction
            label={t("Scoresheet.PreviousPage")}
            size="sm"
            variant="subtle"
            disabled={safePage === 0}
            onClick={() => setPage(Math.max(0, safePage - 1))}
          >
            <ChevronLeft size="1rem" />
          </IconAction>
          <Text size="xs" fw={500} data-scoresheet-page>
            {t("Scoresheet.PageOf", { current: safePage + 1, total: totalPages })}
          </Text>
          <IconAction
            label={t("Scoresheet.NextPage")}
            size="sm"
            variant="subtle"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
          >
            <ChevronRight size="1rem" />
          </IconAction>
        </Group>
      </div>
    ) : null;

  const loadPhotoAgainButton = (
    <Button
      size="xs"
      variant="default"
      leftSection={<ImagePlus size="0.875rem" />}
      loading={loadingPhotos}
      onClick={() => void handleLoadPhotoAgain()}
    >
      {t("Scoresheet.LoadPhotoAgain")}
    </Button>
  );

  return (
    <div className={classes.panel}>
      <div className={classes.photoSection}>
        {currentPhotoUrl !== null ? (
          <div className={classes.viewportFrame} style={viewportStyle}>
            <div
              ref={viewportRef}
              className={classes.viewport}
              data-scoresheet-photo-size={fullSize ? "full" : "fit"}
            >
              <img
                src={currentPhotoUrl}
                alt={t("Scoresheet.PhotoAlt", { number: safePage + 1 })}
                className={fullSize ? classes.imageFull : classes.imageFit}
                onLoad={measureScrollbarInsets}
              />
            </div>
            <div className={classes.enlargeOverlay} data-scoresheet-enlarge-overlay>
              <IconAction
                label={fullSize ? t("Scoresheet.FitToPanel") : t("Scoresheet.FullSize")}
                size="sm"
                variant="default"
                pressed={fullSize}
                onClick={() => setFullSize((value) => !value)}
              >
                {fullSize ? <Minimize2 size="1rem" /> : <Maximize2 size="1rem" />}
              </IconAction>
            </div>
            {pageControls}
          </div>
        ) : currentSlot?.status === "loading" ? (
          <div className={classes.emptyPhoto} data-scoresheet-loading-photo>
            <Text size="sm" c="dimmed" role="status">
              {t("Common.Loading")}
            </Text>
          </div>
        ) : currentSlot?.status === "unreadable" ? (
          <div className={classes.emptyPhoto} data-scoresheet-photo-unreadable>
            <Text size="sm" c="dimmed" role="alert">
              {readError ? errorMessages[readError] : errorMessages.photoStorage}
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={retry}>
                {t("Common.Retry")}
              </Button>
              {loadPhotoAgainButton}
            </Group>
            {pageControls}
          </div>
        ) : (
          <div className={classes.emptyPhoto} data-scoresheet-no-photo>
            <Text size="sm" c="dimmed">
              {currentSlot?.status === "missing"
                ? t("Scoresheet.PhotoNotOnComputer")
                : t("Scoresheet.NoPhotoInMemory")}
            </Text>
            {loadPhotoAgainButton}
            {pageControls}
          </div>
        )}
        {storeError && (
          <Text size="xs" c="danger" role="alert" data-scoresheet-store-error>
            {errorMessages[storeError]}
          </Text>
        )}
        {intakeStatus && (
          <Text size="xs" c="dimmed" role="status" data-scoresheet-intake-status>
            {intakeStatus}
          </Text>
        )}
      </div>

      {review !== undefined && (
        <div className={classes.controls}>
          <Group justify="space-between" wrap="wrap" gap="xs" data-scoresheet-review-row>
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" fw={500} data-scoresheet-unsure-count>
                {unsurePaths.length === 0
                  ? t("Scoresheet.AllMovesChecked")
                  : t("Scoresheet.MovesToCheck", { count: unsurePaths.length })}
              </Text>
              <IconAction
                label={t("Scoresheet.PreviousUnsure")}
                size="sm"
                disabled={unsurePaths.length === 0}
                onClick={() => jumpUnsure("previous")}
              >
                <ChevronLeft size="1rem" />
              </IconAction>
              <IconAction
                label={t("Scoresheet.NextUnsure")}
                size="sm"
                disabled={unsurePaths.length === 0}
                onClick={() => jumpUnsure("next")}
              >
                <ChevronRight size="1rem" />
              </IconAction>
            </Group>
            {unsurePaths.length > 0 && (
              <Button
                size="xs"
                variant="default"
                leftSection={<Check size="0.875rem" />}
                disabled={!currentIsUnsure}
                onClick={() => clearUnsureMark()}
              >
                {t("Scoresheet.MarkAsChecked")}
              </Button>
            )}
          </Group>

          {remaining && (
            <div className={classes.stopNotice} data-scoresheet-stop-notice>
              <Text size="xs" fw={600}>
                {remaining.failedToken !== undefined
                  ? remaining.color === "white"
                    ? t("Scoresheet.StoppedAtWhite", { move: remaining.moveNumber })
                    : t("Scoresheet.StoppedAtBlack", { move: remaining.moveNumber })
                  : remaining.color === "white"
                    ? t("Scoresheet.NextOnSheetWhite", { move: remaining.moveNumber })
                    : t("Scoresheet.NextOnSheetBlack", { move: remaining.moveNumber })}
              </Text>
              {remaining.failedToken !== undefined && (
                <Text size="xs" c="dimmed" data-scoresheet-failed-token>
                  {t("Scoresheet.CouldNotPlay", { token: remaining.failedToken })}
                </Text>
              )}
              <Text className={classes.remainingTokens} data-scoresheet-remaining-tokens>
                {remainingText}
              </Text>
            </div>
          )}

          {continuationPlan && (
            <div className={classes.continueBox} data-scoresheet-continue>
              <Text size="xs" c="dimmed">
                {t("Scoresheet.ContinueHint")}
              </Text>
              <Button
                size="xs"
                variant="default"
                onClick={continueScoresheet}
                data-scoresheet-continue-button
              >
                {t("Scoresheet.ContinueWithSheet")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ScoresheetPhotoPanel;
