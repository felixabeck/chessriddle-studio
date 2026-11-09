import type { DragEvent } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { endRowDragPreview, preloadRowDragImage, startRowDragPreview } from "./rowDragPreview";

function start() {
    const row = document.createElement("div");
    row.textContent = "Weiß_Bird";
    row.setAttribute("role", "treeitem");
    row.getBoundingClientRect = () => ({ left: 100, top: 200, width: 935, height: 44 }) as DOMRect;
    document.body.append(row);
    const setDragImage = vi.fn();
    startRowDragPreview(
        {
            currentTarget: row,
            clientX: 110,
            clientY: 220,
            dataTransfer: { setDragImage },
        } as unknown as DragEvent<HTMLElement>,
        "tree",
        "preview",
    );
    return { row, setDragImage };
}

const preview = () => document.body.querySelector<HTMLElement>(".preview");

function dragEvent(type: string, clientX = 0, clientY = 0) {
    document.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
}

afterEach(() => {
    endRowDragPreview();
    document.body.replaceChildren();
});

describe("row drag preview", () => {
    test("hides the native image, which WebKitGTK would paint at device-pixel size", () => {
        const { setDragImage } = start();
        expect(setDragImage).toHaveBeenCalledExactlyOnceWith(preloadRowDragImage(), 0, 0);
        expect(preloadRowDragImage().src).toMatch(/^data:image\/gif/);
    });

    test("draws a copy at the row's width, inside the row's container, under the grab point", () => {
        start();
        const element = preview()!;
        expect(element.style.width).toBe("935px");
        expect(element.classList.contains("tree")).toBe(true);
        expect(element.textContent).toBe("Weiß_Bird");
        expect(element.style.transform).toBe("translate(100px, 200px)");
        expect(element.getAttribute("aria-hidden")).toBe("true");
        expect(element.hasAttribute("inert")).toBe(true);
    });

    test("follows the pointer and keeps the last position at the window-edge origin", () => {
        start();
        dragEvent("dragover", 310, 420);
        expect(preview()!.style.transform).toBe("translate(300px, 400px)");
        dragEvent("dragover", 0, 0);
        expect(preview()!.style.transform).toBe("translate(300px, 400px)");
    });

    test.each(["drop", "dragend"])("%s removes the preview and stops tracking", (type) => {
        start();
        const element = preview()!;
        dragEvent(type);
        expect(preview()).toBeNull();
        dragEvent("dragover", 500, 500);
        expect(element.style.transform).toBe("translate(100px, 200px)");
    });

    test("the list's cleanup removes a preview still in flight", () => {
        start();
        endRowDragPreview();
        expect(preview()).toBeNull();
    });

    test("a new drag replaces a preview whose end event never arrived", () => {
        start();
        start();
        expect(document.body.querySelectorAll(".preview")).toHaveLength(1);
    });
});
