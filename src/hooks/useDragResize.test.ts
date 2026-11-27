import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type DragResizeAxis, useDragResize } from "./useDragResize";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

type ProbeProps = {
    axis?: DragResizeAxis;
    growDirection?: 1 | -1;
    initialPx?: number;
    minRem?: number;
    maxRem?: number;
    defaultRem?: number;
    keyStepRem?: number;
    disabled?: boolean;
    onStored: (rem: number) => void;
};

function Probe({
    axis = "horizontal",
    growDirection = 1,
    initialPx = 224,
    minRem = 6,
    maxRem = 30,
    defaultRem = 14,
    keyStepRem = 1,
    disabled = false,
    onStored,
}: ProbeProps) {
    const sizePxRef = useRef(initialPx);
    const { dragRem, handleProps } = useDragResize({
        axis,
        measuredSizePx: () => sizePxRef.current,
        rootFont: 16,
        normalize: (rem) => Math.round(Math.min(maxRem, Math.max(minRem, rem)) * 100) / 100,
        growDirection,
        keyStepRem,
        setStoredRem: (rem) => {
            sizePxRef.current = rem * 16;
            onStored(rem);
        },
        defaultRem,
        disabled,
    });
    return createElement("div", {
        role: "separator",
        tabIndex: 0,
        "data-drag-rem": dragRem ?? "",
        ...handleProps,
    });
}

function separator() {
    return host.querySelector<HTMLElement>('[role="separator"]')!;
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

async function renderProbe(props: ProbeProps) {
    await act(async () => root.render(createElement(Probe, props)));
}

function dispatchPointer(
    target: HTMLElement,
    type: "pointerdown" | "pointermove" | "pointerup",
    coords: { clientX?: number; clientY?: number },
) {
    const EventCtor = globalThis.PointerEvent ?? MouseEvent;
    const event = new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: coords.clientX ?? 0,
        clientY: coords.clientY ?? 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
}

describe("useDragResize", () => {
    test("horizontal axis keeps pointer drag, ArrowLeft/Right and double-click behaviour", async () => {
        const stored: number[] = [];
        await renderProbe({
            axis: "horizontal",
            growDirection: -1,
            initialPx: 384,
            minRem: 20,
            maxRem: 40,
            defaultRem: 24,
            keyStepRem: 1.5,
            onStored: (rem) => stored.push(rem),
        });

        const handle = separator();
        await act(async () => {
            dispatchPointer(handle, "pointerdown", { clientX: 500 });
            dispatchPointer(handle, "pointermove", { clientX: 468 });
        });
        expect(handle.dataset.dragRem).toBe("26");
        expect(stored).toEqual([]);

        await act(async () => {
            dispatchPointer(handle, "pointerup", { clientX: 468 });
        });
        expect(handle.dataset.dragRem).toBe("");
        expect(stored).toEqual([26]);

        await act(async () => {
            handle.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
            );
        });
        expect(stored).toEqual([26, 24.5]);

        await act(async () => {
            handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        expect(stored).toEqual([26, 24.5, 24]);
    });

    test("vertical axis drags on clientY, steps on ArrowUp/ArrowDown and resets on double-click", async () => {
        const stored: number[] = [];
        await renderProbe({
            axis: "vertical",
            growDirection: 1,
            initialPx: 224,
            minRem: 6,
            maxRem: 25,
            defaultRem: 14,
            keyStepRem: 1,
            onStored: (rem) => stored.push(rem),
        });

        const handle = separator();
        await act(async () => {
            dispatchPointer(handle, "pointerdown", { clientY: 200 });
            dispatchPointer(handle, "pointermove", { clientY: 248 });
        });
        expect(handle.dataset.dragRem).toBe("17");
        expect(stored).toEqual([]);

        await act(async () => {
            dispatchPointer(handle, "pointerup", { clientY: 248 });
        });
        expect(handle.dataset.dragRem).toBe("");
        expect(stored).toEqual([17]);

        await act(async () => {
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        });
        expect(stored).toEqual([17, 16, 15, 16]);

        // Horizontal arrows do nothing on the vertical axis.
        await act(async () => {
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        });
        expect(stored).toEqual([17, 16, 15, 16]);

        await act(async () => {
            handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        expect(stored).toEqual([17, 16, 15, 16, 14]);
    });

    test("collapsed range (disabled) writes nothing on drag, arrow keys or double-click", async () => {
        const onStored = vi.fn();
        await renderProbe({
            axis: "vertical",
            disabled: true,
            onStored,
        });

        const handle = separator();
        await act(async () => {
            dispatchPointer(handle, "pointerdown", { clientY: 100 });
            dispatchPointer(handle, "pointermove", { clientY: 148 });
            dispatchPointer(handle, "pointerup", { clientY: 148 });
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });

        expect(handle.dataset.dragRem).toBe("");
        expect(onStored).not.toHaveBeenCalled();
    });

    test("switching disabled to true mid-drag cancels the drag and writes nothing on pointerup", async () => {
        const onStored = vi.fn();
        await renderProbe({
            axis: "vertical",
            disabled: false,
            onStored,
        });

        const handle = separator();
        await act(async () => {
            dispatchPointer(handle, "pointerdown", { clientY: 100 });
            dispatchPointer(handle, "pointermove", { clientY: 148 });
        });
        expect(handle.dataset.dragRem).toBe("17");

        await renderProbe({
            axis: "vertical",
            disabled: true,
            onStored,
        });
        expect(handle.dataset.dragRem).toBe("");

        await act(async () => {
            dispatchPointer(handle, "pointermove", { clientY: 164 });
            dispatchPointer(handle, "pointerup", { clientY: 164 });
        });
        expect(onStored).not.toHaveBeenCalled();
    });
});
