import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const core = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/content.css", import.meta.url), "utf8");
const dom = new JSDOM("", { runScripts: "outside-only" });
dom.window.eval(core);
const { canonicalGameUrl, deepLink } = dom.window.ChessRiddleStudioExtension;
const chess = "https://www.chess.com/game/live/123456789";
const lichess = "https://lichess.org/Ab12Cd34";

for (const input of [
  chess,
  "https://chess.com/analysis/game/live/123456789?tab=review#42",
  "https://www.chess.com/live/game/123456789",
  "https://www.chess.com/play/online/game/123456789",
  "https://www.chess.com/play/online?gameId=123456789",
  "https://www.chess.com/analysis?gameId=123456789",
])
  test(`canonical Chess.com URL: ${input}`, () => assert.equal(canonicalGameUrl(input), chess));

// Lichess serves a game at /game/<id> since 2026 and redirects the older /<id> there.
const lichessGame = "https://lichess.org/game/Ab12Cd34";

for (const input of [
  lichess,
  `${lichess}/black#42`,
  `${lichess}SeCr/white?foo=bar`,
  lichessGame,
  `${lichessGame}/black`,
  `${lichessGame}SeCr/white?pov=someone`,
]) {
  test(`canonical Lichess URL: ${input}`, () => assert.equal(canonicalGameUrl(input), lichess));
}

for (const input of [
  "http://lichess.org/Ab12Cd34",
  "https://lichess.org.evil.test/Ab12Cd34",
  "https://www.chess.com.evil.test/game/live/123",
  "https://evil.test/?url=" + chess,
  "https://user:password@lichess.org/Ab12Cd34",
  "https://lichess.org:444/Ab12Cd34",
  "javascript:alert(1)",
  "chessriddle-studio://import?url=x",
  "not a URL",
  "https://lichess.org/analysis",
  "https://lichess.org/training",
  "https://lichess.org/study/Ab12Cd34",
  "https://lichess.org/analysis/standard/Ab12Cd34",
  "https://www.chess.com/game/live/0",
  "https://www.chess.com/game/live/123/garbage",
  "https://www.chess.com/member/test?gameId=123",
  "https://www.chess.com/analysis?gameId=1&gameId=2",
  "https://lichess.org/Ab12Cd34/evil",
  "https://lichess.org/game/Ab12Cd34/evil",
  "https://lichess.org/game/export/Ab12Cd34",
  "https://lichess.org/game/game/Ab12Cd34",
  "https://lichess.org/game/training",
  "https://lichess.org/Ab12%2f34",
])
  test(`reject unsupported URL: ${input}`, () => assert.equal(canonicalGameUrl(input), null));

test("daily games retain their type", () => {
  assert.equal(
    canonicalGameUrl("https://www.chess.com/analysis/game/daily/456"),
    "https://www.chess.com/game/daily/456",
  );
  assert.equal(
    canonicalGameUrl("https://www.chess.com/play/daily?gameId=456"),
    "https://www.chess.com/game/daily/456",
  );
});

test("deep link round-trips through the desktop contract without player secrets", () => {
  const link = new URL(deepLink(`${lichess}SeCr/black?token=secret#4`));
  assert.equal(link.protocol, "chessriddle-studio:");
  assert.equal(link.host, "import");
  assert.equal(link.searchParams.get("url"), lichess);
  assert.equal(deepLink("https://evil.test/game/live/1"), null);
});

const chessAnalysis =
  '<main class="analysis-layout-main"><aside class="board-layout-sidebar"><div class="analysis-controls-component"></div></aside></main>';
const chessLive =
  '<main id="board-layout-main"></main><aside class="board-layout-sidebar"><div class="game-controls-component"></div></aside>';
const lichessRound =
  '<main class="round__app"><div class="moves"></div><div class="rcontrols"></div></main>';
const lichessAnalysis =
  '<main class="analyse"><div class="analyse__tools"><div class="result">½-½</div></div><div class="analyse__underboard"></div></main>';

