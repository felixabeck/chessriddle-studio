import { WorkspaceTabScope } from "@/state/tabScope";
import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  activeTabAtom,
  threatFamily,
  engineTerminalFamily,
  engineRetryFamily,
} from "@/state/atoms";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import { analysisSearch } from "./analysisSearch";
import { AnalysisLineMemory } from "./analysisLineMemory";
import { engineIdentity, engineLineContext } from "./analysisLineContext";
import { readEngineLines, useDisplayedEngineLines } from "./useDisplayedEngineLines";
import type { Engine } from "@/utils/engines";
import { createInstance } from "i18next";
import english from "@/translation/en-US.json";
import german from "@/translation/de-DE.json";
import { engineFailureMessage, reportEngineFailure } from "./useDisplayedEngineLines";
import { errorUnlessCancelled } from "@/platform/errors";

let h: ReturnType<typeof engineDisplayHarness>;
let display: ReturnType<typeof useDisplayedEngineLines>;
function Probe({
  tabId = "display-tab",
  ...props
}: Parameters<typeof ScopedProbe>[0] & { tabId?: string }) {
  return (
    <WorkspaceTabScope tabId={tabId}>
      <ScopedProbe {...props} />
    </WorkspaceTabScope>
  );
}
function ScopedProbe({
  engine = displayEngine,
  fen = INITIAL_FEN,
  moves = [],
}: {
  engine?: Engine;
  fen?: string;
  moves?: string[];
}) {
  display = useDisplayedEngineLines(engine, fen, moves, moves.length);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  h = engineDisplayHarness();
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});

function terminal(moves: string[] = []) {
  return {
    type: "completed-without-lines" as const,
    searchedKey: analysisSearch(INITIAL_FEN, moves, false).key!,
    context: engineLineContext(h.store.get(h.settingsAtom), displayEngine),
    fingerprint: "attempt",
    engineIdentity: engineIdentity(displayEngine),
    generation: "generation",
    retry: 0,
  };
}

test("the shared derivation excludes dimmed fallback and failed current lines from actions", async () => {
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(h.settingsAtom), displayEngine);
  memory.set(analysisSearch(INITIAL_FEN, [], false).key!, displayLines);
  await act(async () => h.store.set(h.memoryAtom, memory));
  await h.render(<Probe />);
  const current = (moves: string[] = []) =>
    readEngineLines(h.store.get, "display-tab", displayEngine, INITIAL_FEN, moves, false)
      .actionable;
  expect(current()).toEqual(display.lines);
  await h.render(<Probe moves={["d2d4"]} />);
  expect(display.dimmed).toBe(true);
  expect(current(["d2d4"])).toBeUndefined();
  await h.render(<Probe />);
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
    }),
  );
  expect(display.dimmed).toBe(true);
  expect(display.lines).toEqual(displayLines);
  expect(current()).toBeUndefined();
});

test("uses current lines immediately, then dimmed previous lines with their original position until 1000 ms", async () => {
  await h.remember();
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(false);
  await h.render(<Probe moves={["d2d4"]} />);
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(true);
  expect(display.searchedBoardFen).toBe(INITIAL_FEN);
  expect(display.halfMoves).toBe(0);
  await act(async () => vi.advanceTimersByTime(999));
  expect(display.loading).toBe(false);
  await act(async () => vi.advanceTimersByTime(1));
  expect(display.loading).toBe(true);
  expect(display.lines).toBeUndefined();
  await h.remember(displayLines, ["d2d4"]);
  expect(display.loading).toBe(false);
  expect(display.dimmed).toBe(false);
});

test("changing the active workspace tab leaves the owning reader's fallback intact", async () => {
  await h.remember();
  await h.render(<Probe />);
  await h.render(<Probe moves={["e2e4"]} />);
  await act(async () => h.store.set(activeTabAtom, "another-tab"));
  await h.render(<Probe moves={["e2e4"]} />);
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(true);
  expect(display.searchedBoardFen).toBe(INITIAL_FEN);
});

test("first start stays empty until 1000 ms and navigation restarts the deadline", async () => {
  await h.render(<Probe />);
  await act(async () => vi.advanceTimersByTime(999));
  expect(display.lines).toBeUndefined();
  expect(display.loading).toBe(false);
  await h.render(<Probe moves={["e2e4"]} />);
  await act(async () => vi.advanceTimersByTime(999));
  expect(display.loading).toBe(false);
  await act(async () => vi.advanceTimersByTime(1));
  expect(display.loading).toBe(true);
});

