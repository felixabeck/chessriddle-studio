/** Text of a subtree as assistive technology reads it: aria-hidden subtrees are skipped. */
export function accessibleText(node: Element | null | undefined): string {
    if (!node) return "";
    let text = "";
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent ?? "";
        } else if (child instanceof Element && child.getAttribute("aria-hidden") !== "true") {
            text += accessibleText(child);
        }
    }
    return text;
}
