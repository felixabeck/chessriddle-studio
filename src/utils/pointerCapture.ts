/**
 * Captures `pointerId` on `element`, failing closed when the browser rejects capture (e.g.
 * `NotFoundError` for an inactive pointer or `InvalidStateError` for a disconnected element).
 * Returns `true` when capture succeeds or the environment does not implement pointer capture.
 */
export function capturePointer(element: HTMLElement, pointerId: number): boolean {
    if (typeof element.setPointerCapture !== "function") return true;
    try {
        element.setPointerCapture(pointerId);
        return true;
    } catch {
        return false;
    }
}

/** Releases pointer capture if still held, swallowing errors when already released. */
export function releasePointerCaptureSafely(element: HTMLElement, pointerId: number): void {
    try {
        if (typeof element.hasPointerCapture === "function") {
            if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
        } else if (typeof element.releasePointerCapture === "function") {
            element.releasePointerCapture(pointerId);
        }
    } catch {
        // Pointer capture may already have been released by the browser.
    }
}