test("a marked key suppresses dimmed fallback and loading beyond 1000 ms while other keys still wait", async () => {
  await h.remember();
  await h.render(<Probe />);
  const moves = ["d2d4"];
  await h.render(<Probe moves={moves} />);
  expect(display.dimmed).toBe(true);
  const terminalAtom = engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id });
  await act(async () => h.store.set(terminalAtom, terminal(moves)));
  expect(display.lines).toBeUndefined();
  expect(display.dimmed).toBe(false);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(display.loading).toBe(false);
  expect(display.lines).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(display.loading).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await h.render(<Probe moves={["e2e4"]} />);
  expect(display.dimmed).toBe(true);
  await act(async () => vi.advanceTimersByTime(999));
  expect(display.loading).toBe(false);
  await act(async () => vi.advanceTimersByTime(1));
  expect(display.loading).toBe(true);
  await h.render(<Probe moves={moves} />);
  expect(display.loading).toBe(false);
  await act(async () => h.store.set(terminalAtom, null));
  expect(display.dimmed).toBe(true);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(display.loading).toBe(true);
});

test("a no-lines mark preserves valid remembered lines for the same key", async () => {
  await h.remember();
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), terminal()),
  );
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(false);
  await act(async () => vi.advanceTimersByTime(5000));
  expect(display.loading).toBe(false);
});

test("invalid, game-over, inactive and explicit no-analysis entries take precedence", async () => {
  await h.remember();
  await h.render(<Probe />);
  await h.render(<Probe fen="invalid" />);
  expect(display.error).toBeTruthy();
  expect(display.lines).toBeUndefined();
  await h.render(<Probe fen="7k/6Q1/5K2/8/8/8/8/8 b - - 0 1" />);
  expect(display.isGameOver).toBe(true);
  expect(display.lines).toBeUndefined();
  await h.render(<Probe moves={["e2e4"]} />);
  await act(async () => h.store.set(h.settingsAtom, (s) => ({ ...s, enabled: false })));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(display.lines).toBeUndefined();
  expect(display.loading).toBe(false);
  await h.remember([]);
  await h.render(<Probe />);
  expect(display.lines).toEqual([]);
  expect(display.dimmed).toBe(false);
});

test.each(["engine", "executable", "tab", "settings", "go", "mode"])(
  "resets the fallback on %s change",
  async (change) => {
    await h.remember();
    await h.render(<Probe />);
    await h.render(<Probe moves={["e2e4"]} />);
    expect(display.dimmed).toBe(true);
    if (change === "engine")
      await h.render(<Probe engine={{ ...displayEngine, id: "another" }} moves={["e2e4"]} />);
    if (change === "executable")
      await h.render(
        <Probe
          engine={{ ...displayEngine, handle: { ...displayEngine.handle, id: { id: "replaced" } } }}
          moves={["e2e4"]}
        />,
      );
    if (change === "tab") await h.render(<Probe tabId="another-tab" moves={["e2e4"]} />);
    if (change === "settings")
      await act(async () =>
        h.store.set(h.settingsAtom, (s) => ({
          ...s,
          settings: [{ type: "string", name: "Hash", value: "32" }],
        })),
      );
    if (change === "go")
      await act(async () =>
        h.store.set(h.settingsAtom, (s) => ({ ...s, go: { t: "Depth", c: 10 } })),
      );
    if (change === "mode") await act(async () => h.store.set(threatFamily("display-tab"), true));
    expect(display.dimmed).toBe(false);
    expect(display.lines).toBeUndefined();
  },
);

test("rejects memory from old settings and reads remembered lines only for the current mode", async () => {
  const memory = new AnalysisLineMemory();
  memory.context = "old context";
  memory.set(analysisSearch(INITIAL_FEN, [], false).key!, displayLines);
  await act(async () => h.store.set(h.memoryAtom, memory));
  await h.render(<Probe />);
  expect(display.lines).toBeUndefined();
  await act(async () =>
    h.store.set(
      h.memoryAtom,
      new Map([[analysisSearch(INITIAL_FEN, [], true).key!, displayLines]]),
    ),
  );
  expect(display.lines).toBeUndefined();
  await act(async () => h.store.set(threatFamily("display-tab"), true));
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(false);
  await act(async () => h.store.set(threatFamily("display-tab"), false));
  expect(display.lines).toBeUndefined();
});

