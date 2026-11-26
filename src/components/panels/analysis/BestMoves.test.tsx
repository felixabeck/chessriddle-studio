import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { displayEngine, displayLines, engineDisplayHarness } from "@/tests/engineDisplay";
import { createInstance } from "i18next";
import type { ChessDBLine } from "@/utils/chessdb/api";
import type { Engine } from "@/utils/engines";
import {
  engineTerminalFamily,
  engineRetryFamily,
  enginesAtom,
  expandedEnginesFamily,
  tabEngineSettingsFamily,
  threatFamily,
  engineProgressFamily,
} from "@/state/atoms";
import { decodeCompressedOrJson } from "@/state/store/debouncedStorage";
import { decodeEngineOwnerValue } from "@/state/engineOwnerStorage";
import { useAtomValue } from "jotai";
import type { Settings } from "./EngineSettingsForm";
import { analysisSearch } from "@/utils/analysisSearch";
import { engineIdentity, engineLineContext } from "./analysisLineContext";
import BestMoves from "./BestMoves";
import { errorUnlessCancelled } from "@/platform/errors";
import { installResizeObserverStub } from "@/tests/resizeObserver";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: publication.translate ?? ((key: string) => key) }),
}));
const publication = vi.hoisted(() => ({
  reconcile: vi.fn(),
  realForm: false,
  displayed: undefined as Settings | undefined,
  setSettings: undefined as undefined | ((update: (current: Settings) => Settings) => void),
  translate: undefined as undefined | ((key: string) => string),
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, reconcileEngineAttachments: publication.reconcile },
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./EngineSettingsForm", async (importOriginal) => {
  const { default: Form } = await importOriginal<typeof import("./EngineSettingsForm")>();
  return {
    default: (props: React.ComponentProps<typeof Form>) => {
      publication.setSettings = props.setSettings;
      publication.displayed = props.settings;
      return publication.realForm ? <Form {...props} /> : null;
    },
  };
});
vi.mock("./EngineLogsModal", () => ({
  default: ({
    engine,
    opened,
    onClose,
  }: {
    engine: Engine;
    opened: boolean;
    onClose: () => void;
  }) =>
    opened ? (
      <div data-testid="engine-logs-dialog">
        {engine.id}
        <button onClick={onClose}>close-logs</button>
      </div>
    ) : null,
}));
vi.mock("./AnalysisRow", () => ({
  default: ({ moves, inert, fen, halfMoves, chessdb }: any) => (
    <tr
      data-inert={inert}
      data-fen={fen}
      data-ply={halfMoves}
      data-chessdb={JSON.stringify(chessdb)}
    >
      <td>{moves.join(" ")}</td>
    </tr>
  ),
}));
let h: ReturnType<typeof engineDisplayHarness>;
beforeEach(() => {
  publication.reconcile.mockReset().mockResolvedValue(undefined);
  publication.realForm = false;
  publication.translate = undefined;
  installResizeObserverStub();
  vi.useFakeTimers();
  h = engineDisplayHarness();
});

function LivePanel() {
  const engine = useAtomValue(enginesAtom)?.[0];
  return engine ? (
    <BestMoves
      id={0}
      engine={engine}
      fen={INITIAL_FEN}
      moves={[]}
      halfMoves={0}
      orientation="white"
    />
  ) : null;
}

test.each([false, true])(
  "parent sync admission persists retained local defaults with absent globals, refusal %s",
  async (refused) => {
    const local = {
      enabled: true,
      synced: false,
      go: { t: "Depth" as const, c: 17 },
      settings: [{ type: "string" as const, name: "Hash", value: "128" }],
    };
    await h.store.set(enginesAtom, [displayEngine]);
    h.store.set(h.settingsAtom, local);
    const other = tabEngineSettingsFamily({ tab: "another-tab", engineId: displayEngine.id });
    h.store.set(other, { ...local, enabled: false, go: { t: "Depth", c: 5 } });
    const otherBefore = h.store.get(other);
    publication.realForm = true;
    await h.render(<LivePanel />);
    const bytes = localStorage.getItem("engines");
    let release!: () => void;
    let reject!: (error: Error) => void;
    publication.reconcile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, refuse) => {
          release = resolve;
          reject = refuse;
        }),
    );
    const syncLabel = [...h.host.querySelectorAll("label")].find(
      (label) => label.textContent === "Board.Analysis.SyncGlobally",
    )!;
    const sync = document.getElementById(syncLabel.htmlFor) as HTMLInputElement;
    expect(sync.checked).toBe(false);
    await act(async () => sync.click());
    // Drain even the syncing=false fault, which admits no native save.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const pending = publication.displayed;
    const committed = h.store.get(h.settingsAtom);
    const pendingBytes = localStorage.getItem("engines");
    await act(async () => {
      if (refused) reject?.(new Error("sync refused"));
      else release?.();
    });
    // A dropped action leaves its one-shot transport unused. The drain must stay independent.
    publication.reconcile.mockReset().mockResolvedValue(undefined);
    await act(async () => {
      await h.store.set(enginesAtom, (current) => current);
    });
    const saved = h.store.get(enginesAtom)![0];
    expect(saved.go).toEqual(refused ? undefined : local.go);
    expect(saved.settings).toEqual(refused ? undefined : local.settings);
    expect(
      decodeEngineOwnerValue(decodeCompressedOrJson(localStorage.getItem("engines")!))?.value,
    ).toEqual([saved]);
    expect(pending?.go).toEqual(local.go);
    expect(pending?.settings).toEqual(local.settings);
    expect(committed).toEqual({ ...local, synced: true, go: { t: "Infinite" }, settings: [] });
    expect(pendingBytes).toBe(bytes);
    expect(h.store.get(h.settingsAtom)).toEqual({
      ...local,
      synced: true,
      go: refused ? { t: "Infinite" } : local.go,
      settings: refused ? [] : local.settings,
    });
    expect(h.store.get(other)).toBe(otherBefore);
  },
);

