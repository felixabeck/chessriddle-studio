import { Button, Group, Text } from "@mantine/core";
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import IconAction from "@/components/common/IconAction";
import { isPlainEscape, keyboardOwner } from "@/utils/keyboardOwnership";
import { areaDisplayName, arrangeTargetLabel, type ArrangeTarget } from "./boardArrange";
import type { DragPreviewState, PlacingState } from "./useBoardArranging";
import classes from "./BoardArrangeOverlay.module.css";

interface BoardArrangeOverlayProps {
  dragPreview: DragPreviewState | null;
  placing: PlacingState | null;
  onSelectTarget: (target: ArrangeTarget) => void;
  onCancelPlacing: () => void;
  resolveEngineName?: (engineId: string) => string | undefined;
}

/**
 * Renders the drag drop-target preview and the keyboard/click `aria-modal` placing dialog over
 * the analysis board layout.
 */
export default function BoardArrangeOverlay({
  dragPreview,
  placing,
  onSelectTarget,
  onCancelPlacing,
  resolveEngineName,
}: BoardArrangeOverlayProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstTargetRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const placingArea = placing?.area ?? null;
  const hasTargets = (placing?.targets.length ?? 0) > 0;
  useEffect(() => {
    if (!placingArea) return;
    const focusInitial = () => {
      const focusTarget = hasTargets ? firstTargetRef.current : closeButtonRef.current;
      focusTarget?.focus();
    };
    focusInitial();
    // A closing Mantine Menu can return focus to its target on the next frame; reclaim focus
    // inside the aria-modal placing dialog when that happens.
    const frame = requestAnimationFrame(() => {
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
        focusInitial();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [placingArea, hasTargets]);

  // Single bubble-phase Escape path for placing: handles Escape when this dialog owns the key
  // (or focus is outside every modal while this dialog is topmost), never stealing Escape from
  // a higher aria-modal surface or an event already handled.
  useEffect(() => {
    if (!placingArea) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isPlainEscape(event)) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const owner = keyboardOwner(event);
      if (owner !== null) {
        if (owner !== dialog) return;
      } else {
        const dialogs = document.querySelectorAll('[aria-modal="true"]');
        if (dialogs.item(dialogs.length - 1) !== dialog) return;
      }
      event.preventDefault();
      onCancelPlacing();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [placingArea, onCancelPlacing]);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialogRef.current.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialogRef.current.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {dragPreview &&
        (dragPreview.target.kind === "reorder" ? (
          <div
            className={classes.reorderPreview}
            data-testid="board-arrange-preview"
            data-arrange-kind="reorder"
            data-arrange-index={dragPreview.target.index}
            style={{
              left: dragPreview.box.left,
              top: dragPreview.box.top,
              width: dragPreview.box.width,
              height: dragPreview.box.height,
            }}
          />
        ) : (
          <div
            className={classes.preview}
            data-testid="board-arrange-preview"
            data-arrange-kind={dragPreview.target.kind}
            data-arrange-target={
              dragPreview.target.kind === "place"
                ? dragPreview.target.target
                : "returnZone" in dragPreview
                  ? (dragPreview.returnZone ?? "tabs")
                  : "tabs"
            }
            data-arrange-side={
              dragPreview.target.kind === "place" ? dragPreview.target.side : undefined
            }
            style={{
              left: dragPreview.box.left,
              top: dragPreview.box.top,
              width: dragPreview.box.width,
              height: dragPreview.box.height,
            }}
          >
            <span className={classes.previewBadge}>
              {arrangeTargetLabel(t, dragPreview.target, resolveEngineName, dragPreview.area)}
            </span>
          </div>
        ))}
      {placing && (
        <div
          className={classes.placingBackdrop}
          data-testid="board-arrange-placing-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) onCancelPlacing();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={classes.placingDialog}
            data-testid="board-arrange-placing"
            data-placing-area={placing.area}
            onKeyDown={handleDialogKeyDown}
          >
            <Group
              className={classes.placingHeader}
              justify="space-between"
              align="center"
              gap="xs"
              wrap="nowrap"
            >
              <Text id={titleId} fw={600} fz="sm" className={classes.placingTitle}>
                {t("Board.Arrange.PlaceTitle", {
                  area: areaDisplayName(t, placing.area, resolveEngineName),
                })}
              </Text>
              <IconAction
                ref={closeButtonRef}
                label={t("Common.Cancel")}
                size="sm"
                variant="subtle"
                onClick={onCancelPlacing}
              >
                <X size="0.875rem" />
              </IconAction>
            </Group>
            {placing.targets.length > 0 ? (
              <div className={classes.targetGrid}>
                {placing.targets.map((target, index) => {
                  const key =
                    target.kind === "return" ? "return" : `${target.target}-${target.side}`;
                  return (
                    <Button
                      key={key}
                      ref={index === 0 ? firstTargetRef : undefined}
                      variant="default"
                      size="sm"
                      className={classes.targetButton}
                      classNames={{ label: classes.targetButtonLabel }}
                      onClick={() => onSelectTarget(target)}
                    >
                      {arrangeTargetLabel(t, target, resolveEngineName, placing.area)}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <Text fz="sm" c="dimmed">
                {t("Board.Arrange.NoTargets")}
              </Text>
            )}
          </div>
        </div>
      )}
    </>
  );
}