test("a settings change discards previous lines even when those settings are selected again", async () => {
  await h.remember();
  await h.render(<Probe />);
  await h.render(<Probe moves={["e2e4"]} />);
  const original = h.store.get(h.settingsAtom);
  await act(async () => h.store.set(h.settingsAtom, { ...original, go: { t: "Depth", c: 10 } }));
  await act(async () => h.store.set(h.settingsAtom, original));
  expect(display.dimmed).toBe(false);
  expect(display.lines).toBeUndefined();
});

test("each mode retains its most recently displayed lines without exposing the other mode", async () => {
  await h.remember();
  await h.render(<Probe />);
  await h.render(<Probe moves={["e2e4"]} />);
  await act(async () => h.store.set(threatFamily("display-tab"), true));
  expect(display.lines).toBeUndefined();
  const threats = [{ ...displayLines[0], depth: 33 }];
  await act(async () =>
    h.store.set(
      h.memoryAtom,
      new Map([[analysisSearch(INITIAL_FEN, ["e2e4"], true).key!, threats]]),
    ),
  );
  expect(display.lines).toEqual(threats);
  await h.render(<Probe moves={["d2d4"]} />);
  expect(display.lines).toEqual(threats);
  expect(display.dimmed).toBe(true);
  await act(async () => h.store.set(threatFamily("display-tab"), false));
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(true);
});

test("the fallback tracks the latest displayed payload and its move-number anchor", async () => {
  await h.remember();
  await h.render(<Probe />);
  const latest = [{ ...displayLines[0], depth: 30 }];
  await h.remember(latest, ["e2e4"]);
  await h.render(<Probe moves={["e2e4"]} />);
  await h.render(<Probe moves={["d2d4"]} />);
  expect(display.lines).toEqual(latest);
  expect(display.halfMoves).toBe(1);
  expect(display.searchedBoardFen).toBe(analysisSearch(INITIAL_FEN, ["e2e4"], false).finalFen);
});

test("unavailable threats suppress cached and historical lines, failure and waiting, then recover", async () => {
  const fen = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 7";
  const legal = analysisSearch(INITIAL_FEN, [], true);
  const legacyKey = "4k3/8/8/8/8/8/4r3/4K3 b - - 0 7:";
  await act(async () => {
    h.store.set(threatFamily("display-tab"), true);
    h.store.set(
      h.memoryAtom,
      new Map([
        [legal.key!, displayLines],
        [legacyKey, displayLines],
      ]),
    );
  });
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  await h.render(<Probe fen={fen} />);
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
      searchedKey: legacyKey,
    }),
  );
  await act(async () => vi.advanceTimersByTime(5000));
  expect(display).toMatchObject({
    available: false,
    lines: [],
    dimmed: false,
    failure: null,
    loading: false,
    searchedBoardFen: null,
    error: null,
    isGameOver: false,
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(h.store.get(threatFamily("display-tab"))).toBe(true);
  expect(h.store.get(h.settingsAtom).enabled).toBe(true);
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  expect(display.searchedBoardFen).toBe(legal.searchedBoardFen);
  expect(display.dimmed).toBe(false);
});

test("historical threat lines retain their actual searched board and source halfMoves after a double push", async () => {
  const fen = "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 7";
  const source = analysisSearch(fen, ["d7d5"], true);
  await act(async () => {
    h.store.set(threatFamily("display-tab"), true);
    h.store.set(h.memoryAtom, new Map([[source.key!, displayLines]]));
  });
  await h.render(<Probe fen={fen} moves={["d7d5"]} />);
  await h.render(<Probe fen={fen} moves={["d7d6"]} />);
  expect(display.lines).toEqual(displayLines);
  expect(display.dimmed).toBe(true);
  expect(display.searchedBoardFen).toBe("4k3/8/8/3pP3/8/8/8/4K3 b - - 0 8");
  expect(display.halfMoves).toBe(1);
});

test("old deadlines are cancelled on navigation and unmount, and current results create no timer", async () => {
  await h.render(<Probe />);
  await act(async () => vi.advanceTimersByTime(500));
  await h.render(<Probe moves={["e2e4"]} />);
  await act(async () => vi.advanceTimersByTime(250));
  await h.render(<Probe />);
  await act(async () => vi.advanceTimersByTime(250));
  expect(display.loading).toBe(false);
  await h.remember();
  const timers = vi.getTimerCount();
  expect(timers).toBe(0);
  await h.render(<Probe moves={["d2d4"]} />);
  expect(vi.getTimerCount()).toBe(1);
  await h.render(null);
  expect(vi.getTimerCount()).toBe(0);
});