test.each(["sync", "options"] as const)(
  "one parent %s settings action refuses all members and a later action saves independently",
  async (action) => {
    const hash = { type: "string" as const, name: "Hash", value: "64" };
    const threads = { type: "string" as const, name: "Threads", value: "1" };
    await h.store.set(enginesAtom, [
      { ...displayEngine, settings: [hash, threads], go: { t: "Depth", c: 10 } },
    ]);
    h.store.set(h.settingsAtom, {
      enabled: true,
      synced: action !== "sync",
      settings: [hash, threads],
      go: { t: "Depth", c: 17 },
    });
    await h.render(<LivePanel />);
    const before = h.store.get(enginesAtom)![0];
    let reject!: (error: Error) => void;
    publication.reconcile.mockClear();
    publication.reconcile.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, refuse) => {
          reject = refuse;
        }),
    );
    await act(async () =>
      publication.setSettings!((current) => ({
        ...current,
        synced: true,
        settings: [
          { ...hash, value: "128" },
          { ...threads, value: "8" },
        ],
        go: { t: "Depth", c: 21 },
      })),
    );
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    expect(publication.displayed).toMatchObject({
      settings: [
        { ...hash, value: "128" },
        { ...threads, value: "8" },
      ],
      go: { t: "Depth", c: 21 },
    });
    expect(h.store.get(enginesAtom)![0]).toEqual(before);
    await act(async () => reject(new Error("whole action refused")));
    await act(async () => {
      await h.store.set(enginesAtom, (current) => current);
    });
    const settled = h.store.get(enginesAtom)![0];
    const settledBytes = decodeEngineOwnerValue(
      decodeCompressedOrJson(localStorage.getItem("engines")!),
    )?.value;
    await act(async () =>
      publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 30 } })),
    );
    await act(async () => {
      await h.store.set(enginesAtom, (current) => current);
    });
    expect(settled).toEqual(before);
    expect(settledBytes).toEqual([before]);
    expect(h.store.get(enginesAtom)![0]).toEqual({ ...before, go: { t: "Depth", c: 30 } });
    expect(publication.displayed).toMatchObject({
      settings: before.settings,
      go: { t: "Depth", c: 30 },
    });
  },
);

test("rapid synced Hash reversal uses latest pending input while search settings remain committed", async () => {
  const hash = (value: string) => ({ type: "string" as const, name: "Hash", value });
  await h.store.set(enginesAtom, [{ ...displayEngine, settings: [hash("64")] }]);
  h.store.set(h.settingsAtom, {
    enabled: true,
    synced: true,
    go: { t: "Infinite" },
    settings: [hash("64")],
  });
  await h.render(<LivePanel />);
  publication.reconcile.mockClear();
  let release!: () => void;
  publication.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => {
    publication.setSettings!((current) => ({ ...current, settings: [hash("128")] }));
    publication.setSettings!((current) => ({
      ...current,
      settings: current.settings.map((option) => (option.name === "Hash" ? hash("64") : option)),
    }));
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(h.store.get(h.settingsAtom).settings).toEqual([hash("64")]);
  await act(async () => release());
  await vi.waitFor(() => expect(h.store.get(enginesAtom)?.[0].settings).toEqual([hash("64")]));
  expect(publication.reconcile).toHaveBeenCalledTimes(4);
  expect(publication.displayed?.settings).toEqual([hash("64")]);
});

test("synced defaults remain committed while a save is pending or refused and merge other queued options", async () => {
  await h.store.set(enginesAtom, [
    { ...displayEngine, settings: [{ type: "string", name: "Threads", value: "1" }] },
  ]);
  await act(async () =>
    h.store.set(h.settingsAtom, {
      enabled: true,
      synced: true,
      go: { t: "Infinite" },
      settings: [{ type: "string", name: "Threads", value: "1" }],
    }),
  );
  await h.render(<LivePanel />);
  let reject!: (error: Error) => void;
  publication.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  await act(async () =>
    publication.setSettings!((current) => ({
      ...current,
      settings: [{ type: "string", name: "Threads", value: "8" }],
    })),
  );
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(h.store.get(h.settingsAtom).settings).toEqual([
    { type: "string", name: "Threads", value: "1" },
  ]);
  expect(h.store.get(enginesAtom)?.[0].settings).toEqual([
    { type: "string", name: "Threads", value: "1" },
  ]);
  await act(async () => {
    reject(new Error("refused"));
  });
  expect(h.store.get(h.settingsAtom).settings).toEqual([
    { type: "string", name: "Threads", value: "1" },
  ]);
  await h.store.set(enginesAtom, (current) =>
    current.map((item) => ({
      ...item,
      settings: [...(item.settings ?? []), { type: "string", name: "Hash", value: "64" }],
    })),
  );
  await act(async () =>
    publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 12 } })),
  );
  await vi.waitFor(() => expect(h.store.get(enginesAtom)?.[0].go).toEqual({ t: "Depth", c: 12 }));
  expect(h.store.get(enginesAtom)?.[0].settings).toContainEqual({
    type: "string",
    name: "Hash",
    value: "64",
  });
});

