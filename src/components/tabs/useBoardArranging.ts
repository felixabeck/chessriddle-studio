import {
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    arrangementLeaves,
    type BoardAreaId,
    type BoardArrangement,
    isPanelArea,
    type PanelAreaId,
    type PlacementSide,
} from "@/state/boardArrangement";
import { isPlainEscape } from "@/utils/keyboardOwnership";
import { capturePointer, releasePointerCaptureSafely } from "@/utils/pointerCapture";
import {
    type ArrangeTarget,
    hitTestArrangeTarget,
    type PreviewBox,
    previewBoxForTarget,
    type RectBox,
    validArrangeTargets,
} from "./boardArrange";

/** Pointer movement in pixels required before a press becomes a drag instead of a click. */
export const ARRANGE_DRAG_THRESHOLD_PX = 6;

export interface DragPreviewState {
    target: ArrangeTarget;
    box: PreviewBox;
}

export interface PlacingState {
    area: BoardAreaId;
    targets: ArrangeTarget[];
}

interface ActiveDragSession {
    area: BoardAreaId;
    pointerId: number;
    startX: number;
    startY: number;
    element: HTMLElement;
    active: boolean;
    hoveredTarget: ArrangeTarget | null;
    validTargets: ArrangeTarget[];
    cleanup: () => void;
}

type PendingFocus =
    | { kind: "grip"; area: BoardAreaId }
    | { kind: "tab"; panel: PanelAreaId }
    | null;

function readTileRects(
    displayed: BoardArrangement,
    targets: Record<BoardAreaId, HTMLDivElement>,
): Map<BoardAreaId, RectBox> {
    const rects = new Map<BoardAreaId, RectBox>();
    for (const id of arrangementLeaves(displayed)) {
        const el = targets[id];
        if (!el || !el.isConnected) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) rects.set(id, rect);
    }
    return rects;
}

function readTabListRect(layoutEl: HTMLElement | null): RectBox | null {
    const list = layoutEl?.querySelector<HTMLElement>('[data-board-tab-list="true"]');
    if (!list) return null;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
}

/**
 * Owns pointer-capture dragging and keyboard/click placing for the analysis board's areas.
 * Every exit path (release, cancel, lost capture, Escape, window blur, unmount, or leaving the
 * arrangeable layout mode) tears down listeners, releases pointer capture and clears overlays.
 */