test("invalid and game-over positions suppress even remembered entries", async () => {
  const over = "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1";
  await act(async () =>
    h.store.set(
      h.memoryAtom,
      new Map([
        ["invalid:", displayLines],
        [`${over}:`, displayLines],
      ]),
    ),
  );
  await h.render(<Probe fen="invalid" />);
  expect(display.lines).toBeUndefined();
  expect(display.isGameOver).toBe(false);
  await h.render(<Probe fen={over} />);
  expect(display.lines).toBeUndefined();
  await h.render(<Probe />);
  expect(display.lines).toBeUndefined();
});

test("matching contextual memory is eligible and remote executable identity scopes the fallback", async () => {
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(h.settingsAtom), displayEngine);
  memory.set(analysisSearch(INITIAL_FEN, [], false).key!, displayLines);
  await act(async () => h.store.set(h.memoryAtom, memory));
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  const remote: Engine = {
    type: "chessdb",
    id: displayEngine.id,
    name: "Cloud",
    url: "https://example.test",
  };
  await h.remember();
  await h.render(<Probe engine={remote} />);
  await h.render(<Probe engine={{ ...remote, url: "https://changed.test" }} moves={["e2e4"]} />);
  expect(display.lines).toBeUndefined();
});

test("contextual remembered lines remain current across pause, resume and sync toggles", async () => {
  const memory = new AnalysisLineMemory();
  memory.context = engineLineContext(h.store.get(h.settingsAtom), displayEngine);
  memory.set(analysisSearch(INITIAL_FEN, [], false).key!, displayLines);
  await act(async () => h.store.set(h.memoryAtom, memory));
  await h.render(<Probe />);
  expect(display.lines).toEqual(displayLines);
  for (const enabled of [false, true]) {
    await act(async () =>
      h.store.set(h.settingsAtom, (s) => ({ ...s, enabled, synced: !s.synced })),
    );
    expect(display.lines).toEqual(displayLines);
    expect(display.dimmed).toBe(false);
    expect(display.loading).toBe(false);
  }
});

test("the shared reader initializes per-engine option and go defaults", async () => {
  const options = [{ type: "string" as const, name: "Hash", value: "32" }];
  await h.render(
    <Probe
      engine={{
        ...displayEngine,
        id: "default-engine",
        settings: options,
        go: { t: "Depth", c: 12 },
      }}
    />,
  );
  expect(display.settings.settings).toEqual(options);
  expect(display.settings.go).toEqual({ t: "Depth", c: 12 });
});

test.each([false, true])(
  "P2 failed display is sticky and historical, partial lines %s",
  async (partial) => {
    if (partial) await h.remember();
    await h.render(<Probe />);
    const failed = { ...terminal(), type: "failed" as const };
    await act(async () =>
      h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), failed),
    );
    await act(async () => vi.advanceTimersByTime(5000));
    expect(display.failure).toBe(failed);
    expect(display.loading).toBe(false);
    expect(display.dimmed).toBe(partial);
    await h.render(<Probe />);
    expect(display.failure).toBe(failed);
    await h.render(<Probe tabId="another-tab" />);
    expect(display.failure).toBeNull();
    await h.render(<Probe engine={{ ...displayEngine, id: "other-engine" }} />);
    expect(display.failure).toBeNull();
    await h.render(
      <Probe
        engine={{
          type: "chessdb",
          id: displayEngine.id,
          name: displayEngine.name,
          url: "https://chessdb.cn",
          loaded: true,
        }}
      />,
    );
    expect(display.failure).toBeNull();
    await h.render(<Probe />);
    expect(display.failure).toBe(failed);
    await act(async () =>
      h.store.set(engineRetryFamily({ tab: "display-tab", engine: displayEngine.id }), 1),
    );
    expect(display.failure).toBeNull();
  },
);