test("pending synced option removal and independent go intent preserve latest fields without carrying refused options", async () => {
  const hash = { type: "string" as const, name: "Hash", value: "64" };
  const threads = { type: "string" as const, name: "Threads", value: "1" };
  await h.store.set(enginesAtom, [{ ...displayEngine, settings: [hash, threads] }]);
  h.store.set(h.settingsAtom, {
    enabled: true,
    synced: true,
    settings: [hash, threads],
    go: { t: "Infinite" },
  });
  await h.render(<LivePanel />);
  let reject!: (error: Error) => void;
  publication.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
      }),
  );
  await act(async () =>
    publication.setSettings!((current) => ({
      ...current,
      settings: current.settings.filter((option) => option.name !== "Hash"),
    })),
  );
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(publication.displayed?.settings).toEqual([threads]);
  await act(async () =>
    publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 12 } })),
  );
  expect(publication.displayed?.settings).toEqual([threads]);
  expect(h.store.get(h.settingsAtom).go).toEqual({ t: "Infinite" });
  await act(async () => reject(new Error("remove refused")));
  await vi.waitFor(() => expect(h.store.get(enginesAtom)?.[0].go).toEqual({ t: "Depth", c: 12 }));
  expect(h.store.get(enginesAtom)?.[0].settings).toEqual([hash, threads]);
  expect(publication.displayed?.settings).toEqual([hash, threads]);
});

test("unsynced analysis edits retain their separate per-tab state without saving defaults", async () => {
  await h.render(panel());
  publication.reconcile.mockClear();
  await act(async () =>
    publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 9 } })),
  );
  expect(h.store.get(h.settingsAtom).go).toEqual({ t: "Depth", c: 9 });
  expect(publication.reconcile).not.toHaveBeenCalled();
});

test("accepted synced writes finish after unmount and queued edits cannot recreate an absent identity", async () => {
  await h.store.set(enginesAtom, [displayEngine]);
  h.store.set(h.settingsAtom, { enabled: true, synced: true, settings: [], go: { t: "Infinite" } });
  await h.render(<LivePanel />);
  let release!: () => void;
  publication.reconcile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () =>
    publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 12 } })),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const removal = h.store.set(enginesAtom, { removeLocalId: displayEngine.id });
  await act(async () =>
    publication.setSettings!((current) => ({ ...current, go: { t: "Depth", c: 20 } })),
  );
  const stale = publication.setSettings!;
  await h.render(null);
  await act(async () => {
    release();
    await removal;
  });
  await vi.waitFor(() => expect(h.store.get(enginesAtom)).toEqual([]));
  publication.reconcile.mockClear();
  await act(async () => stale((current) => ({ ...current, go: { t: "Depth", c: 30 } })));
  expect(publication.reconcile).not.toHaveBeenCalled();
  expect(h.store.get(enginesAtom)).toEqual([]);
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});
const panel = (
  moves: string[] = [],
  fen = INITIAL_FEN,
  halfMoves = moves.length,
  engine: Engine = displayEngine,
) => (
  <BestMoves
    id={0}
    engine={engine}
    fen={fen}
    moves={moves}
    halfMoves={halfMoves}
    orientation="white"
  />
);

function terminal(moves: string[] = [], engine: Engine = displayEngine) {
  return {
    type: "completed-without-lines" as const,
    searchedKey: analysisSearch(INITIAL_FEN, moves, false).key!,
    context: engineLineContext(h.store.get(h.settingsAtom), engine),
    fingerprint: "attempt",
    engineIdentity: engineIdentity(engine),
    generation: "generation",
    retry: 0,
  };
}