function setup(t, url, html) {
  const instance = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => instance.window.close());
  instance.window.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
  instance.window.eval(core);
  return instance.window;
}
const getButton = (window) => window.document.querySelector('[data-chessriddle-studio="analyze"]');
const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

test("a direct Chess.com game route alone does not prove completion", async (t) => {
  const window = setup(
    t,
    chess,
    chessLive + '<div class="game-result">Unrelated archive result</div>',
  );
  window.eval(content);
  assert.equal(getButton(window), null);
  window.document.querySelector(".game-controls-component").innerHTML =
    '<div class="game-result">1-0</div>';
  await settle();
  assert.ok(getButton(window));
});

test("historical Chess.com page gets one accessible link with the Studio mark", (t) => {
  const window = setup(t, chess.replace("/game/", "/analysis/game/"), chessAnalysis);
  window.eval(content);
  const button = getButton(window);
  assert.equal(button.textContent, "Analyze in ChessRiddle Studio");
  assert.equal(button.getAttribute("aria-label"), button.textContent);
  assert.equal(new URL(button.href).searchParams.get("url"), chess);
  // A class of the host would bring its state rules along: on Chess.com's light theme the
  // secondary button's hover text colour made the label unreadable on this button's fill.
  assert.equal(button.className, "crs-analyze crs-analyze--chess");
  const mark = button.querySelector("img.crs-analyze__mark");
  assert.equal(mark.getAttribute("src"), "chrome-extension://test/icons/48.png");
  assert.equal(mark.alt, "");
  assert.equal(button.firstChild, mark);
  assert.ok(button.closest(".analysis-controls-component"));
  window.eval(content);
  assert.equal(window.document.querySelectorAll(".crs-analyze").length, 1);
});

test("live Chess.com game stays hidden until completion, then disappears on rematch", async (t) => {
  const window = setup(t, chess.replace("/game/live/", "/play/online/game/"), chessLive);
  window.eval(content);
  assert.equal(getButton(window), null);
  const complete = window.document.createElement("div");
  complete.className = "game-over-modal-content";
  window.document.querySelector("aside").append(complete);
  await settle();
  assert.ok(getButton(window));
  complete.remove();
  window.history.pushState({}, "", "/play/online/game/987");
  await settle();
  assert.equal(getButton(window), null);
});

test("generic live route resolves only an unambiguous completed-game link", (t) => {
  const window = setup(t, "https://www.chess.com/play/online", chessLive);
  const { getContext } = window.ChessRiddleStudioExtension;
  window.document.querySelector("aside").innerHTML =
    '<div class="game-over-modal-content"><a href="/analysis/game/live/123456789">Review</a></div>';
  assert.equal(getContext(window.document, window.location.href).gameUrl, chess);
  window.document
    .querySelector(".game-over-modal-content")
    .insertAdjacentHTML("beforeend", '<a href="/game/live/987">Other game</a>');
  assert.equal(getContext(window.document, window.location.href), null);
});

test("unrelated archive links and hidden completion dialogs cannot enable import", (t) => {
  const window = setup(
    t,
    "https://www.chess.com/play/online",
    chessLive +
      `<a href="${chess}">Archive</a><div class="game-over-modal-content" hidden><a href="${chess}">Review</a></div>`,
  );
  window.eval(content);
  assert.equal(getButton(window), null);
});

// Chess.com's markup as observed on 2026-11-22 (a finished live game, signed out): the
// end-of-game dialog over the board, and the result row and review buttons in the sidebar.
// Its button classes carry a build hash, so nothing here may depend on them.
const reviewLink =
  '<a class="cc-button-component_b359d5b cc-button-primary_b359d5b" href="/analysis/game/live/123456789?tab=review">Game Review</a>';
const chessV6Dialog = `<div class="board-modal-component"><div class="game-over-modal-shell-container"><div class="game-over-modal-shell-content game-over-modal-shell-v6"><div class="game-over-modal-header-component"></div><div class="game-over-modal-shell-buttons">${reviewLink}</div></div></div></div>`;
const chessV6ResultRow =
  '<div class="main-line-row move-list-row result-row"><span class="game-result">1-0</span></div>';