test.each(["en", "de"])(
  "P2 safe reasons and kind/status fallbacks are localized in %s",
  async (lng) => {
    const i18n = createInstance();
    await i18n.init({
      lng,
      fallbackLng: false,
      keySeparator: false,
      resources: { en: english, de: german },
    });
    const fallback = (
      kind: "disconnected" | "process-exit" | "protocol-failure",
      code: number | null = null,
      signal: number | null = null,
    ) =>
      engineFailureMessage(i18n.t, {
        kind,
        exitStatus: { code, signal },
        reason: null,
        entries: [],
      });
    expect(fallback("disconnected")).toBe(
      lng === "en" ? "Engine disconnected" : "Engine-Verbindung getrennt",
    );
    expect(fallback("process-exit")).toBe(lng === "en" ? "Engine exited" : "Engine beendet");
    expect(fallback("protocol-failure")).toBe(
      lng === "en" ? "Engine protocol failed" : "Engine-Protokoll fehlgeschlagen",
    );
    expect(fallback("process-exit", 7)).toContain("7");
    expect(fallback("process-exit", null, 9)).toContain("9");
    expect(engineFailureMessage(i18n.t)).toBe(i18n.t("Board.Analysis.EngineDisconnected"));
    expect(engineFailureMessage(i18n.t, undefined, "")).toBe(
      i18n.t("Board.Analysis.EngineDisconnected"),
    );
    expect(engineFailureMessage(i18n.t, undefined, "Safe launch failure")).toBe(
      "Safe launch failure",
    );
    expect(
      engineFailureMessage(i18n.t, {
        kind: "process-exit",
        exitStatus: null,
        reason: "Safe reason",
        entries: [],
      }),
    ).toBe("Safe reason");
  },
);

test("the failed display retains the normalized safe message without a snapshot", async () => {
  const raw = "Cannot launch /home/felixb/engines/stockfish token=secret";
  const safe = "Cannot launch [path] token=[redacted]";
  const failure = errorUnlessCancelled(new Error(raw))!;
  await h.render(<Probe />);
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
      message: failure.message,
    }),
  );
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: false,
    keySeparator: false,
    resources: { en: english },
  });
  const text = engineFailureMessage(i18n.t, display.failure?.snapshot, display.failure?.message);
  expect(text).toBe(safe);
  expect(text).not.toContain("/home/felixb/engines/stockfish");
  expect(text).not.toContain("secret");
  expect(
    reportEngineFailure(i18n.t, {
      tag: "engine-failure",
      category: "engine-failure",
      message: raw,
    }),
  ).toMatchObject({ message: safe });
  expect(
    engineFailureMessage(
      i18n.t,
      { kind: "process-exit", exitStatus: { code: 1, signal: null }, reason: null, entries: [] },
      safe,
    ),
  ).toBe("Engine exited with code 1");
});

test.each(["not-in-database", "completed-without-lines", "failed"] as const)(
  "remote %s terminals match only the current position, settings, engine identity and retry",
  async (type) => {
    const remote: Engine = {
      type: "chessdb",
      id: displayEngine.id,
      name: displayEngine.name,
      url: "https://chessdb.cn",
      loaded: true,
    };
    const atom = engineTerminalFamily({ tab: "display-tab", engine: remote.id });
    const current = {
      ...terminal(),
      type,
      generation: null,
      engineIdentity: engineIdentity(remote),
      context: engineLineContext(h.store.get(h.settingsAtom), remote),
      message: "Remote request failed",
    };
    await h.render(<Probe engine={remote} />);
    await act(async () => h.store.set(atom, current));
    expect(display.terminal).toBe(current);
    expect(display.failure).toBe(type === "failed" ? current : null);
    const expectedLines = type === "failed" ? undefined : [];
    expect(display.lines).toEqual(expectedLines);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(display.loading).toBe(false);
    for (const engine of [
      { ...remote, loaded: false },
      { ...remote, id: "other" },
      { ...remote, url: "https://other.test" },
    ]) {
      await h.render(<Probe engine={engine} />);
      expect(display.terminal).toBeNull();
    }
    await h.render(<Probe engine={remote} moves={["e2e4"]} />);
    expect(display.terminal).toBeNull();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(display.loading).toBe(true);
    await h.render(<Probe engine={remote} />);
    expect(display.terminal).toBe(current);
    await h.render(<Probe engine={remote} tabId="another-tab" />);
    expect(display.terminal).toBeNull();
    await h.render(<Probe engine={remote} />);
    await act(async () =>
      h.store.set(h.settingsAtom, (settings) => ({ ...settings, go: { t: "Depth", c: 12 } })),
    );
    expect(display.terminal).toBeNull();
    await act(async () =>
      h.store.set(h.settingsAtom, (settings) => ({ ...settings, go: { t: "Infinite" } })),
    );
    expect(display.terminal).toBe(current);
    await act(async () =>
      h.store.set(engineRetryFamily({ tab: "display-tab", engine: remote.id }), 1),
    );
    expect(display.terminal).toBeNull();
  },
);