export function useBoardArranging({
    enabled,
    layoutRef,
    targets,
    storedArrangement,
    displayedArrangement,
    hiddenPanels,
    width,
    rootFont,
    onPlace,
    onReturn,
}: {
    enabled: boolean;
    layoutRef: RefObject<HTMLDivElement | null>;
    targets: Record<BoardAreaId, HTMLDivElement>;
    storedArrangement: BoardArrangement;
    displayedArrangement: BoardArrangement;
    hiddenPanels: ReadonlySet<PanelAreaId>;
    width: number;
    rootFont: number;
    onPlace: (area: BoardAreaId, target: BoardAreaId, side: PlacementSide) => void;
    onReturn: (panel: PanelAreaId) => void;
}) {
    const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
    const [placingRequest, setPlacingRequest] = useState<{
        area: BoardAreaId;
        originArea: BoardAreaId;
    } | null>(null);

    const sessionRef = useRef<ActiveDragSession | null>(null);
    const suppressClickRef = useRef(false);
    const suppressClickTimerRef = useRef<number | null>(null);
    const pendingReleaseCleanupRef = useRef<(() => void) | null>(null);
    const pendingFocusRef = useRef<PendingFocus>(null);

    // Keep latest callbacks and layout inputs readable from active window listeners.
    const latestRef = useRef({
        layoutRef,
        targets,
        storedArrangement,
        displayedArrangement,
        hiddenPanels,
        width,
        rootFont,
        onPlace,
        onReturn,
    });
    latestRef.current = {
        layoutRef,
        targets,
        storedArrangement,
        displayedArrangement,
        hiddenPanels,
        width,
        rootFont,
        onPlace,
        onReturn,
    };

    const clearPendingReleaseSuppression = useCallback(() => {
        const cleanup = pendingReleaseCleanupRef.current;
        if (!cleanup) return;
        pendingReleaseCleanupRef.current = null;
        cleanup();
    }, []);

    const armClickSuppression = useCallback(() => {
        clearPendingReleaseSuppression();
        suppressClickRef.current = true;
        if (suppressClickTimerRef.current !== null) {
            window.clearTimeout(suppressClickTimerRef.current);
        }
        suppressClickTimerRef.current = window.setTimeout(() => {
            suppressClickRef.current = false;
            suppressClickTimerRef.current = null;
        }, 0);
    }, [clearPendingReleaseSuppression]);

    const armClickSuppressionUntilRelease = useCallback(
        (pointerId: number) => {
            clearPendingReleaseSuppression();
            if (suppressClickTimerRef.current !== null) {
                window.clearTimeout(suppressClickTimerRef.current);
                suppressClickTimerRef.current = null;
            }
            suppressClickRef.current = true;
            const onRelease = (releaseEvent: PointerEvent) => {
                if (releaseEvent.pointerId !== pointerId) return;
                clearPendingReleaseSuppression();
                armClickSuppression();
            };
            const onBlur = () => {
                clearPendingReleaseSuppression();
                suppressClickRef.current = false;
            };
            window.addEventListener("pointerup", onRelease);
            window.addEventListener("pointercancel", onRelease);
            window.addEventListener("blur", onBlur);
            pendingReleaseCleanupRef.current = () => {
                window.removeEventListener("pointerup", onRelease);
                window.removeEventListener("pointercancel", onRelease);
                window.removeEventListener("blur", onBlur);
            };
        },
        [clearPendingReleaseSuppression, armClickSuppression],
    );

    const endDragSession = useCallback((releaseCapture: boolean) => {
        const session = sessionRef.current;
        if (!session) return;
        sessionRef.current = null;
        session.cleanup();
        if (releaseCapture) {
            releasePointerCaptureSafely(session.element, session.pointerId);
        }
        setDragPreview(null);
    }, []);

    const cancelArranging = useCallback(
        (restorePlacingFocus = false) => {
            endDragSession(true);
            clearPendingReleaseSuppression();
            suppressClickRef.current = false;
            if (!restorePlacingFocus) {
                pendingFocusRef.current = null;
            }
            setPlacingRequest((current) => {
                if (current && restorePlacingFocus) {
                    pendingFocusRef.current = { kind: "grip", area: current.originArea };
                }
                return null;
            });
        },
        [endDragSession, clearPendingReleaseSuppression],
    );

    // Turning arranging off (`enabled` -> false) or unmounting tears down every active resource.
    useEffect(() => {
        if (!enabled) cancelArranging(false);
    }, [enabled, cancelArranging]);

    useEffect(
        () => () => {
            cancelArranging(false);
            if (suppressClickTimerRef.current !== null) {
                window.clearTimeout(suppressClickTimerRef.current);
                suppressClickTimerRef.current = null;
            }
        },
        [cancelArranging],
    );

    // While placing is open, window blur ends it without a change. Escape is handled by the
    // aria-modal placing dialog itself so a higher modal's Escape is never stolen.
    useEffect(() => {
        if (!placingRequest) return;
        const onBlur = () => cancelArranging(false);
        window.addEventListener("blur", onBlur);
        return () => window.removeEventListener("blur", onBlur);
    }, [placingRequest, cancelArranging]);

    // After placing completes or cancels, restore focus to the moved area's grip or returned tab.
    // A newly detached PanelArea mounts through Mantine's Portal after context propagation, so retry
    // once on the next animation frame and always clear pending focus afterwards.
    useEffect(() => {
        if (placingRequest !== null) return;
        const pending = pendingFocusRef.current;
        if (!pending) return;
        const selector =
            pending.kind === "grip"
                ? `[data-arrange-grip="${pending.area}"]`
                : `[role="tab"][data-panel-tab="${pending.panel}"]`;
        const tryFocus = () => {
            const root = layoutRef.current ?? document;
            const target = root.querySelector<HTMLElement>(selector);
            if (!target) return false;
            pendingFocusRef.current = null;
            target.focus();
            return true;
        };
        if (tryFocus()) return;
        const frame = requestAnimationFrame(() => {
            tryFocus();
            pendingFocusRef.current = null;
        });
        return () => cancelAnimationFrame(frame);
    }, [placingRequest, displayedArrangement, layoutRef]);

    const placing = useMemo<PlacingState | null>(() => {
        if (!enabled || !placingRequest) return null;
        return {
            area: placingRequest.area,
            targets: validArrangeTargets({
                area: placingRequest.area,
                stored: storedArrangement,
                displayed: displayedArrangement,
                hiddenPanels,
                width,
                rootFont,
            }),
        };
    }, [
        enabled,
        placingRequest,
        storedArrangement,
        displayedArrangement,
        hiddenPanels,
        width,
        rootFont,
    ]);

    const beginDrag = useCallback(
        (area: BoardAreaId, event: ReactPointerEvent<HTMLElement>) => {
            if (!enabled || event.button !== 0 || area === "left") return;
            const eventTarget = event.target instanceof Element ? event.target : null;
            if (eventTarget?.closest('[data-no-drag="true"]')) return;

            // End any previous drag or placing overlay before starting a new pointer session.
            cancelArranging(false);

            const {
                storedArrangement: stored,
                displayedArrangement: displayed,
                hiddenPanels: hidden,
                width: currentWidth,
                rootFont: currentFont,
            } = latestRef.current;

            const validTargets = validArrangeTargets({
                area,
                stored,
                displayed,
                hiddenPanels: hidden,
                width: currentWidth,
                rootFont: currentFont,
            });
            if (validTargets.length === 0) return;

            const element = event.currentTarget;
            const pointerId = event.pointerId;

            const onPointerMove = (moveEvent: PointerEvent) => {
                const current = sessionRef.current;
                if (!current || current.pointerId !== moveEvent.pointerId) return;
                if (!current.active) {
                    const distance = Math.hypot(
                        moveEvent.clientX - current.startX,
                        moveEvent.clientY - current.startY,
                    );
                    if (distance < ARRANGE_DRAG_THRESHOLD_PX) return;
                    if (!capturePointer(current.element, current.pointerId)) {
                        endDragSession(false);
                        return;
                    }
                    current.active = true;
                }
                const {
                    layoutRef: currentLayoutRef,
                    targets: currentTargets,
                    displayedArrangement: currentDisplayed,
                } = latestRef.current;
                const layoutEl = currentLayoutRef.current;
                if (!layoutEl) return;
                const layoutRect = layoutEl.getBoundingClientRect();
                const tileRects = readTileRects(currentDisplayed, currentTargets);
                const tabListRect = readTabListRect(layoutEl);
                const hovered = hitTestArrangeTarget({
                    x: moveEvent.clientX,
                    y: moveEvent.clientY,
                    area: current.area,
                    validTargets: current.validTargets,
                    tileRects,
                    tabListRect,
                });
                current.hoveredTarget = hovered;
                const box = hovered
                    ? previewBoxForTarget(hovered, layoutRect, tileRects, tabListRect)
                    : null;
                setDragPreview(hovered && box ? { target: hovered, box } : null);
            };

            const onPointerUp = (upEvent: PointerEvent) => {
                const current = sessionRef.current;
                if (!current || current.pointerId !== upEvent.pointerId) return;
                const { active, hoveredTarget, area: movedArea } = current;
                endDragSession(true);
                if (active) {
                    armClickSuppression();
                    if (hoveredTarget) {
                        if (hoveredTarget.kind === "return") {
                            if (isPanelArea(movedArea)) latestRef.current.onReturn(movedArea);
                        } else {
                            latestRef.current.onPlace(
                                movedArea,
                                hoveredTarget.target,
                                hoveredTarget.side,
                            );
                        }
                    }
                }
            };

            const onPointerCancel = (cancelEvent: PointerEvent) => {
                const current = sessionRef.current;
                if (!current || current.pointerId !== cancelEvent.pointerId) return;
                endDragSession(true);
            };

            const onLostCapture = (lostEvent: PointerEvent) => {
                const current = sessionRef.current;
                if (!current || current.pointerId !== lostEvent.pointerId) return;
                endDragSession(false);
            };

            const onKeyDown = (keyEvent: KeyboardEvent) => {
                if (!isPlainEscape(keyEvent)) return;
                const current = sessionRef.current;
                if (!current) return;
                const wasActive = current.active;
                const activePointerId = current.pointerId;
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                endDragSession(true);
                if (wasActive) armClickSuppressionUntilRelease(activePointerId);
            };

            const onBlur = () => {
                endDragSession(true);
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("pointercancel", onPointerCancel);
            window.addEventListener("keydown", onKeyDown, true);
            window.addEventListener("blur", onBlur);
            element.addEventListener("lostpointercapture", onLostCapture);

            sessionRef.current = {
                area,
                pointerId,
                startX: event.clientX,
                startY: event.clientY,
                element,
                active: false,
                hoveredTarget: null,
                validTargets,
                cleanup: () => {
                    window.removeEventListener("pointermove", onPointerMove);
                    window.removeEventListener("pointerup", onPointerUp);
                    window.removeEventListener("pointercancel", onPointerCancel);
                    window.removeEventListener("keydown", onKeyDown, true);
                    window.removeEventListener("blur", onBlur);
                    element.removeEventListener("lostpointercapture", onLostCapture);
                },
            };
        },
        [
            enabled,
            cancelArranging,
            endDragSession,
            armClickSuppression,
            armClickSuppressionUntilRelease,
        ],
    );

    const consumeSuppressedClick = useCallback((event: ReactMouseEvent) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const startPlacing = useCallback(
        (area: BoardAreaId, originArea: BoardAreaId = area) => {
            if (!enabled || area === "left") return;
            endDragSession(true);
            setPlacingRequest({ area, originArea });
        },
        [enabled, endDragSession],
    );

    const applyPlacingTarget = useCallback(
        (target: ArrangeTarget) => {
            if (!placingRequest) return;
            const movedArea = placingRequest.area;
            setPlacingRequest(null);
            if (target.kind === "return") {
                if (isPanelArea(movedArea)) {
                    pendingFocusRef.current = { kind: "tab", panel: movedArea };
                    onReturn(movedArea);
                }
            } else {
                pendingFocusRef.current = { kind: "grip", area: movedArea };
                onPlace(movedArea, target.target, target.side);
            }
        },
        [placingRequest, onPlace, onReturn],
    );

    return {
        dragPreview,
        placing,
        beginDrag,
        consumeSuppressedClick,
        startPlacing,
        applyPlacingTarget,
        cancelPlacing: useCallback(() => cancelArranging(true), [cancelArranging]),
    };
}