const chessV6ReviewButtons = `<div class="game-review-buttons-component">${reviewLink}</div>`;
const chessV6Page = (board, sidebar) =>
  `<div id="board-layout-main" class="board-layout-main"><div id="board-layout-chessboard" class="board-layout-chessboard">${board}</div></div><div id="board-layout-sidebar" class="board-layout-sidebar"><div class="sidebar-component"><div class="sidebar-content"><div id="live-game-tab-scroll-container" class="game-tab-scrollable">${sidebar}</div></div></div></div>`;

test("a finished Chess.com game in today's markup gets the link beside the review button", (t) => {
  const window = setup(
    t,
    chess,
    chessV6Page(chessV6Dialog, chessV6ResultRow + chessV6ReviewButtons),
  );
  window.eval(content);
  const button = getButton(window);
  assert.equal(new URL(button.href).searchParams.get("url"), chess);
  assert.ok(button.closest(".game-review-buttons-component"));
  assert.equal(window.document.querySelectorAll(".crs-analyze").length, 1);
});

test("today's end-of-game dialog alone carries the link in its button row", (t) => {
  const window = setup(t, chess, chessV6Page(chessV6Dialog, ""));
  window.eval(content);
  assert.ok(getButton(window).closest(".game-over-modal-shell-buttons"));
});

test("today's result row alone proves completion", (t) => {
  const window = setup(t, chess, chessV6Page("", chessV6ResultRow));
  window.eval(content);
  assert.ok(getButton(window).closest(".board-layout-sidebar"));
});

test("an unfinished Chess.com game in today's markup gets no link", (t) => {
  const moves = '<div class="main-line-row move-list-row"><span class="node">e4</span></div>';
  const window = setup(t, chess, chessV6Page("", moves));
  window.eval(content);
  assert.equal(getButton(window), null);
});

test("the generic live route takes the game from today's review button", (t) => {
  const window = setup(
    t,
    "https://www.chess.com/play/online",
    chessV6Page(chessV6Dialog, chessV6ResultRow + chessV6ReviewButtons),
  );
  window.eval(content);
  assert.equal(new URL(getButton(window).href).searchParams.get("url"), chess);
});

test("today's analysis page carries the link in the block under the move list", (t) => {
  // The address ends in a second "/analysis", and the sidebar has a fixed height: a link
  // appended to the sidebar itself would fall out of it.
  const window = setup(
    t,
    `${chess.replace("/game/", "/analysis/game/")}/analysis`,
    '<div id="board-layout-main" class="board-layout-main"></div><div id="board-layout-sidebar" class="board-layout-sidebar"><div class="sidebar-component"><div class="sidebar-view-component"><div class="sidebar-tab-content-component"><div class="analysis-view-component"></div></div><div class="game-controls-view-component"><div class="game-controls-primary-component"></div><div class="game-controls-secondary-component"></div></div></div></div></div>',
  );
  window.eval(content);
  const button = getButton(window);
  assert.equal(new URL(button.href).searchParams.get("url"), chess);
  assert.equal(button.parentElement.className, "game-controls-view-component");
  assert.equal(button.previousElementSibling.className, "game-controls-secondary-component");
});

test("completed Lichess analysis gets a link without host classes and the public game ID", (t) => {
  const window = setup(t, `${lichess}SeCr/black`, lichessAnalysis);
  window.eval(content);
  const button = getButton(window);
  assert.equal(button.className, "crs-analyze crs-analyze--lichess");
  assert.equal(button.firstChild, button.querySelector("img.crs-analyze__mark"));
  assert.equal(button.textContent, "Analyze in ChessRiddle Studio");
  assert.equal(new URL(button.href).searchParams.get("url"), lichess);
  assert.ok(button.closest(".analyse__underboard"));
});

