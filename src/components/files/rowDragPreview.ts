import type { DragEvent } from "react";

// A fully transparent 1x1 GIF. WebKitGTK paints the native drag image at the device pixel density
// without telling GTK, so on a 2x display the row appeared at twice its size. No element passed to
// setDragImage escapes that path, so the native image is hidden and the page draws the preview.
const TRANSPARENT_IMAGE =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let transparentImage: HTMLImageElement | null = null;
let endActivePreview: (() => void) | null = null;

/** setDragImage ignores an image that has not decoded, so this runs before the first drag. */
export function preloadRowDragImage(): HTMLImageElement {
    if (!transparentImage) {
        transparentImage = new Image();
        transparentImage.src = TRANSPARENT_IMAGE;
    }
    return transparentImage;
}

/** Ends the one preview a drag can own. Also the owner's cleanup when the list unmounts. */
export function endRowDragPreview(): void {
    endActivePreview?.();
}

/**
 * Draws a copy of the row at its exact size under the pointer until the drag ends.
 * `containerClassName` recreates the row's container, whose width and variables lay out the row.
 */
export function startRowDragPreview(
    event: DragEvent<HTMLElement>,
    containerClassName: string,
    previewClassName: string,
): void {
    endRowDragPreview();
    const row = event.currentTarget;
    const bounds = row.getBoundingClientRect();
    const grabX = event.clientX - bounds.left;
    const grabY = event.clientY - bounds.top;
    event.dataTransfer.setDragImage(preloadRowDragImage(), 0, 0);

    const preview = document.createElement("div");
    preview.className = `${containerClassName} ${previewClassName}`;
    preview.style.width = `${bounds.width}px`;
    preview.setAttribute("aria-hidden", "true");
    preview.setAttribute("inert", "");
    preview.append(row.cloneNode(true));
    const place = (clientX: number, clientY: number) => {
        preview.style.transform = `translate(${clientX - grabX}px, ${clientY - grabY}px)`;
    };
    place(event.clientX, event.clientY);
    document.body.append(preview);

    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    const end = () => {
        listeners.abort();
        preview.remove();
        endActivePreview = null;
    };
    document.addEventListener(
        "dragover",
        (moved) => {
            // A drag leaving the window can report the origin. Keep the last real position.
            if (moved.clientX !== 0 || moved.clientY !== 0) place(moved.clientX, moved.clientY);
        },
        options,
    );
    // Both, because a completed move can remove the source row before its dragend would reach here.
    document.addEventListener("drop", end, options);
    document.addEventListener("dragend", end, options);
    endActivePreview = end;
}