test("unavailable threat uses the shipped empty state and idles every loading affordance", async () => {
  const key = analysisSearch(INITIAL_FEN, [], true).key!;
  await act(async () => {
    h.store.set(threatFamily("display-tab"), true);
    h.store.set(
      h.memoryAtom,
      new Map([
        [
          key,
          [
            {
              depth: 20,
              multipv: 1,
              nodes: 1n,
              nps: 1n,
              score: { value: { type: "cp", value: 34 }, wdl: null },
              sanMoves: ["e5"],
              uciMoves: ["e7e5"],
            },
          ],
        ],
      ]),
    );
    h.store.set(engineProgressFamily({ tab: "display-tab", engine: displayEngine.id }), 65);
  });
  await h.render(panel());
  expect(h.host.querySelector("[data-fen]")?.getAttribute("data-fen")).toBe(
    analysisSearch(INITIAL_FEN, [], true).searchedBoardFen,
  );
  expect(h.host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("65");
  await h.render(panel([], "4k3/8/8/8/8/8/4r3/4K3 w - - 0 7"));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(h.host.textContent).toContain("Board.Analysis.NoAnalysisAvailable");
  for (const text of ["Common.Loading", "Board.Analysis.EngineFailed", "n/s", "e5"])
    expect(h.host.textContent).not.toContain(text);
  expect(h.host.querySelector("[data-fen]")).toBeNull();
  expect(h.host.querySelector("[data-animated]")).toBeNull();
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
  expect(h.store.get(threatFamily("display-tab"))).toBe(true);
  // The mode is still on while its lines are unavailable, so the card still says so.
  expect(h.host.querySelector('[data-testid="threat-badge"]')).not.toBeNull();
  expect(h.store.get(h.settingsAtom).enabled).toBe(true);
  expect(h.store.get(engineProgressFamily({ tab: "display-tab", engine: displayEngine.id }))).toBe(
    65,
  );
  expect(h.host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
  await h.render(panel());
  expect(h.host.querySelector("[data-fen]")).not.toBeNull();
  expect(h.host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("65");
});

test("threat mode labels the card and switches its accent to the threat colour", async () => {
  await h.remember();
  await h.render(panel());
  const card = () => h.host.querySelector<HTMLElement>("[style*='--cf-engine-status']")!;
  expect(h.host.querySelector('[data-testid="threat-badge"]')).toBeNull();
  expect(card().style.getPropertyValue("--cf-engine-status")).toBe("var(--mantine-color-blue-6)");
  await act(async () => h.store.set(threatFamily("display-tab"), true));
  expect(h.host.querySelector('[data-testid="threat-badge"]')?.textContent).toBe(
    "Board.Analysis.ThreatMode",
  );
  expect(card().style.getPropertyValue("--cf-engine-status")).toBe("var(--cf-destructive)");
  await act(async () => h.store.set(h.settingsAtom, (s: Settings) => ({ ...s, enabled: false })));
  expect(card().style.getPropertyValue("--cf-engine-status")).toBe("var(--cf-border-strong)");
  expect(h.host.querySelector('[data-testid="threat-badge"]')).not.toBeNull();
  await act(async () => h.store.set(threatFamily("display-tab"), false));
  expect(h.host.querySelector('[data-testid="threat-badge"]')).toBeNull();
});

test("threat rows use the shared searched board once and keep its numbering anchor during fallback", async () => {
  const fen = "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 7";
  const source = analysisSearch(fen, ["d7d5"], true);
  await act(async () => {
    h.store.set(threatFamily("display-tab"), true);
    h.store.set(
      h.memoryAtom,
      new Map([
        [
          source.key!,
          [
            {
              depth: 20,
              multipv: 1,
              nodes: 1n,
              nps: 1n,
              score: { value: { type: "cp", value: 34 }, wdl: null },
              sanMoves: ["d4"],
              uciMoves: ["d5d4"],
            },
          ],
        ],
      ]),
    );
  });
  await h.render(panel(["d7d5"], fen, 14));
  expect(h.host.querySelector("[data-fen]")?.getAttribute("data-fen")).toBe(
    source.searchedBoardFen,
  );
  await h.render(panel(["d7d6"], fen, 20));
  const row = h.host.querySelector('[data-inert="true"]');
  expect(row?.getAttribute("data-fen")).toBe("4k3/8/8/3pP3/8/8/8/4K3 b - - 0 8");
  expect(row?.getAttribute("data-ply")).toBe("14");
});

test("first start has neither skeleton rows nor Loading at 999 ms and has both at 1000 ms", async () => {
  await h.render(panel());
  await act(async () => vi.advanceTimersByTime(999));
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
  expect(h.host.textContent).not.toContain("Common.Loading");
  await act(async () => vi.advanceTimersByTime(1));
  expect(h.host.querySelectorAll(".mantine-Skeleton-root")).toHaveLength(1);
  expect(h.host.textContent).toContain("Common.Loading");
});

test.each([0, 1000])(
  "a marked key leaves the lines area empty without fallback, skeleton or Loading when marked at %i ms",
  async (elapsed) => {
    await h.remember();
    await h.render(panel());
    const moves = ["d2d4"];
    await h.render(panel(moves));
    await act(async () => vi.advanceTimersByTime(elapsed));
    await act(async () =>
      h.store.set(
        engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }),
        terminal(moves),
      ),
    );
    expect(h.host.querySelector('[data-inert="true"]')).toBeNull();
    expect(h.host.querySelector("tbody")?.children).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
    expect(h.host.textContent).not.toContain("Common.Loading");
    expect(h.host.textContent).not.toContain("Board.Analysis.NoAnalysisAvailable");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(h.host.querySelector("tbody")?.children).toHaveLength(0);
    expect(h.host.textContent).not.toContain("Common.Loading");
  },
);

test("position change with previous lines renders dimmed inert rows without skeleton or badge and replaces them on result", async () => {
  await h.remember();
  await h.render(panel());
  await h.render(panel(["d2d4"]));
  expect(h.host.querySelector('[data-inert="true"]')?.textContent).toBe("e4 e5 Nf3");
  expect(h.host.querySelector('[data-inert="true"]')?.getAttribute("data-fen")).toBe(INITIAL_FEN);
  expect(h.host.querySelector('[style*="opacity: 0.5"]')).not.toBeNull();
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
  expect(h.host.textContent).not.toContain("Common.Loading");
  await h.remember(undefined, ["d2d4"]);
  expect(h.host.querySelector('[data-inert="true"]')).toBeNull();
});

test("inactive and no-analysis messages take precedence over delayed loading in the rendered panel", async () => {
  await act(async () => h.store.set(h.settingsAtom, (s) => ({ ...s, enabled: false })));
  await h.render(panel());
  await act(async () => vi.advanceTimersByTime(1000));
  expect(h.host.textContent).toContain("Board.Analysis.InactiveEngine");
  expect(h.host.textContent).not.toContain("Common.Loading");
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
  await act(async () => h.store.set(h.settingsAtom, (s) => ({ ...s, enabled: true })));
  await h.remember([]);
  await act(async () => vi.advanceTimersByTime(1000));
  expect(h.host.textContent).toContain("Board.Analysis.NoAnalysisAvailable");
  expect(h.host.textContent).not.toContain("Common.Loading");
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
});

test.each([false, true])(
  "P2 failure ends loading, progress and speed, partial lines %s",
  async (partial) => {
    if (partial) await h.remember();
    await h.render(panel());
    await act(async () =>
      h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
        ...terminal(),
        type: "failed",
        snapshot: {
          kind: "process-exit",
          exitStatus: { code: 1, signal: null },
          reason: "<b>Safe failure</b>",
          entries: [],
        },
      }),
    );
    await act(async () => vi.advanceTimersByTime(5000));
    expect(h.host.textContent).toContain("Board.Analysis.EngineFailed");
    expect(h.host.textContent).toContain("<b>Safe failure</b>");
    expect(h.host.querySelector("b")).toBeNull();
    expect(h.host.textContent).not.toContain("n/s");
    expect(h.host.textContent).not.toContain("Common.Loading");
    expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
    expect(h.host.querySelector('[data-animated="true"]')).toBeNull();
    expect(h.host.querySelector('[data-inert="true"]') !== null).toBe(partial);
    const settings = h.store.get(h.settingsAtom);
    await act(async () =>
      [...h.host.querySelectorAll("button")]
        .find((b) => b.textContent === "Board.Analysis.RetryEngine")!
        .click(),
    );
    expect(h.store.get(engineRetryFamily({ tab: "display-tab", engine: displayEngine.id }))).toBe(
      1,
    );
    expect(h.store.get(h.settingsAtom)).toBe(settings);
    expect(h.host.textContent).not.toContain("Board.Analysis.EngineFailed");
  },
);