test("a finished Lichess game at today's address gets the link under the board", (t) => {
  // Markup as observed on 2026-11-22: the result closes the move list, and the panels under
  // the board carry no per-panel class.
  const window = setup(
    t,
    `${lichessGame}/black`,
    '<main class="analyse variant-standard"><div class="analyse__tools"><div class="analyse__moves areplay"><div><div class="tview2 tview2-column"></div><div class="result">1-0</div><div class="status">Black resigned</div></div></div></div><div class="analyse__underboard"><div class="analyse__underboard__menu"></div><div class="analyse__underboard__panels"></div></div></main>',
  );
  window.eval(content);
  const button = getButton(window);
  assert.equal(new URL(button.href).searchParams.get("url"), lichess);
  assert.equal(button.parentElement.className, "analyse__underboard");
});

test("Lichess round button appears on terminal result text updates", async (t) => {
  const window = setup(t, lichess, lichessRound);
  window.eval(content);
  assert.equal(getButton(window), null);
  const result = window.document.createElement("div");
  result.className = "result";
  result.textContent = "*";
  window.document.querySelector(".moves").append(result);
  await settle();
  assert.equal(getButton(window), null);
  result.firstChild.data = "1-0";
  await settle();
  assert.ok(getButton(window));
});

test("ongoing Lichess analysis, studies, puzzles, and tools do not get a button", (t) => {
  for (const [path, html] of [
    ["/Ab12Cd34", lichessAnalysis.replace("½-½", "*")],
    ["/game/Ab12Cd34", lichessAnalysis.replace("½-½", "*")],
    ["/study/Ab12Cd34", lichessAnalysis],
    ["/analysis", lichessAnalysis],
    ["/training/Ab12Cd34", lichessAnalysis],
  ]) {
    const window = setup(t, `https://lichess.org${path}`, html);
    window.eval(content);
    assert.equal(getButton(window), null, path);
  }
});

test("replaces a removed host control without duplicating the button", async (t) => {
  const window = setup(t, chess, chessAnalysis);
  window.eval(content);
  const old = getButton(window);
  window.document.querySelector(".analysis-controls-component").outerHTML =
    '<div class="analysis-controls-component"></div>';
  await settle();
  assert.equal(getButton(window), old);
  assert.equal(window.document.querySelectorAll(".crs-analyze").length, 1);
});

test("URL-only pushState updates links and removes unsupported destinations", async (t) => {
  const window = setup(t, chess, chessAnalysis);
  window.eval(content);
  window.history.pushState({}, "", "/game/daily/987");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    new URL(getButton(window).href).searchParams.get("url"),
    "https://www.chess.com/game/daily/987",
  );
  window.history.replaceState({}, "", "/member/test");
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await settle();
  assert.equal(getButton(window), null);
});

test("stale and synthetic activation is prevented synchronously", (t) => {
  const window = setup(t, chess, chessAnalysis);
  window.eval(content);
  const button = getButton(window);
  const synthetic = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(synthetic);
  assert.equal(synthetic.defaultPrevented, true);
  window.history.pushState({}, "", "/member/test");
  const stale = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(stale);
  assert.equal(stale.defaultPrevented, true);
  assert.equal(getButton(window), null);
});

test("bfcache pagehide tears down and pageshow restores the controller", (t) => {
  const window = setup(t, chess, chessAnalysis);
  window.eval(content);
  window.dispatchEvent(new window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(getButton(window), null);
  window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.ok(getButton(window));
  window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(window.document.querySelectorAll(".crs-analyze").length, 1);
});

test("a mark the page cannot load leaves the plain label", (t) => {
  const window = setup(t, chess.replace("/game/", "/analysis/game/"), chessAnalysis);
  window.eval(content);
  const button = getButton(window);
  button.querySelector("img").dispatchEvent(new window.Event("error"));
  assert.equal(button.querySelector("img"), null);
  assert.equal(button.textContent, "Analyze in ChessRiddle Studio");
});

// The sheet's rules as { selectors, declarations }; the sheet nests nothing but one media rule.
const rules = [...styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selectors, body]) => ({
    selectors: selectors.split(",").map((selector) => selector.trim()),
    declarations: new Map(
      body
        .split(";")
        .map((declaration) => declaration.split(/:(.*)/s).map((part) => part.trim()))
        .filter(([property]) => property),
    ),
  }),
);
const link = 'a.crs-analyze[data-chessriddle-studio="analyze"]';

