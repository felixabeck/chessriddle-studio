export const ANALYSIS_PANEL_SCROLL_EVENT = "analysis-panel-scroll";

/** Notifies open engine-line hover previews to reposition after their scroll container scrolls. */
export function notifyAnalysisPanelScroll(): void {
    document.dispatchEvent(new Event(ANALYSIS_PANEL_SCROLL_EVENT));
}