test("failed BestMoves shows the reason and the cleanup warning", async () => {
  await h.render(panel());
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
      cleanupFailed: true,
      message: "Engine failed. Temporary cleanup also failed",
      snapshot: {
        kind: "process-exit",
        exitStatus: null,
        reason: "Safe engine reason",
        entries: [],
      },
    }),
  );
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(
    "Safe engine reason Board.Analysis.EngineCleanupFailed",
  );
});

test("a failed local engine opens its logs from the failure state", async () => {
  await h.render(panel());
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
      snapshot: { kind: "process-exit", exitStatus: null, reason: "Safe reason", entries: [] },
    }),
  );
  expect(h.host.querySelector('[data-testid="engine-logs-dialog"]')).toBeNull();
  const status = h.host.querySelector('[role="status"]')!;
  await act(async () =>
    [...status.querySelectorAll("button")]
      .find((b) => b.textContent === "Board.Analysis.Logs")!
      .click(),
  );
  expect(h.host.querySelector('[data-testid="engine-logs-dialog"]')?.textContent).toContain(
    displayEngine.id,
  );
});

test("a failure without a snapshot renders its retained safe message once", async () => {
  const raw = "Cannot launch /home/felixb/engines/stockfish token=secret";
  const message = "Cannot launch [path] token=[redacted]";
  const failure = errorUnlessCancelled(new Error(raw))!;
  expect(failure.message).toBe(message);
  await h.render(panel());
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: displayEngine.id }), {
      ...terminal(),
      type: "failed",
      message: failure.message,
    }),
  );
  const status = h.host.querySelector('[role="status"]')!;
  expect(status.textContent?.split(message)).toHaveLength(2);
  expect(status.textContent?.split("Board.Analysis.EngineFailed")).toHaveLength(2);
  expect(status.textContent).not.toContain("/home/felixb/engines/stockfish");
  expect(status.textContent).not.toContain("secret");
  expect(status.textContent).not.toContain("Board.Analysis.EngineDisconnected");
});

