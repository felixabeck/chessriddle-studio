/* Shared by both browsers; runs in the content script's isolated world. */
(() => {
  "use strict";

  const CHESS_HOSTS = new Set(["chess.com", "www.chess.com"]);
  const RESERVED = new Set([
    "analysis",
    "training",
    "practice",
    "insights",
    "features",
    "password",
    "streamer",
    "timeline",
    "patron",
    "signup",
    "account",
    "security",
  ]);

  function parseUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      return url;
    } catch {
      return null;
    }
  }

  // Return only URLs the desktop app accepts (link-contract.json; the parser is
  // src-tauri/src/infra/game_link.rs). Never forward query strings, fragments,
  // Lichess player secrets, or arbitrary page-provided URLs.
  function canonicalGameUrl(value, base) {
    const url = parseUrl(value, base);
    if (!url) return null;
    if (CHESS_HOSTS.has(url.hostname)) {
      const path = url.pathname.replace(/\/$/, "");
      const match =
        path.match(/^\/(?:analysis\/)?game\/(live|daily)\/([1-9]\d{0,19})(?:\/analysis)?$/) ||
        path.match(/^\/(live|daily)\/game\/([1-9]\d{0,19})$/) ||
        path.match(/^\/play\/(online|daily)\/game\/([1-9]\d{0,19})$/);
      if (match) {
        const type = match[1] === "online" ? "live" : match[1];
        return `https://www.chess.com/game/${type}/${match[2]}`;
      }
      if (/^\/(?:analysis(?:\/game)?|play\/(?:online|daily)|live)\/?$/.test(path)) {
        const ids = url.searchParams.getAll("gameId");
        if (ids.length === 1 && /^[1-9]\d{0,19}$/.test(ids[0])) {
          const type =
            path.includes("daily") || url.searchParams.get("gameType") === "daily"
              ? "daily"
              : "live";
          return `https://www.chess.com/game/${type}/${ids[0]}`;
        }
      }
    } else if (url.hostname === "lichess.org") {
      // Lichess serves a game at /game/<id> (observed 2026-11-22) and redirects the older
      // /<id> there; both name the same game.
      const match = url.pathname.match(
        /^\/(?:game\/)?([a-zA-Z0-9]{8})(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?$/,
      );
      if (match && !RESERVED.has(match[1])) return `https://lichess.org/${match[1]}`;
    }
    return null;
  }

  function deepLink(value) {
    const canonical = canonicalGameUrl(value);
    return canonical ? `chessriddle-studio://import?url=${encodeURIComponent(canonical)}` : null;
  }

  const selectors = {
    chess: {
      root: "#board-layout-main, .board-layout-main, .analysis-layout-main, #board-layout-sidebar, .board-layout-sidebar",
      // Chess.com's markup as observed on 2026-11-22 comes first in each list
      // (the "v6" end-of-game dialog, the review buttons in the sidebar, the
      // result row of the move list); the older names stay as fallbacks.
      complete:
        ".game-review-buttons-component, .game-over-modal-shell-content, .result-row .game-result, .game-over-modal-content, .game-over-modal, [data-cy='game-over-modal'], .game-over-component, .game-over-header-component, .game-controls-component .game-result, .game-controls-component .result-component",
      controls: [
        ".game-review-buttons-component",
        ".game-over-modal-shell-buttons",
        // The analysis page: the block under the move list. Appending to the
        // sidebar itself would push the link out of the sidebar's fixed height.
        ".game-controls-view-component",
        ".game-over-modal-content",
        "[data-cy='game-over-modal']",
        ".game-over-modal",
        ".game-over-component",
        ".review-buttons-component",
        ".analysis-controls-component",
        ".game-controls-component",
        ".board-layout-sidebar",
        "#board-layout-sidebar",
      ],
    },
    lichess: {
      root: ".round__app, main.analyse, .analyse__app",
      controls: [
        ".round__app .rcontrols",
        ".analyse__underboard .analyse__panel",
        ".analyse__underboard",
        ".analyse__tools",
      ],
    },
  };

  // Avoid injecting into hidden dialogs left behind during SPA transitions.
  function visible(element) {
    if (!element?.isConnected) return false;
    for (
      let node = element;
      node instanceof element.ownerDocument.defaultView.Element;
      node = node.parentElement
    ) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function firstVisible(document, selector) {
    return Array.from(document.querySelectorAll(selector)).find(visible) || null;
  }

  function getContext(document, href) {
    const page = parseUrl(href);
    if (!page) return null;
    const site = CHESS_HOSTS.has(page.hostname)
      ? "chess"
      : page.hostname === "lichess.org"
        ? "lichess"
        : null;
    if (!site) return null;
    const config = selectors[site];
    if (!firstVisible(document, config.root)) return null;
    let gameUrl = canonicalGameUrl(href);

    if (site === "lichess") {
      if (!gameUrl) return null;
      // The analysis app can also show an ongoing game. Require a rendered
      // terminal result, rather than assuming that analysis means completed.
      const result = firstVisible(
        document,
        ".round__app .result, main.analyse .result, .analyse__app .result, .game__meta .result",
      );
      const hasResult =
        result &&
        /^(?:1\s*[-–]\s*0|0\s*[-–]\s*1|[½]|1\/2\s*[-–]\s*1\/2)/.test(result.textContent.trim());
      if (!hasResult && !firstVisible(document, ".round__app .result-wrap")) return null;
    } else {
      const analysisRoute =
        /^\/analysis(?:\/game(?:\/(?:live|daily)\/\d+(?:\/analysis)?)?)?\/?$/.test(page.pathname);
      const historicalGame =
        /^\/game\/(?:live|daily)\/\d+(?:\/analysis)?\/?$/.test(page.pathname) &&
        firstVisible(
          document,
          ".game-review-buttons-component, .analysis-view-component, .analysis-layout-main, .analysis-controls-component, .review-buttons-component",
        );
      const historical = analysisRoute || historicalGame;
      const completion = firstVisible(document, config.complete);
      if (!historical && !completion) return null;
      // Chess.com's live SPA may keep /play/online in the address bar.
      // Only consult the current game UI, never archive cards or global links.
      if (!gameUrl && /^\/(?:play\/(?:online|daily)|live)\/?$/.test(page.pathname) && completion) {
        const candidates = new Set();
        for (const anchor of completion.querySelectorAll("a[href]")) {
          const candidate = canonicalGameUrl(anchor.getAttribute("href"), page.href);
          if (candidate?.startsWith("https://www.chess.com/")) candidates.add(candidate);
        }
        if (candidates.size === 1) gameUrl = candidates.values().next().value;
      }
      // Unsupported pages cannot borrow a game ID from unrelated page markup.
      if (!gameUrl) return null;
    }

    let target = null;
    for (const selector of config.controls) {
      target = firstVisible(document, selector);
      if (target) break;
    }
    return target ? { site, gameUrl, target } : null;
  }

  globalThis.ChessRiddleStudioExtension = Object.freeze({ canonicalGameUrl, deepLink, getContext });
})();
