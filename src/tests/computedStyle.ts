// jsdom computes every CSS property on each getComputedStyle call. Mantine's layout hooks
// (floating indicator, ScrollArea scrollbars, floating-ui dropdown positioning) call it on each
// render for layout values jsdom cannot produce. Vitest applies no component stylesheets, so this
// returns the inline style, all jsdom knows here. Use only in suites asserting nothing about
// cascaded styles. Measured cost (f-20261109-08): 1.2 s of a 1.5 s DatabasePanel test under coverage.
export function installInlineComputedStyleStub() {
    Object.defineProperty(window, "getComputedStyle", {
        writable: true,
        value: (element: Element): CSSStyleDeclaration => (element as HTMLElement).style,
    });
}