test.each([
  { type: "chessdb", coverage: "ChessDB phase 2" },
  { type: "lichess", coverage: "regression coverage" },
  { type: "local", coverage: "regression coverage" },
] as const)(
  "$coverage: passes annotations only for ChessDB and preserves header metrics for $type",
  async ({ type }) => {
    const engine: Engine =
      type === "local"
        ? displayEngine
        : { type, id: displayEngine.id, name: type, url: "", loaded: true };
    const lines: ChessDBLine[] = [
      { ...displayLines[0], chessdb: { note: "! (30-11)", winrate: "49.92" } },
      { ...displayLines[0], multipv: 2, chessdb: { note: "? (12-7)" } },
    ];
    await h.remember(lines);
    await h.render(panel([], INITIAL_FEN, 0, engine));
    const rows = [...h.host.querySelectorAll("[data-fen]")];
    expect(rows).toHaveLength(2);
    const expectedAnnotations = lines.map((line) =>
      type === "chessdb" ? JSON.stringify(line.chessdb) : null,
    );
    expect(rows.map((row) => row.getAttribute("data-chessdb"))).toEqual(expectedAnnotations);
    expect(h.host.textContent).toContain("GoMode.Depth");
    expect(h.host.textContent).toContain("20");
    expect(h.host.textContent).toContain("⩲");
    expect(h.host.textContent).not.toContain("Board.Analysis.Evaluation");
    expect(h.host.textContent).not.toContain("GoMode.Nodes");
    expect(h.host.textContent).not.toContain("n/s");
  },
);

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../../translation/*.json",
  { eager: true, import: "default" },
);
const translatedMessages = {
  "en-US": "This position is not in ChessDB yet.",
  "de-DE": "Diese Stellung ist noch nicht in ChessDB.",
};

test.each(Object.entries(translatedMessages))(
  "ChessDB phase 2 renders the %s not-in-database message only for the searched position",
  async (locale, message) => {
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogues[`../../../translation/${locale}.json`] },
    });
    publication.translate = (key) => i18n.t(key);
    const engine: Engine = {
      type: "chessdb",
      id: displayEngine.id,
      name: "ChessDB",
      url: "",
      loaded: true,
    };
    await act(async () =>
      h.store.set(engineTerminalFamily({ tab: "display-tab", engine: engine.id }), {
        ...terminal([], engine),
        type: "not-in-database",
      }),
    );
    await h.render(panel([], INITIAL_FEN, 0, engine));
    expect(h.host.querySelector("tbody")?.textContent).toBe(message);
    expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
    await h.render(panel(["e2e4"], INITIAL_FEN, 1, engine));
    expect(h.host.textContent).not.toContain(message);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(h.host.querySelector(".mantine-Skeleton-root")).not.toBeNull();
  },
);

test.each(Object.entries(catalogues))(
  "ChessDB phase 2 ships a translated not-in-database message without fallback in %s",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    const key = "Board.Analysis.NotInChessDB";
    expect(i18n.exists(key)).toBe(true);
    expect(i18n.t(key).trim()).not.toBe("");
    expect(i18n.t(key)).not.toBe(key);
  },
);

test("regression coverage: Lichess no-lines terminal keeps the generic empty-state message", async () => {
  const engine: Engine = {
    type: "lichess",
    id: displayEngine.id,
    name: "Lichess",
    url: "",
    loaded: true,
  };
  await act(async () =>
    h.store.set(
      engineTerminalFamily({ tab: "display-tab", engine: engine.id }),
      terminal([], engine),
    ),
  );
  await h.render(panel([], INITIAL_FEN, 0, engine));
  expect(h.host.querySelector("tbody")?.textContent).toBe("Board.Analysis.NoAnalysisAvailable");
  expect(h.host.querySelector(".mantine-Skeleton-root")).toBeNull();
});

test.each([
  { type: "local", opensEnginePage: true },
  { type: "chessdb", opensEnginePage: false },
] as const)(
  "the panel's Settings gear opens the inline form, which links the Engines page only for a $type engine with more there",
  async ({ type, opensEnginePage }) => {
    const engine: Engine =
      type === "local"
        ? displayEngine
        : { type, id: displayEngine.id, name: "ChessDB", url: "", loaded: true };
    publication.realForm = true;
    await h.render(panel([], INITIAL_FEN, 0, engine));
    const gear = h.host.querySelector<HTMLButtonElement>(
      '[aria-label="Board.Analysis.EngineSettings"]',
    )!;
    expect(gear.getAttribute("aria-pressed")).toBe("false");
    await act(async () => gear.click());
    expect(gear.getAttribute("aria-pressed")).toBe("true");
    expect(h.host.querySelector('[aria-label="Engines.Settings.AdvancedSettings"]')).toBeNull();
    expect(
      h.host.querySelector('[aria-label="Engines.Settings.OpenEngineSettings"]') !== null,
    ).toBe(opensEnginePage);
    expect(
      [...h.host.querySelectorAll("button")].some((b) => b.textContent === "Board.Analysis.Logs"),
    ).toBe(opensEnginePage);
  },
);

test("the Settings gear's Logs button opens and closes the local engine's log dialog", async () => {
  await h.render(panel());
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>('[aria-label="Board.Analysis.EngineSettings"]')!
      .click(),
  );
  const button = (label: string) =>
    [...h.host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const dialog = () => h.host.querySelector('[data-testid="engine-logs-dialog"]');
  expect(dialog()).toBeNull();
  await act(async () => button("Board.Analysis.Logs").click());
  expect(dialog()?.textContent).toContain(displayEngine.id);
  await act(async () => button("close-logs").click());
  expect(dialog()).toBeNull();
});

test("a failed cloud engine offers Retry but no logs", async () => {
  const engine: Engine = {
    type: "chessdb",
    id: displayEngine.id,
    name: "ChessDB",
    url: "",
    loaded: true,
  };
  await h.render(panel([], INITIAL_FEN, 0, engine));
  await act(async () =>
    h.store.set(engineTerminalFamily({ tab: "display-tab", engine: engine.id }), {
      ...terminal([], engine),
      type: "failed",
      message: "Cloud engine failed",
    }),
  );
  const status = h.host.querySelector('[role="status"]')!;
  const labels = [...status.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels).toContain("Board.Analysis.RetryEngine");
  expect(labels).not.toContain("Board.Analysis.Logs");
});

test("line selector writes MultiPV directly and hides when MultiPV option is absent", async () => {
  const withMultiPv: Engine = {
    ...displayEngine,
    settings: [{ type: "string", name: "MultiPV", value: "2" }],
  };
  await h.store.set(enginesAtom, [withMultiPv]);
  h.store.set(h.settingsAtom, (prev) => ({
    ...prev,
    synced: false,
    settings: [{ type: "string", name: "MultiPV", value: "2" }],
  }));
  await h.render(panel([], INITIAL_FEN, 0, withMultiPv));

  const fourRadio = h.host.querySelector<HTMLInputElement>('input[type="radio"][value="4"]')!;
  expect(fourRadio).not.toBeNull();
  await act(async () => {
    fourRadio.click();
  });
  const stored = h.store.get(
    tabEngineSettingsFamily({ tab: "display-tab", engineId: withMultiPv.id }),
  );
  const multiPvOption = stored.settings.find(
    (o): o is { type: "string"; name: string; value: string } =>
      o.type === "string" && o.name === "MultiPV",
  );
  expect(multiPvOption?.value).toBe("4");

  const withoutMultiPv: Engine = { ...displayEngine, settings: [] };
  await h.store.set(enginesAtom, [withoutMultiPv]);
  h.store.set(h.settingsAtom, (prev) => ({ ...prev, synced: false, settings: [] }));
  await h.render(panel([], INITIAL_FEN, 0, withoutMultiPv));
  expect(h.host.querySelector('input[type="radio"]')).toBeNull();
});

test("collapse button toggles only its own id in expandedEnginesFamily", async () => {
  const first = { ...displayEngine, name: "First", loaded: true };
  const second = { ...displayEngine, id: "eng-2", name: "Second", loaded: true };
  await h.store.set(enginesAtom, [first, second]);
  await h.remember(displayLines);
  await h.render(panel([], INITIAL_FEN, 0, first));

  expect(h.store.get(expandedEnginesFamily("display-tab"))).toBeUndefined();
  expect(h.host.querySelectorAll("[data-fen]")).toHaveLength(1);

  const collapseBtn = h.host.querySelector<HTMLButtonElement>(
    'button[aria-label="Board.Analysis.Collapse"]',
  )!;
  await act(async () => collapseBtn.click());
  // Only first was collapsed; eng-2 stays expanded.
  expect(h.store.get(expandedEnginesFamily("display-tab"))).toEqual(["eng-2"]);
  expect(h.host.querySelectorAll("[data-fen]")).toHaveLength(0);

  const expandBtn = h.host.querySelector<HTMLButtonElement>(
    'button[aria-label="Board.Analysis.Expand"]',
  )!;
  await act(async () => expandBtn.click());
  expect(h.store.get(expandedEnginesFamily("display-tab"))).toEqual(["eng-2", first.id]);
  expect(h.host.querySelectorAll("[data-fen]")).toHaveLength(1);
});

test("settings gear opens settings form under the top row, and × appears only in window mode with one grip, name and ×", async () => {
  const onReturn = vi.fn();
  const onStartPlacing = vi.fn();
  await h.store.set(enginesAtom, [displayEngine]);

  // Panel mode: no × button.
  await h.render(panel([], INITIAL_FEN, 0, displayEngine));
  expect(h.host.querySelector('button[aria-label="Board.Area.ReturnToEngines"]')).toBeNull();
  expect(h.host.querySelectorAll("[data-arrange-grip]")).toHaveLength(1);

  // Settings gear toggles pressed state.
  const settingsBtn = h.host.querySelector<HTMLButtonElement>(
    'button[aria-label="Board.Analysis.EngineSettings"]',
  )!;
  expect(settingsBtn.getAttribute("aria-pressed")).toBe("false");
  await act(async () => settingsBtn.click());
  expect(settingsBtn.getAttribute("aria-pressed")).toBe("true");

  // Window mode: exactly one grip, one engine name, and one × button.
  await h.render(
    <BestMoves
      id={1}
      engine={displayEngine}
      fen={INITIAL_FEN}
      moves={[]}
      halfMoves={0}
      orientation="white"
      mode="window"
      onReturn={onReturn}
      onStartPlacing={onStartPlacing}
    />,
  );
  expect(h.host.querySelectorAll("[data-arrange-grip]")).toHaveLength(1);
  const closeBtns = h.host.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Board.Area.ReturnToEngines"]',
  );
  expect(closeBtns).toHaveLength(1);
  await act(async () => closeBtns[0].click());
  expect(onReturn).toHaveBeenCalledTimes(1);
  await act(async () => {
    h.host.querySelector<HTMLButtonElement>("[data-arrange-grip]")!.click();
  });
  expect(onStartPlacing).toHaveBeenCalledTimes(1);
});

test("collapse after a prior toggle removes only the toggled id from an explicit array", async () => {
  const first = { ...displayEngine, id: "a", name: "Engine A", loaded: true };
  const second = { ...displayEngine, id: "b", name: "Engine B", loaded: true };
  await h.store.set(enginesAtom, [first, second]);
  h.store.set(expandedEnginesFamily("display-tab"), ["a", "b"]);
  await h.render(panel([], INITIAL_FEN, 0, first));

  const collapseBtn = h.host.querySelector<HTMLButtonElement>(
    'button[aria-label="Board.Analysis.Collapse"]',
  )!;
  await act(async () => collapseBtn.click());
  expect(h.store.get(expandedEnginesFamily("display-tab"))).toEqual(["b"]);
});

test("panel-mode grip menu disables end move items, invokes onMoveDown, and gates Show as its own area", async () => {
  vi.useRealTimers();
  const onMoveUp = vi.fn();
  const onMoveDown = vi.fn();
  const onShowAsArea = vi.fn();
  await h.store.set(enginesAtom, [displayEngine]);

  const openMenu = async () => {
    const grip = h.host.querySelector<HTMLButtonElement>("[data-arrange-grip]")!;
    await act(async () => grip.click());
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
    );
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  };

  // First card with canShowAsArea=true: Move up disabled, Move down enabled, Show as its own area present.
  await h.render(
    <BestMoves
      id={0}
      engine={displayEngine}
      fen={INITIAL_FEN}
      moves={[]}
      halfMoves={0}
      orientation="white"
      mode="panel"
      canMoveUp={false}
      canMoveDown={true}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      canShowAsArea={true}
      onShowAsArea={onShowAsArea}
    />,
  );
  let items = await openMenu();
  const findItem = (label: string) => items.find((item) => item.textContent === label);
  expect(findItem("Board.Analysis.MoveUp")?.disabled).toBe(true);
  expect(findItem("Board.Analysis.MoveDown")?.disabled).toBe(false);
  expect(findItem("Board.Analysis.ShowAsOwnArea")).toBeDefined();
  await act(async () => findItem("Board.Analysis.MoveDown")!.click());
  expect(onMoveDown).toHaveBeenCalledTimes(1);

  // Last card with canShowAsArea=false: Move up enabled, Move down disabled, Show as its own area absent.
  await h.render(
    <BestMoves
      id={0}
      engine={displayEngine}
      fen={INITIAL_FEN}
      moves={[]}
      halfMoves={0}
      orientation="white"
      mode="panel"
      canMoveUp={true}
      canMoveDown={false}
      onMoveUp={onMoveUp}
      onMoveDown={onMoveDown}
      canShowAsArea={false}
      onShowAsArea={onShowAsArea}
    />,
  );
  items = await openMenu();
  expect(findItem("Board.Analysis.MoveUp")?.disabled).toBe(false);
  expect(findItem("Board.Analysis.MoveDown")?.disabled).toBe(true);
  expect(findItem("Board.Analysis.ShowAsOwnArea")).toBeUndefined();
});
