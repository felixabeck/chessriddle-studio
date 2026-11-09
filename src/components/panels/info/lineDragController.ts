import type { PgnLineMove } from "@/bindings";
import type { GameSelectorRow } from "./GameSelector";
import classes from "./GameSelector.module.css";

const MAX_AUTOSCROLL_FRAME_MS = 32;
const INITIAL_AUTOSCROLL_FRAME_MS = 16;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_EDGE_VIEWPORT_FRACTION = 0.25;
const MAX_AUTOSCROLL_SPEED_PX_PER_MS = 0.6;
const DRAG_ACTIVATION_DISTANCE_PX = 6;

type ListSnapshot = {
    rows: ReadonlyMap<number, GameSelectorRow>;
    total: number;
    available: boolean;
};

export function allowedLineDrop(movement: PgnLineMove, { rows, total }: ListSnapshot): boolean {
    const { kind, source, before, belowHeading } = movement;
    if (source < 0 || source >= total || before < 0 || before > total) return false;
    if (!rows.get(source)?.identity) return false;
    const destination = rows.get(before);
    if (before < total && !destination?.identity) return false;
    if (belowHeading && destination?.section === undefined) return false;
    if (kind === "section") {
        return (
            rows.get(source)?.section !== undefined &&
            !belowHeading &&
            before !== source &&
            (before === total || destination?.section !== undefined)
        );
    }
    return true;
}

