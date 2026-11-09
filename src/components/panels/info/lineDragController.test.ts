import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PgnLineMove } from "@/bindings";
import type { GameSelectorRow } from "./GameSelector";
import { allowedLineDrop, attachLineDragController } from "./lineDragController";

const identity = { stamp: "s1", revision: "read-revision" };
const rows = new Map<number, GameSelectorRow>([
    [0, { name: "First", section: "First section", identity }],
    [1, { name: "Second", identity }],
    [2, { name: "Third", section: "Second section", identity }],
    [3, { name: "Fourth", identity }],
]);
const snapshot = () => ({ rows, total: 4, available: true });

test.each([
    ["above a heading", "line", 1, 2, false, true],
    ["below a heading", "line", 1, 2, true, true],
    ["below an ordinary line", "line", 0, 1, true, false],
    ["at the end", "line", 0, 4, false, true],
    ["below the end", "line", 0, 4, true, false],
    ["past the end", "line", 0, 5, false, false],
    ["a section before a heading", "section", 0, 2, false, true],
    ["a section below a heading", "section", 0, 2, true, false],
    ["a section inside itself", "section", 0, 1, false, false],
    ["a section at its own heading", "section", 0, 0, false, false],
    ["a section inside another section", "section", 0, 3, false, false],
    ["a section at the end", "section", 0, 4, false, true],
    ["a line without a heading as a section", "section", 1, 2, false, false],
] as const)(
    "allows only model destinations: %s",
    (_label, kind, source, before, belowHeading, allowed) => {
        expect(allowedLineDrop({ kind, source, before, belowHeading }, snapshot())).toBe(allowed);
    },
);

test("unloaded sources and destinations are refused", () => {
    const state = { ...snapshot(), rows: new Map(rows) };
    state.rows.delete(1);
    expect(
        allowedLineDrop({ kind: "line", source: 1, before: 2, belowHeading: false }, state),
    ).toBe(false);
    expect(
        allowedLineDrop({ kind: "line", source: 0, before: 1, belowHeading: false }, state),
    ).toBe(false);
    state.rows.set(1, { name: "Unreadable" });
    expect(
        allowedLineDrop({ kind: "line", source: 1, before: 2, belowHeading: false }, state),
    ).toBe(false);
});

let viewport: HTMLDivElement;
let list: HTMLDivElement;
let detach: () => void;
let move: ReturnType<typeof vi.fn<(movement: PgnLineMove, revision: string) => void>>;
let captured: number | undefined;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function bounds(top: number, height: number): DOMRect {
    return {
        x: 0,
        y: top,
        top,
        bottom: top + height,
        left: 0,
        right: 300,
        width: 300,
        height,
        toJSON: () => ({}),
    };
}

function pointer(target: EventTarget, type: string, x: number, y: number, extra = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true, configurable: true },
    });
    for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    viewport = document.createElement("div");
    list = document.createElement("div");
    viewport.append(list);
    document.body.append(viewport);
    viewport.getBoundingClientRect = () => bounds(0, 220);
    let top = 0;
    for (const [index, game] of rows) {
        const slot = document.createElement("div");
        slot.dataset.lineIndex = String(index);
        const slotTop = top;
        if (game.section !== undefined) {
            const heading = document.createElement("div");
            heading.dataset.linePart = "section";
            heading.textContent = game.section;
            heading.getBoundingClientRect = () => bounds(slotTop, 30);
            slot.append(heading);
            top += 30;
        }
        const rowTop = top;
        const row = document.createElement("div");
        row.dataset.linePart = "line";
        row.textContent = game.name;
        row.getBoundingClientRect = () => bounds(rowTop, 30);
        slot.append(row);
        top += 30;
        const height = top - slotTop;
        slot.getBoundingClientRect = () => bounds(slotTop, height);
        list.append(slot);
    }
    Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn((_x, y) => {
            for (const part of list.querySelectorAll<HTMLElement>("[data-line-part]")) {
                const rect = part.getBoundingClientRect();
                if (y >= rect.top && y < rect.bottom) return part;
            }
            return list;
        }),
    });
    captured = undefined;
    list.setPointerCapture = (id) => {
        captured = id;
    };
    list.hasPointerCapture = (id) => captured === id;
    list.releasePointerCapture = () => {
        captured = undefined;
    };
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    move = vi.fn();
    detach = attachLineDragController({ list, viewport, snapshot, move });
});

