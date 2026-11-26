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
    type EngineAreaId,
    engineIdFromArea,
    type HideableAreaId,
    isEngineArea,
    isPanelArea,
    type PanelAreaId,
    type PlacementSide,
} from "@/state/boardArrangement";
import { isPlainEscape } from "@/utils/keyboardOwnership";
import { capturePointer, releasePointerCaptureSafely } from "@/utils/pointerCapture";
import {
    type ArrangeTarget,
    type DragTarget,
    hitTestArrangeTarget,
    hitTestReorderSlot,
    intersectRects,
    pointInRect,
    type PreviewBox,
    previewBoxForTarget,
    type RectBox,
    reorderPreviewBox,
    type ReturnZone,
    validArrangeTargets,
} from "./boardArrange";

/** Pointer movement in pixels required before a press becomes a drag instead of a click. */
export const ARRANGE_DRAG_THRESHOLD_PX = 6;

export type DragPreviewState =
    | { area: BoardAreaId; target: ArrangeTarget; returnZone?: ReturnZone; box: PreviewBox }
    | { area: BoardAreaId; target: { kind: "reorder"; index: number }; box: PreviewBox };

export interface PlacingState {
    area: BoardAreaId;
    targets: ArrangeTarget[];
}

export interface EngineCardReorderOptions {
    listContainer: HTMLElement | null;
    reorderIds: readonly string[];
    onReorder: (fromIndex: number, toIndex: number) => void;
}

interface ActiveDragSession {
    area: BoardAreaId;
    pointerId: number;
    startX: number;
    startY: number;
    element: HTMLElement;
    active: boolean;
    hoveredTarget: DragTarget | null;
    validTargets: ArrangeTarget[];
    reorder?: EngineCardReorderOptions;
    cleanup: () => void;
}

type PendingFocus =
    | { kind: "grip"; area: BoardAreaId }
    | { kind: "tab"; panel: PanelAreaId }
    | { kind: "engineReturn"; area: EngineAreaId }
    | null;