test("one rule paints the link's text and fill together, in every state", () => {
  const painting = rules.filter(({ declarations }) =>
    ["color", "background", "background-color"].some((property) => declarations.has(property)),
  );
  // The mark's own reset is the only other rule that names a fill.
  const [paint, ...others] = painting.filter(
    ({ selectors }) => !selectors.every((selector) => selector.endsWith("img.crs-analyze__mark")),
  );
  assert.deepEqual(others, []);
  assert.deepEqual(
    paint.selectors,
    ["", ":visited", ":hover", ":focus", ":active"].map((state) => link + state),
  );
  assert.equal(paint.declarations.get("color"), "var(--crs-text)");
  assert.equal(paint.declarations.get("background"), "var(--crs-fill)");
});

test("the label keeps its contrast in both Chess.com themes, at rest, on hover and pressed", () => {
  const chessLink = 'a.crs-analyze--chess[data-chessriddle-studio="analyze"]';
  // Merges the named rules' values; each caller lists them in the order the cascade applies them.
  const values = (...selectors) => {
    const merged = new Map();
    for (const selector of selectors) {
      const rule = rules.find((candidate) => candidate.selectors.includes(selector));
      assert.ok(rule, selector);
      for (const [property, value] of rule.declarations) merged.set(property, value);
    }
    return merged;
  };
  const luminance = (hex) => {
    assert.match(hex, /^#[0-9a-f]{6}$/);
    const [red, green, blue] = [1, 3, 5]
      .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((channel) =>
        channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (state) => {
    const [high, low] = [state.get("--crs-text"), state.get("--crs-fill")]
      .map(luminance)
      .sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
  };
  const dark = values(chessLink);
  const light = values(chessLink, `html.light-mode ${chessLink}`);
  const states = { dark, light };
  for (const state of [":hover", ":active"]) {
    states[`dark${state}`] = values(chessLink, chessLink + state);
    states[`light${state}`] = values(
      chessLink,
      chessLink + state,
      `html.light-mode ${chessLink}`,
      `html.light-mode ${chessLink}${state}`,
    );
  }
  for (const [name, state] of Object.entries(states))
    assert.ok(contrast(state) >= 7, `${name}: ${contrast(state)}`);
  // The two themes are opposite surfaces, not one palette under two names.
  assert.ok(luminance(dark.get("--crs-fill")) < 0.1);
  for (const name of ["light", "light:hover", "light:active"])
    assert.ok(luminance(states[name].get("--crs-fill")) > 0.8, name);
});

test("Lichess takes text and fill from the theme, with a readable fallback pair", () => {
  const lichessLink = 'a.crs-analyze--lichess[data-chessriddle-studio="analyze"]';
  const rest = rules.find(({ selectors }) => selectors.includes(lichessLink)).declarations;
  assert.equal(rest.get("--crs-text"), "var(--c-font, #4d4d4d)");
  assert.equal(rest.get("--crs-fill"), "var(--c-bg-box, #e8e6e2)");
  const hover = rules.find(({ selectors }) =>
    selectors.includes(`${lichessLink}:hover`),
  ).declarations;
  assert.equal(hover.get("--crs-text"), "var(--c-font-clear, var(--c-font, #4d4d4d))");
  assert.equal(hover.has("--crs-fill"), false);
});

test("manifest limits site access and uses no privileged APIs or remote code", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://www.chess.com/*",
    "https://chess.com/*",
    "https://lichess.org/*",
  ]);
  // Only the mark the button shows is readable by a page, and only by the two sites.
  assert.deepEqual(manifest.web_accessible_resources, [
    { resources: ["icons/48.png"], matches: manifest.content_scripts[0].matches },
  ]);
  assert.ok(content.includes('chrome.runtime.getURL("icons/48.png")'));
  for (const path of [
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css,
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources[0].resources,
  ]) {
    assert.ok((await readFile(new URL(`../${path}`, import.meta.url))).length > 0, path);
  }
});