export function attachLineDragController({
    list,
    viewport,
    snapshot,
    move,
}: {
    list: HTMLElement;
    viewport: HTMLElement;
    snapshot: () => ListSnapshot;
    move: (movement: PgnLineMove, revision: string) => void;
}): () => void {
    type Session = {
        pointerId: number;
        movement: PgnLineMove;
        revision: string;
        startX: number;
        startY: number;
        x: number;
        y: number;
        offsetX: number;
        offsetY: number;
        preview: HTMLElement;
        marker: HTMLElement;
        active: boolean;
        frame: number | undefined;
        lastFrame: number | undefined;
        destination: PgnLineMove | undefined;
        listeners: AbortController;
    };
    let session: Session | undefined;
    let suppressClick = false;

    const cancel = () => {
        const previous = session;
        session = undefined;
        if (!previous) return;
        previous.listeners.abort();
        if (previous.frame !== undefined) cancelAnimationFrame(previous.frame);
        previous.preview.remove();
        previous.marker.remove();
        document.body.classList.remove(classes.dragging);
        if (list.hasPointerCapture(previous.pointerId))
            list.releasePointerCapture(previous.pointerId);
    };

    const update = (current: Session) => {
        current.preview.style.left = `${current.x - current.offsetX}px`;
        current.preview.style.top = `${current.y - current.offsetY}px`;
        current.destination = undefined;
        current.marker.hidden = true;
        const bounds = viewport.getBoundingClientRect();
        if (
            current.x < bounds.left ||
            current.x >= bounds.right ||
            current.y < bounds.top ||
            current.y >= bounds.bottom
        )
            return;
        const hit = document.elementFromPoint(current.x, current.y);
        if (!hit || !viewport.contains(hit)) return;
        const slot = hit.closest<HTMLElement>("[data-line-index]");
        const state = snapshot();
        if (!state.available) return;
        let before: number;
        let belowHeading = false;
        let top: number;
        if (slot && list.contains(slot)) {
            const index = Number(slot.dataset.lineIndex);
            if (!state.rows.get(index)?.identity) return;
            const row = slot.querySelector<HTMLElement>('[data-line-part="line"]')!;
            const rowBounds = row.getBoundingClientRect();
            const slotBounds = slot.getBoundingClientRect();
            if (current.y < rowBounds.top) {
                before = index;
                belowHeading = current.y >= (slotBounds.top + rowBounds.top) / 2;
                top = belowHeading ? rowBounds.top : slotBounds.top;
            } else if (current.y < rowBounds.top + rowBounds.height / 2) {
                before = index;
                belowHeading = state.rows.get(index)?.section !== undefined;
                top = rowBounds.top;
            } else {
                before = index + 1;
                top = rowBounds.bottom;
            }
        } else {
            const last = list.querySelector<HTMLElement>(`[data-line-index="${state.total - 1}"]`);
            if (!last || current.y < last.getBoundingClientRect().bottom) return;
            before = state.total;
            top = last.getBoundingClientRect().bottom;
        }
        const destination = { ...current.movement, before, belowHeading };
        if (!allowedLineDrop(destination, state)) return;
        current.destination = destination;
        Object.assign(current.marker.style, {
            left: `${bounds.left}px`,
            top: `${top - 1}px`,
            width: `${bounds.width}px`,
        });
        current.marker.dataset.before = String(before);
        current.marker.dataset.belowHeading = String(belowHeading);
        current.marker.hidden = false;
    };

    const tick = (current: Session, now: number) => {
        if (session !== current || !current.active) return;
        const elapsed = Math.min(
            MAX_AUTOSCROLL_FRAME_MS,
            current.lastFrame === undefined ? INITIAL_AUTOSCROLL_FRAME_MS : now - current.lastFrame,
        );
        current.lastFrame = now;
        const bounds = viewport.getBoundingClientRect();
        const edge = Math.min(
            AUTOSCROLL_EDGE_PX,
            bounds.height * AUTOSCROLL_EDGE_VIEWPORT_FRACTION,
        );
        if (
            current.x >= bounds.left &&
            current.x < bounds.right &&
            current.y >= bounds.top &&
            current.y < bounds.bottom &&
            edge > 0
        ) {
            const velocity =
                current.y < bounds.top + edge
                    ? -Math.min(1, (bounds.top + edge - current.y) / edge)
                    : current.y > bounds.bottom - edge
                      ? Math.min(1, (current.y - bounds.bottom + edge) / edge)
                      : 0;
            viewport.scrollTop += velocity * elapsed * MAX_AUTOSCROLL_SPEED_PX_PER_MS;
        }
        update(current);
        current.frame = requestAnimationFrame((time) => tick(current, time));
    };

    const down = (event: PointerEvent) => {
        if (session || event.button !== 0 || !event.isPrimary) return;
        suppressClick = false;
        const target = event.target;
        if (!(target instanceof Element) || target.closest("button")) return;
        const part = target.closest<HTMLElement>("[data-line-part]");
        const slot = part?.closest<HTMLElement>("[data-line-index]");
        const state = snapshot();
        if (!part || !slot || !list.contains(slot) || !state.available) return;
        const source = Number(slot.dataset.lineIndex);
        const row = state.rows.get(source);
        if (!row?.identity) return;
        const bounds = part.getBoundingClientRect();
        const rowBounds = slot
            .querySelector<HTMLElement>('[data-line-part="line"]')!
            .getBoundingClientRect();
        const preview = part.cloneNode(true) as HTMLElement;
        preview.classList.add(classes.dragPreview);
        preview.dataset.lineDragPreview = "";
        preview.setAttribute("aria-hidden", "true");
        preview.inert = true;
        preview.removeAttribute("role");
        preview.removeAttribute("tabindex");
        Object.assign(preview.style, {
            width: `${rowBounds.width}px`,
            height: `${rowBounds.height}px`,
        });
        const marker = document.createElement("div");
        marker.className = classes.dropMarker;
        marker.dataset.lineDropMarker = "";
        marker.setAttribute("aria-hidden", "true");
        marker.hidden = true;
        const current: Session = {
            pointerId: event.pointerId,
            movement: {
                kind: part.dataset.linePart === "section" ? "section" : "line",
                source,
                before: source,
                belowHeading: false,
            },
            revision: row.identity.revision,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            offsetX: event.clientX - bounds.left,
            offsetY: event.clientY - bounds.top,
            preview,
            marker,
            active: false,
            frame: undefined,
            lastFrame: undefined,
            destination: undefined,
            listeners: new AbortController(),
        };
        session = current;
        const options = { signal: current.listeners.signal };
        window.addEventListener(
            "pointermove",
            (next) => {
                if (next.pointerId !== current.pointerId) return;
                current.x = next.clientX;
                current.y = next.clientY;
                if (!current.active) {
                    if (
                        Math.hypot(current.x - current.startX, current.y - current.startY) <
                        DRAG_ACTIVATION_DISTANCE_PX
                    )
                        return;
                    try {
                        list.setPointerCapture(current.pointerId);
                    } catch {
                        cancel();
                        return;
                    }
                    current.active = true;
                    suppressClick = true;
                    document.body.classList.add(classes.dragging);
                    window.getSelection()?.removeAllRanges();
                    document.body.append(preview, marker);
                    current.frame = requestAnimationFrame((time) => tick(current, time));
                }
                next.preventDefault();
                update(current);
            },
            { ...options, passive: false },
        );
        window.addEventListener(
            "pointerup",
            (next) => {
                if (next.pointerId !== current.pointerId) return;
                current.x = next.clientX;
                current.y = next.clientY;
                if (current.active) update(current);
                const destination = current.active ? current.destination : undefined;
                cancel();
                if (destination) move(destination, current.revision);
            },
            options,
        );
        window.addEventListener(
            "pointercancel",
            (next) => {
                if (next.pointerId === current.pointerId) cancel();
            },
            options,
        );
        list.addEventListener(
            "lostpointercapture",
            (next) => {
                if (next.pointerId === current.pointerId) cancel();
            },
            options,
        );
        window.addEventListener("blur", cancel, options);
        window.addEventListener(
            "keydown",
            (next) => {
                if (next.key === "Escape") {
                    next.preventDefault();
                    cancel();
                }
            },
            options,
        );
    };
    const click = (event: MouseEvent) => {
        if (!suppressClick || event.detail === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const nativeDrag = (event: DragEvent) => {
        if (session) event.preventDefault();
    };
    list.addEventListener("pointerdown", down);
    list.addEventListener("click", click, true);
    list.addEventListener("dblclick", click, true);
    list.addEventListener("dragstart", nativeDrag);
    return () => {
        cancel();
        list.removeEventListener("pointerdown", down);
        list.removeEventListener("click", click, true);
        list.removeEventListener("dblclick", click, true);
        list.removeEventListener("dragstart", nativeDrag);
    };
}
