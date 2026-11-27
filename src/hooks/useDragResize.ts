import {
    type KeyboardEvent,
    type PointerEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { capturePointer, releasePointerCaptureSafely } from "@/utils/pointerCapture";

export type DragResizeAxis = "horizontal" | "vertical";

type Drag = {
    pointerId: number;
    startPos: number;
    startSizePx: number;
    moved: boolean;
    lastSizeRem: number;
};

/**
 * Pointer and keyboard behaviour of one resize handle that changes a remembered size in rem along
 * either axis (horizontal by default). The live drag value is local; the remembered value is
 * written once, when the drag ends, by a key press, or by a double-click reset.
 */
export function useDragResize({
    axis = "horizontal",
    measuredSizePx,
    rootFont,
    normalize,
    growDirection,
    keyStepRem,
    setStoredRem,
    defaultRem,
    disabled = false,
}: {
    axis?: DragResizeAxis;
    /** The rendered size in px; when it cannot be measured, the caller's effective size in px. */
    measuredSizePx: () => number;
    rootFont: number;
    /** Clamps and rounds a candidate size in rem. */
    normalize: (sizeRem: number) => number;
    /** 1 when dragging along +X/+Y grows the size, -1 when dragging along -X/-Y does. */
    growDirection: 1 | -1;
    keyStepRem: number;
    setStoredRem: (sizeRem: number) => void;
    defaultRem: number;
    /** When true, drag, arrow keys and double-click are ignored and write nothing. */
    disabled?: boolean;
}) {
    const [dragRem, setDragRem] = useState<number | null>(null);
    const dragRef = useRef<Drag | null>(null);

    const pointerCoord = (event: PointerEvent<HTMLElement>) =>
        axis === "vertical" ? event.clientY : event.clientX;

    const sizeFromDelta = (startSizePx: number, deltaPx: number) =>
        normalize((startSizePx + growDirection * deltaPx) / rootFont);

    const finishDrag = (event: PointerEvent<HTMLElement>, useEventPosition: boolean) => {
        const current = dragRef.current;
        if (!current || current.pointerId !== event.pointerId) return;
        dragRef.current = null;
        releasePointerCaptureSafely(event.currentTarget, event.pointerId);
        if (!disabled) {
            if (useEventPosition) {
                const deltaPx = pointerCoord(event) - current.startPos;
                if (deltaPx !== 0 || current.moved) {
                    setStoredRem(sizeFromDelta(current.startSizePx, deltaPx));
                }
            } else if (current.moved) {
                setStoredRem(current.lastSizeRem);
            }
        }
        setDragRem(null);
    };

    const onDragInterrupted = (event: PointerEvent<HTMLElement>) => finishDrag(event, false);

    const cancel = useCallback(() => {
        dragRef.current = null;
        setDragRem(null);
    }, []);

    useEffect(() => {
        if (disabled) cancel();
    }, [disabled, cancel]);

    const handleProps = {
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
            if (disabled || event.button !== 0 || !(rootFont > 0)) return;
            event.preventDefault();
            if (!capturePointer(event.currentTarget, event.pointerId)) return;
            const startSizePx = measuredSizePx();
            const startSizeRem = normalize(startSizePx / rootFont);
            dragRef.current = {
                pointerId: event.pointerId,
                startPos: pointerCoord(event),
                startSizePx,
                moved: false,
                lastSizeRem: startSizeRem,
            };
            setDragRem(startSizeRem);
        },
        onPointerMove: (event: PointerEvent<HTMLElement>) => {
            const current = dragRef.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const deltaPx = pointerCoord(event) - current.startPos;
            if (deltaPx !== 0) current.moved = true;
            const next = sizeFromDelta(current.startSizePx, deltaPx);
            current.lastSizeRem = next;
            setDragRem(next);
        },
        onPointerUp: (event: PointerEvent<HTMLElement>) => finishDrag(event, true),
        onPointerCancel: onDragInterrupted,
        onLostPointerCapture: onDragInterrupted,
        onDoubleClick: () => {
            if (disabled) return;
            cancel();
            setStoredRem(defaultRem);
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (disabled || !(rootFont > 0)) return;
            const sign =
                axis === "vertical"
                    ? event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowUp"
                          ? -1
                          : 0
                    : event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : 0;
            if (sign === 0) return;
            event.preventDefault();
            setStoredRem(
                normalize(measuredSizePx() / rootFont + sign * growDirection * keyStepRem),
            );
        },
    };

    return { dragRem, handleProps, cancel };
}