function readTileRects(
    displayed: BoardArrangement,
    targets: ReadonlyMap<BoardAreaId, HTMLDivElement>,
): Map<BoardAreaId, RectBox> {
    const rects = new Map<BoardAreaId, RectBox>();
    for (const id of arrangementLeaves(displayed)) {
        const el = targets.get(id);
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

function readReturnZone(
    layoutEl: HTMLElement | null,
    area: BoardAreaId,
    displayed: BoardArrangement,
): { rect: RectBox; zone: ReturnZone } | null {
    if (isEngineArea(area) && arrangementLeaves(displayed).includes("analysis")) {
        const header = layoutEl?.querySelector<HTMLElement>('[data-panel-header="analysis"]');
        if (!header) return null;
        const rect = header.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { rect, zone: "engines" } : null;
    }
    const rect = readTabListRect(layoutEl);
    return rect ? { rect, zone: "tabs" } : null;
}

/**
 * Intersects `element`'s bounding rect with every clipping ancestor (scroll viewport or
 * `overflow != visible`) up to `stopAt` so overflowed lists never intercept drops outside their
 * visible scroll viewport.
 */
function visibleClipRect(element: HTMLElement, stopAt: HTMLElement | null): RectBox | null {
    let rect: RectBox | null = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== stopAt) {
        const style = window.getComputedStyle(ancestor);
        const clips =
            (style.overflow !== "" && style.overflow !== "visible") ||
            (style.overflowX !== "" && style.overflowX !== "visible") ||
            (style.overflowY !== "" && style.overflowY !== "visible");
        if (clips) {
            const clip = ancestor.getBoundingClientRect();
            if (clip.width > 0 && clip.height > 0) {
                rect = intersectRects(rect, clip);
                if (!rect) return null;
            }
        }
        ancestor = ancestor.parentElement;
    }
    return rect;
}

function readVisibleEngineCardSlots(
    container: HTMLElement,
    reorderIds: readonly string[],
    clipRect: RectBox,
): Array<{ index: number; rect: RectBox }> {
    const byId = new Map<string, HTMLElement>();
    for (const el of container.querySelectorAll<HTMLElement>("[data-engine-card-id]")) {
        const id = el.dataset.engineCardId;
        if (id) byId.set(id, el);
    }
    const visible: Array<{ index: number; rect: RectBox }> = [];
    for (let index = 0; index < reorderIds.length; index += 1) {
        const el = byId.get(reorderIds[index]);
        if (!el) continue;
        const raw = el.getBoundingClientRect();
        const clipped = intersectRects(raw, clipRect);
        if (clipped) visible.push({ index, rect: clipped });
    }
    return visible;
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
    hiddenAreas,
    width,
    rootFont,
    onPlace,
    onReturn,
    onReturnEngine,
}: {
    enabled: boolean;
    layoutRef: RefObject<HTMLDivElement | null>;
    targets: ReadonlyMap<BoardAreaId, HTMLDivElement>;
    storedArrangement: BoardArrangement;
    displayedArrangement: BoardArrangement;
    hiddenAreas: ReadonlySet<HideableAreaId>;
    width: number;
    rootFont: number;
    onPlace: (area: BoardAreaId, target: BoardAreaId, side: PlacementSide) => void;
    onReturn: (panel: PanelAreaId) => void;
    onReturnEngine: (area: EngineAreaId) => void;
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
        enabled,
        layoutRef,
        targets,
        storedArrangement,
        displayedArrangement,
        hiddenAreas,
        width,
        rootFont,
        onPlace,
        onReturn,
        onReturnEngine,
    });
    latestRef.current = {
        enabled,
        layoutRef,
        targets,
        storedArrangement,
        displayedArrangement,
        hiddenAreas,
        width,
        rootFont,
        onPlace,
        onReturn,
        onReturnEngine,
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

    // Turning arranging off (`enabled` -> false) tears down placing and board-arrangement drags
    // (an active engine-card reorder drag continues since reorder works in non-arranged mode too).
    useEffect(() => {
        if (!enabled) {
            if (sessionRef.current && !sessionRef.current.reorder) {
                endDragSession(true);
            }
            setPlacingRequest(null);
        }
    }, [enabled, endDragSession]);

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
    // A newly detached PanelArea or returned engine card mounts after context propagation, so retry
    // once on the next animation frame and always clear pending focus afterwards.
    useEffect(() => {
        if (placingRequest !== null) return;
        const pending = pendingFocusRef.current;
        if (!pending) return;
        const findGrip = (root: ParentNode, area: BoardAreaId) =>
            Array.from(root.querySelectorAll<HTMLElement>("[data-arrange-grip]")).find(
                (el) => el.dataset.arrangeGrip === area && !el.closest("[hidden]"),
            ) ?? null;
        const findTab = (root: ParentNode, panel: PanelAreaId) =>
            Array.from(root.querySelectorAll<HTMLElement>('[role="tab"][data-panel-tab]')).find(
                (el) => el.dataset.panelTab === panel && !el.closest("[hidden]"),
            ) ?? null;
        const tryFocus = (allowFallback: boolean) => {
            const root = layoutRef.current ?? document;
            // Match dataset directly rather than interpolating area ids (which may contain `:`) into a CSS selector.
            let target: HTMLElement | null = null;
            if (pending.kind === "grip") {
                target = findGrip(root, pending.area);
            } else if (pending.kind === "tab") {
                target = findTab(root, pending.panel);
            } else {
                target = findGrip(root, pending.area);
                if (!target && allowFallback) {
                    if (!latestRef.current.hiddenAreas.has("topRight")) {
                        target = findTab(root, "analysis");
                    }
                    if (!target) {
                        target = findGrip(root, "bottomRight");
                    }
                }
            }
            if (!target) return false;
            pendingFocusRef.current = null;
            target.focus();
            return true;
        };
        if (tryFocus(false)) return;
        const frame = requestAnimationFrame(() => {
            tryFocus(true);
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
                hiddenAreas,
                width,
                rootFont,
            }),
        };
    }, [
        enabled,
        placingRequest,
        storedArrangement,
        displayedArrangement,
        hiddenAreas,
        width,
        rootFont,
    ]);

    const beginDrag = useCallback(
        (
            area: BoardAreaId,
            event: ReactPointerEvent<HTMLElement>,
            reorder?: EngineCardReorderOptions,
        ) => {
            if (event.button !== 0 || area === "left") return;
            if (!reorder && !enabled) return;
            const eventTarget = event.target instanceof Element ? event.target : null;
            if (eventTarget?.closest('[data-no-drag="true"]')) return;

            // End any previous drag or placing overlay before starting a new pointer session.
            cancelArranging(false);

            const {
                storedArrangement: stored,
                displayedArrangement: displayed,
                hiddenAreas: hidden,
                width: currentWidth,
                rootFont: currentFont,
            } = latestRef.current;

            const validTargets = enabled
                ? validArrangeTargets({
                      area,
                      stored,
                      displayed,
                      hiddenAreas: hidden,
                      width: currentWidth,
                      rootFont: currentFont,
                  })
                : [];
            const canReorder = Boolean(reorder && reorder.reorderIds.length >= 2);
            if (validTargets.length === 0 && !canReorder) return;

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
                    enabled: currentEnabled,
                    layoutRef: currentLayoutRef,
                    targets: currentTargets,
                    displayedArrangement: currentDisplayed,
                } = latestRef.current;
                const layoutEl = currentLayoutRef.current;
                const layoutRect = layoutEl?.getBoundingClientRect() ?? null;

                if (
                    current.reorder &&
                    isEngineArea(current.area) &&
                    current.reorder.listContainer?.isConnected
                ) {
                    const visibleListRect = visibleClipRect(
                        current.reorder.listContainer,
                        layoutEl,
                    );
                    if (
                        visibleListRect &&
                        pointInRect(moveEvent.clientX, moveEvent.clientY, visibleListRect)
                    ) {
                        const visibleSlots = readVisibleEngineCardSlots(
                            current.reorder.listContainer,
                            current.reorder.reorderIds,
                            visibleListRect,
                        );
                        const currentIndex = current.reorder.reorderIds.indexOf(
                            engineIdFromArea(current.area),
                        );
                        const visibleCurrentIndex = visibleSlots.findIndex(
                            (entry) => entry.index === currentIndex,
                        );
                        const cardRects = visibleSlots.map((entry) => entry.rect);
                        const visibleSlot =
                            visibleCurrentIndex !== -1
                                ? hitTestReorderSlot({
                                      x: moveEvent.clientX,
                                      y: moveEvent.clientY,
                                      containerRect: visibleListRect,
                                      cardRects,
                                      currentIndex: visibleCurrentIndex,
                                  })
                                : null;
                        if (visibleSlot !== null) {
                            const fullSlot =
                                visibleSlot === visibleSlots.length
                                    ? visibleSlots[visibleSlots.length - 1].index + 1
                                    : visibleSlots[visibleSlot].index;
                            const target = { kind: "reorder" as const, index: fullSlot };
                            current.hoveredTarget = target;
                            const box = layoutRect
                                ? reorderPreviewBox(visibleSlot, layoutRect, cardRects)
                                : null;
                            setDragPreview(box ? { area: current.area, target, box } : null);
                            return;
                        }
                        // Inside the visible card list on the card's own slot: neither reorder nor pull-out.
                        current.hoveredTarget = null;
                        setDragPreview(null);
                        return;
                    }
                }

                if (
                    !currentEnabled ||
                    !layoutEl ||
                    !layoutRect ||
                    current.validTargets.length === 0
                ) {
                    current.hoveredTarget = null;
                    setDragPreview(null);
                    return;
                }
                const tileRects = readTileRects(currentDisplayed, currentTargets);
                const returnZone = readReturnZone(layoutEl, current.area, currentDisplayed);
                const returnRect = returnZone?.rect ?? null;
                const hovered = hitTestArrangeTarget({
                    x: moveEvent.clientX,
                    y: moveEvent.clientY,
                    area: current.area,
                    validTargets: current.validTargets,
                    tileRects,
                    returnRect,
                });
                current.hoveredTarget = hovered;
                const box = hovered
                    ? previewBoxForTarget(hovered, layoutRect, tileRects, returnRect, current.area)
                    : null;
                setDragPreview(
                    hovered && box
                        ? {
                              area: current.area,
                              target: hovered,
                              returnZone: hovered.kind === "return" ? returnZone?.zone : undefined,
                              box,
                          }
                        : null,
                );
            };

            const onPointerUp = (upEvent: PointerEvent) => {
                const current = sessionRef.current;
                if (!current || current.pointerId !== upEvent.pointerId) return;
                const { active, hoveredTarget, area: movedArea, reorder: activeReorder } = current;
                endDragSession(true);
                if (active) {
                    armClickSuppression();
                    if (hoveredTarget) {
                        if (hoveredTarget.kind === "reorder") {
                            if (activeReorder && isEngineArea(movedArea)) {
                                const fromIndex = activeReorder.reorderIds.indexOf(
                                    engineIdFromArea(movedArea),
                                );
                                const toIndex =
                                    hoveredTarget.index > fromIndex
                                        ? hoveredTarget.index - 1
                                        : hoveredTarget.index;
                                if (fromIndex !== -1 && toIndex !== fromIndex) {
                                    activeReorder.onReorder(fromIndex, toIndex);
                                }
                            }
                        } else if (hoveredTarget.kind === "return") {
                            if (isPanelArea(movedArea)) {
                                latestRef.current.onReturn(movedArea);
                            } else if (isEngineArea(movedArea)) {
                                latestRef.current.onReturnEngine(movedArea);
                            }
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
                reorder,
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

    const scheduleEngineReturnFocus = useCallback((area: EngineAreaId) => {
        pendingFocusRef.current = { kind: "engineReturn", area };
    }, []);

    const applyPlacingTarget = useCallback(
        (target: ArrangeTarget) => {
            if (!placingRequest) return;
            const movedArea = placingRequest.area;
            setPlacingRequest(null);
            if (target.kind === "return") {
                if (isPanelArea(movedArea)) {
                    // A panel returned into the hidden tab strip has no visible tab to focus.
                    pendingFocusRef.current = latestRef.current.hiddenAreas.has("topRight")
                        ? { kind: "grip", area: "bottomRight" }
                        : { kind: "tab", panel: movedArea };
                    onReturn(movedArea);
                } else if (isEngineArea(movedArea)) {
                    pendingFocusRef.current = { kind: "engineReturn", area: movedArea };
                    onReturnEngine(movedArea);
                }
            } else if (target.kind === "place") {
                pendingFocusRef.current = { kind: "grip", area: movedArea };
                onPlace(movedArea, target.target, target.side);
            }
        },
        [placingRequest, onPlace, onReturn, onReturnEngine],
    );

    return {
        dragPreview,
        placing,
        beginDrag,
        consumeSuppressedClick,
        startPlacing,
        applyPlacingTarget,
        scheduleEngineReturnFocus,
        cancelPlacing: useCallback(() => cancelArranging(true), [cancelArranging]),
    };
}