afterEach(() => {
    detach();
    viewport.remove();
    Reflect.deleteProperty(document, "elementFromPoint");
    vi.unstubAllGlobals();
});

const preview = () => document.querySelector<HTMLElement>("[data-line-drag-preview]");
const marker = () => document.querySelector<HTMLElement>("[data-line-drop-marker]");
const line = (index: number) =>
    list.querySelector<HTMLElement>(`[data-line-index="${index}"] [data-line-part="line"]`)!;

function begin() {
    pointer(line(1), "pointerdown", 40, 70);
    pointer(window, "pointermove", 50, 70);
}

test("threshold preserves click and a drag submits the source revision and suppresses its click", () => {
    pointer(line(1), "pointerdown", 40, 70);
    pointer(window, "pointermove", 42, 71);
    expect(preview()).toBeNull();
    pointer(window, "pointerup", 42, 71);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    line(1).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    begin();
    expect(captured).toBe(1);
    expect(preview()?.getAttribute("style")).toContain("height: 30px");
    pointer(window, "pointerup", 50, 115);
    expect(move).toHaveBeenCalledExactlyOnceWith(
        { kind: "line", source: 1, before: 2, belowHeading: true },
        "read-revision",
    );
    expect(preview()).toBeNull();
    expect(frames.size).toBe(0);
    const afterDrag = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    line(1).dispatchEvent(afterDrag);
    expect(afterDrag.defaultPrevented).toBe(true);
    pointer(line(1), "pointerdown", 40, 70);
    pointer(window, "pointerup", 40, 70);
    const nextClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    line(1).dispatchEvent(nextClick);
    expect(nextClick.defaultPrevented).toBe(false);
});

test.each([
    ["secondary button", { button: 2 }],
    ["non-primary pointer", { isPrimary: false }],
])("%s cannot start a drag", (_label, extra) => {
    pointer(line(1), "pointerdown", 40, 70, extra);
    pointer(window, "pointermove", 50, 70);
    expect(preview()).toBeNull();
});

test("a nested element inside a button cannot start a drag", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    line(1).append(button);
    pointer(icon, "pointerdown", 40, 70);
    pointer(window, "pointermove", 50, 70);
    expect(preview()).toBeNull();
});

test.each(["Escape", "pointercancel", "lostpointercapture", "blur", "detach"])(
    "%s releases the preview, capture, frame and listeners without moving",
    (reason) => {
        begin();
        expect(preview()).not.toBeNull();
        if (reason === "Escape")
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        else if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else if (reason === "detach") detach();
        else pointer(reason === "lostpointercapture" ? list : window, reason, 50, 70);
        expect(preview()).toBeNull();
        expect(marker()).toBeNull();
        expect(captured).toBeUndefined();
        expect(frames.size).toBe(0);
        pointer(window, "pointermove", 50, 115);
        pointer(window, "pointerup", 50, 115);
        expect(move).not.toHaveBeenCalled();
    },
);

test("a stationary pointer scrolls, recomputes the destination and survives source unmount", () => {
    begin();
    pointer(window, "pointermove", 50, 210);
    line(1).parentElement!.remove();
    const frame = [...frames.entries()][0];
    frames.delete(frame[0]);
    frame[1](16);
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(marker()?.hidden).toBe(false);
    pointer(window, "pointerup", 50, 210);
    expect(move).toHaveBeenCalledWith(
        { kind: "line", source: 1, before: 4, belowHeading: false },
        "read-revision",
    );
});

test("a section has no marker inside a section and an outside drop does nothing", () => {
    const heading = list.querySelector<HTMLElement>('[data-line-part="section"]')!;
    pointer(heading, "pointerdown", 40, 10);
    pointer(window, "pointermove", 50, 70);
    expect(preview()?.textContent).toBe("First section");
    expect(marker()?.hidden).toBe(true);
    pointer(window, "pointermove", 50, 95);
    expect(marker()?.hidden).toBe(false);
    expect(marker()?.dataset.before).toBe("2");
    pointer(window, "pointerup", 350, 95);
    expect(move).not.toHaveBeenCalled();
});
