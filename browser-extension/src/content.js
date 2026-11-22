(() => {
  "use strict";
  const key = "__chessRiddleStudioContentScript";
  if (globalThis[key]) return;
  const { getContext, deepLink } = globalThis.ChessRiddleStudioExtension;
  const label = "Analyze in ChessRiddle Studio";
  // Resolved once at start: after an extension update the old script keeps
  // running in the page, and the runtime then refuses every further call.
  const markUrl = chrome.runtime.getURL("icons/48.png");
  let button = null;
  let timer = null;
  let interval = null;
  let observer = null;
  let running = false;

  function removeButton() {
    button?.remove();
    button = null;
  }

  function reconcile() {
    timer = null;
    const context = getContext(document, location.href);
    if (!context) {
      removeButton();
      return;
    }
    if (!button) {
      button = document.createElement("a");
      button.dataset.chessriddleStudio = "analyze";
      const mark = document.createElement("img");
      mark.className = "crs-analyze__mark";
      mark.alt = "";
      mark.draggable = false;
      // The label alone is a complete button, so an image the page cannot
      // load leaves no broken-image placeholder behind.
      mark.addEventListener("error", () => mark.remove());
      mark.src = markUrl;
      button.append(mark, label);
      button.title = "Open this game in the ChessRiddle Studio desktop app (installation required)";
      button.setAttribute("aria-label", label);
      // A real link preserves keyboard access and the browser's user gesture
      // for external-protocol prompts. Revalidate synchronously on activation
      // so a SPA cannot launch the previous game's stale URL.
      const activate = (event) => {
        const current = getContext(document, location.href);
        if (!current || !event.isTrusted) {
          event.preventDefault();
          if (!current) reconcile();
          return;
        }
        button.href = deepLink(current.gameUrl);
        event.stopPropagation();
      };
      button.addEventListener("click", activate);
      button.addEventListener("auxclick", activate);
    }
    // No class of the host: its button classes bring state rules (hover text
    // colour, hover fill) that this extension cannot keep in step with.
    const className = `crs-analyze crs-analyze--${context.site === "lichess" ? "lichess" : "chess"}`;
    if (button.className !== className) button.className = className;
    const href = deepLink(context.gameUrl);
    if (button.getAttribute("href") !== href) button.setAttribute("href", href);
    if (button.parentElement !== context.target) context.target.append(button);
  }

  function schedule() {
    if (running && timer === null) timer = setTimeout(reconcile, 100);
  }

  function start() {
    if (running) return;
    running = true;
    observer = new MutationObserver((records) => {
      if (records.some((record) => !button?.contains(record.target))) schedule();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-hidden", "href", "style"],
    });
    // pushState/replaceState do not emit popstate, and page history lives in
    // another JS world. A small fallback poll covers URL-only SPA navigation.
    interval = setInterval(() => {
      if (!document.hidden) schedule();
    }, 1000);
    reconcile();
  }

  function stop() {
    running = false;
    observer?.disconnect();
    clearInterval(interval);
    clearTimeout(timer);
    timer = null;
    removeButton();
  }

  addEventListener("popstate", schedule);
  addEventListener("hashchange", schedule);
  addEventListener("pagehide", stop);
  addEventListener("pageshow", start);
  document.addEventListener("visibilitychange", schedule);
  globalThis[key] = { stop };
  start();
})();
