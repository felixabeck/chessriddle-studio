import { type KeyboardEvent, type PointerEvent, useCallback, useRef, useState } from "react";
import { capturePointer, releasePointerCaptureSafely } from "@/utils/pointerCapture";

type Drag = {
    pointerId: number;
    startX: number;
    startSizePx: number;
    moved: boolean;
    lastSizeRem: number;
};

/**
 * Pointer and keyboard behaviour of one resize handle that changes a remembered size in rem along
 * the horizontal axis. The live drag value is local; the remembered value is written once, when
 * the drag ends, by a key press, or by a double-click reset.
 */
export function useDragResize({
    measuredSizePx,
    rootFont,
    normalize,
    growDirection,
    keyStepRem,
    setStoredRem,
    defaultRem,
}: {
    /** The rendered size in px; when it cannot be measured, the caller's effective size in px. */
    measuredSizePx: () => number;
    rootFont: number;
    /** Clamps and rounds a candidate size in rem. */
    normalize: (sizeRem: number) => number;
    /** 1 when dragging right grows the size, -1 when dragging left does. */
    growDirection: 1 | -1;
    keyStepRem: number;
    setStoredRem: (sizeRem: number) => void;
    defaultRem: number;
}) {
    const [dragRem, setDragRem] = useState<number | null>(null);
    const dragRef = useRef<Drag | null>(null);

    const sizeFromDelta = (startSizePx: number, deltaX: number) =>
        normalize((startSizePx + growDirection * deltaX) / rootFont);

    const finishDrag = (event: PointerEvent<HTMLElement>, useEventPosition: boolean) => {
        const current = dragRef.current;
        if (!current || current.pointerId !== event.pointerId) return;
        dragRef.current = null;
        releasePointerCaptureSafely(event.currentTarget, event.pointerId);
        if (useEventPosition) {
            const deltaX = event.clientX - current.startX;
            if (deltaX !== 0 || current.moved) {
                setStoredRem(sizeFromDelta(current.startSizePx, deltaX));
            }
        } else if (current.moved) {
            setStoredRem(current.lastSizeRem);
        }
        setDragRem(null);
    };

    const onDragInterrupted = (event: PointerEvent<HTMLElement>) => finishDrag(event, false);

    const cancel = useCallback(() => {
        dragRef.current = null;
        setDragRem(null);
    }, []);

    const handleProps = {
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
            if (event.button !== 0) return;
            event.preventDefault();
            if (!capturePointer(event.currentTarget, event.pointerId)) return;
            const startSizePx = measuredSizePx();
            const startSizeRem = normalize(startSizePx / rootFont);
            dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startSizePx,
                moved: false,
                lastSizeRem: startSizeRem,
            };
            setDragRem(startSizeRem);
        },
        onPointerMove: (event: PointerEvent<HTMLElement>) => {
            const current = dragRef.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - current.startX;
            if (deltaX !== 0) current.moved = true;
            const next = sizeFromDelta(current.startSizePx, deltaX);
            current.lastSizeRem = next;
            setDragRem(next);
        },
        onPointerUp: (event: PointerEvent<HTMLElement>) => finishDrag(event, true),
        onPointerCancel: onDragInterrupted,
        onLostPointerCapture: onDragInterrupted,
        onDoubleClick: () => {
            cancel();
            setStoredRem(defaultRem);
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            const sign = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (sign === 0) return;
            event.preventDefault();
            setStoredRem(
                normalize(measuredSizePx() / rootFont + sign * growDirection * keyStepRem),
            );
        },
    };

    return { dragRem, handleProps, cancel };
}
