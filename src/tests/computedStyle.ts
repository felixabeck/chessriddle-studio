// jsdom computes every CSS property on each getComputedStyle call. Mantine's floating indicator,
// ScrollArea scrollbars and floating-ui dropdown positioning call it on each render for layout
// values jsdom cannot produce. This stub returns only the element's inline style, deliberately
// dropping jsdom's default stylesheet and inherited values. Install it only in suites where no
// assertion reads a computed style (toBeVisible and toHaveStyle do). Measured under coverage:
// 1.2 s of a 1.5 s DatabasePanel test (f-20261109-08), 0.55 s of a 0.9 s SettingsPage test and
// about 0.16 s per Puzzles render test (f-20261115-27).
export function installInlineComputedStyleStub() {
    Object.defineProperty(window, "getComputedStyle", {
        writable: true,
        value: (element: Element): CSSStyleDeclaration => (element as HTMLElement).style,
    });
}
