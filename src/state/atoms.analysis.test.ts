import { createStore } from "jotai";
import { INITIAL_FEN } from "chessops/fen";
import { expect, test, vi } from "vitest";
vi.mock("@/platform/tauri", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/platform/tauri")>();
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            reconcileEngineAttachments: vi.fn().mockResolvedValue(undefined),
        },
    };
});
import type { BestMoves } from "@/bindings";
import { analysisSearch } from "@/components/panels/analysis/analysisSearch";
import {
    AnalysisLineMemory,
    ENGINE_LINE_MEMORY_CAPACITY,
} from "@/components/panels/analysis/analysisLineMemory";
import {
    activeTabAtom,
    allEnabledFamily,
    enableAllFamily,
    createBestMovesAtom,
    threatFamily,
    disposeTabAtoms,
    engineMovesFamily,
    engineTerminalFamily,
    engineRetryFamily,
    gameInterruptionFamily,
    type AnalysisTerminal,
    enginesAtom,
    createFirstEngineWithLinesAtom,
    tabsAtom,
    tabEngineSettingsFamily,
} from "./atoms";

const engine = {
    type: "local" as const,
    id: "normal-engine",
    name: "Same name",
    version: "17",
    filename: "stockfish",
    handle: { id: { id: "same-handle" }, kind: "engine" as const },
    loaded: true,
};

test("synced settings derive committed defaults without a visual owner and preserve tab identity and isolation", async () => {
    const store = createStore();
    const param = {
        tab: "shared-defaults",
        engineId: engine.id,
        defaultGo: { t: "Depth" as const, c: 3 },
    };
    const settings = tabEngineSettingsFamily(param);
    expect(store.get(settings).go).toEqual(param.defaultGo);
    await store.set(enginesAtom, [
        {
            ...engine,
            go: { t: "Depth", c: 10 },
            settings: [{ type: "string", name: "Hash", value: "64" }],
        },
    ]);
    store.set(settings, (current) => ({ ...current, enabled: true }));
    const other = tabEngineSettingsFamily({ tab: "isolated-defaults", engineId: engine.id });
    store.set(other, { enabled: false, synced: false, settings: [], go: { t: "Depth", c: 7 } });
    await store.set(enginesAtom, (current) =>
        current.map((item) => ({ ...item, go: { t: "Depth", c: 20 }, settings: undefined })),
    );
    expect(store.get(settings)).toEqual({
        enabled: true,
        synced: true,
        go: { t: "Depth", c: 20 },
        settings: [],
    });
    expect(store.get(other)).toEqual({
        enabled: false,
        synced: false,
        go: { t: "Depth", c: 7 },
        settings: [],
    });
    await store.set(enginesAtom, (current) => current.map((item) => ({ ...item, go: undefined })));
    expect(store.get(settings).go).toEqual({ t: "Infinite" });
    expect(tabEngineSettingsFamily({ ...param, defaultGo: { t: "Infinite" } })).toBe(settings);
    disposeTabAtoms(param.tab);
    expect(tabEngineSettingsFamily(param)).not.toBe(settings);
    expect(tabEngineSettingsFamily({ tab: "isolated-defaults", engineId: engine.id })).toBe(other);
    disposeTabAtoms(param.tab);
    disposeTabAtoms("isolated-defaults");
});

test("game interruption belongs to one tab and is reclaimed on disposal", () => {
    const store = createStore();
    const owner = "interrupted-game-owner";
    const other = "interrupted-game-other";
    const ownerAtom = gameInterruptionFamily(owner);
    store.set(ownerAtom, {
        type: "interrupted",
        reason: "engineTaskFailed",
        snapshot: null,
        engineColor: "black",
    });
    expect(store.get(gameInterruptionFamily(owner))).toBe(store.get(ownerAtom));
    expect(store.get(gameInterruptionFamily(other))).toBeNull();
    disposeTabAtoms(owner);
    expect(Array.from(gameInterruptionFamily.getParams())).not.toContain(owner);
    expect(gameInterruptionFamily(owner)).not.toBe(ownerAtom);
    expect(store.get(gameInterruptionFamily(owner))).toBeNull();
    disposeTabAtoms(owner);
    disposeTabAtoms(other);
});
const lines = (uci: string): BestMoves[] => [
    {
        depth: 20,
        multipv: 1,
        score: { value: { type: "cp", value: 10 }, wdl: null },
        nodes: 1n,
        nps: 1n,
        uciMoves: [uci],
        sanMoves: [],
    },
];

test("best-move arrows reuse the Map for deeper identical lines while analysis keeps the new payload", async () => {
    const store = createStore();
    const tab = "analysis-arrow-depth-reuse";
    await store.set(enginesAtom, [engine]);
    const source = engineMovesFamily({ tab, engine: engine.id });
    const key = analysisSearch(INITIAL_FEN, [], false).key!;
    const arrows = createBestMovesAtom(tab, INITIAL_FEN, []);
    const initial = lines("e2e4");
    store.set(source, new AnalysisLineMemory(new Map([[key, initial]])));
    const before = store.get(arrows);
    expect(before.size).toBe(1);
    const deeper = initial.map((line) => ({
        ...line,
        depth: line.depth + 5,
        nodes: line.nodes + 100n,
        uciMoves: [...line.uciMoves],
        score: { ...line.score, value: { ...line.score.value } },
    }));
    store.set(source, new AnalysisLineMemory(new Map([[key, deeper]])));
    expect(store.get(arrows)).toBe(before);
    expect(store.get(source).get(key)).toBe(deeper);
    expect(store.get(source).get(key)?.[0]).toMatchObject({ depth: 25, nodes: 101n });
    disposeTabAtoms(tab);
});

test.each(["PV", "score"] as const)(
    "best-move arrows replace the reused Map when the %s changes",
    async (change) => {
        const store = createStore();
        const tab = `analysis-arrow-change-${change}`;
        await store.set(enginesAtom, [engine]);
        const source = engineMovesFamily({ tab, engine: engine.id });
        const key = analysisSearch(INITIAL_FEN, [], false).key!;
        const arrows = createBestMovesAtom(tab, INITIAL_FEN, []);
        store.set(source, new Map([[key, lines("e2e4")]]));
        const before = store.get(arrows);
        store.set(source, new Map([[key, lines("e2e4")]]));
        expect(store.get(arrows)).toBe(before);
        const changed = lines(change === "PV" ? "d2d4" : "e2e4");
        if (change === "score") changed[0].score.value = { type: "cp", value: 100 };
        store.set(source, new Map([[key, changed]]));
        const after = store.get(arrows);
        expect(after).not.toBe(before);
        expect(after.get(0)?.[0].pv).toEqual(changed[0].uciMoves);
        const beforeWinChance = before.get(0)![0].winChance;
        const afterWinChance = after.get(0)![0].winChance;
        expect(afterWinChance >= beforeWinChance).toBe(true);
        expect(afterWinChance === beforeWinChance).toBe(change === "PV");
        disposeTabAtoms(tab);
    },
);

test("best-move arrows reuse empty Maps for missing lines and unavailable searches", async () => {
    const store = createStore();
    const tab = "analysis-arrow-empty-reuse";
    await store.set(enginesAtom, []);
    const arrows = createBestMovesAtom(tab, INITIAL_FEN, []);
    const empty = store.get(arrows);
    await store.set(enginesAtom, [engine]);
    expect(store.get(arrows)).toBe(empty);
    store.set(engineMovesFamily({ tab, engine: engine.id }), new Map());
    expect(store.get(arrows)).toBe(empty);

    const checkedFen = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 7";
    store.set(threatFamily(tab), true);
    const unavailable = createBestMovesAtom(tab, checkedFen, []);
    const unavailableEmpty = store.get(unavailable);
    await store.set(enginesAtom, [{ ...engine, loaded: false }]);
    expect(store.get(unavailable)).toBe(unavailableEmpty);
    disposeTabAtoms(tab);
});

test("both atoms select only the current mode with coexisting normal and threat entries", async () => {
    const store = createStore();
    const tab = "analysis-mode-selection";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tab);
    const threatEngine = { ...engine, id: "threat-engine" };
    await store.set(enginesAtom, [engine, threatEngine]);
    const normal = analysisSearch(INITIAL_FEN, ["e2e4"], false).key!;
    const threat = analysisSearch(INITIAL_FEN, ["e2e4"], true).key!;
    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new AnalysisLineMemory(new Map([[normal, lines("e7e5")]])),
    );
    store.set(
        engineMovesFamily({ tab, engine: threatEngine.id }),
        new AnalysisLineMemory(new Map([[threat, lines("d2d4")]])),
    );
    const position = { fen: INITIAL_FEN, gameMoves: ["e2e4"] };
    store.set(threatFamily(tab), false);
    expect(store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves))).toBe(
        engine.id,
    );
    expect([...store.get(createBestMovesAtom(tab, position.fen, position.gameMoves))]).toEqual([
        [0, [{ pv: ["e7e5"], winChance: expect.any(Number) }]],
    ]);
    store.set(threatFamily(tab), true);
    expect(store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves))).toBe(
        threatEngine.id,
    );
    expect([...store.get(createBestMovesAtom(tab, position.fen, position.gameMoves))]).toEqual([
        [1, [{ pv: ["d2d4"], winChance: expect.any(Number) }]],
    ]);
    store.set(threatFamily(tab), false);
    expect(store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves))).toBe(
        engine.id,
    );
    expect(
        store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).get(0)?.[0].pv,
    ).toEqual(["e7e5"]);
    disposeTabAtoms(tab);
});

test("line atoms read their owner at the same position while another tab is active", async () => {
    const store = createStore();
    store.set(
        tabsAtom,
        ["A", "B"].map((value) => ({
            value,
            name: value,
            type: "analysis" as const,
            gameOrigin: { kind: "none" as const },
        })),
        "B",
    );
    const otherEngine = { ...engine, id: "other-engine" };
    await store.set(enginesAtom, [engine, otherEngine]);
    const moves = ["e2e4"];
    const key = analysisSearch(INITIAL_FEN, moves, false).key!;
    store.set(engineMovesFamily({ tab: "A", engine: engine.id }), new Map([[key, lines("e7e5")]]));
    store.set(
        engineMovesFamily({ tab: "B", engine: otherEngine.id }),
        new Map([[key, lines("c7c5")]]),
    );
    const ownerLines = createBestMovesAtom("A", INITIAL_FEN, moves);
    const ownerEngine = createFirstEngineWithLinesAtom("A", INITIAL_FEN, moves);
    expect(store.get(activeTabAtom)).toBe("B");
    expect([...store.get(ownerLines)]).toEqual([
        [0, [{ pv: ["e7e5"], winChance: expect.any(Number) }]],
    ]);
    expect(store.get(ownerEngine)).toBe(engine.id);
    expect([...store.get(createBestMovesAtom("B", INITIAL_FEN, moves))]).toEqual([
        [1, [{ pv: ["c7c5"], winChance: expect.any(Number) }]],
    ]);
    expect(store.get(createFirstEngineWithLinesAtom("B", INITIAL_FEN, moves))).toBe(otherEngine.id);
    disposeTabAtoms("A");
    disposeTabAtoms("B");
});

test("enable-all families target the owner and dispose only the closed tab", async () => {
    const store = createStore();
    store.set(
        tabsAtom,
        ["A", "B"].map((value) => ({
            value,
            name: value,
            type: "analysis" as const,
            gameOrigin: { kind: "none" as const },
        })),
        "B",
    );
    await store.set(enginesAtom, [engine]);
    const ownerEnabled = allEnabledFamily("A");
    const ownerEnable = enableAllFamily("A");
    const neighbourEnabled = allEnabledFamily("B");
    const neighbourEnable = enableAllFamily("B");
    expect(store.get(ownerEnabled)).toBe(false);
    expect(store.get(neighbourEnabled)).toBe(false);
    store.set(ownerEnable, true);
    expect(store.get(ownerEnabled)).toBe(true);
    expect(store.get(neighbourEnabled)).toBe(false);
    disposeTabAtoms("A");
    expect([...allEnabledFamily.getParams()]).not.toContain("A");
    expect([...enableAllFamily.getParams()]).not.toContain("A");
    expect(allEnabledFamily("B")).toBe(neighbourEnabled);
    expect(enableAllFamily("B")).toBe(neighbourEnable);
    disposeTabAtoms("B");
});

test("threat at A, navigate away, threat off, return to A exposes no threat arrows or score owner", async () => {
    const store = createStore();
    const tab = "analysis-return-mode";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tab);
    await store.set(enginesAtom, [engine]);
    store.set(threatFamily(tab), true);
    const position = { fen: INITIAL_FEN, gameMoves: ["e2e4"] };
    const memory = new AnalysisLineMemory();
    memory.set(analysisSearch(position.fen, position.gameMoves, true).key!, lines("d2d4"));
    store.set(engineMovesFamily({ tab, engine: engine.id }), memory);
    expect(store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves))).toBe(
        engine.id,
    );
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(1);
    expect(store.get(createBestMovesAtom(tab, INITIAL_FEN, ["d2d4"])).size).toBe(0);
    store.set(threatFamily(tab), false);
    expect(
        store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves)),
    ).toBeNull();
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(0);
    expect(memory.size).toBe(1);
    disposeTabAtoms(tab);
});

test("atom display selection refreshes LRU recency and tab close disposes line memory", async () => {
    const store = createStore();
    const tab = "analysis-lru-tab-close";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tab);
    await store.set(enginesAtom, [engine]);
    store.set(threatFamily(tab), false);
    const position = { fen: INITIAL_FEN, gameMoves: [] };
    const key = analysisSearch(position.fen, position.gameMoves, false).key!;
    const memory = new AnalysisLineMemory();
    memory.set(key, lines("e2e4"));
    for (let i = 0; i < ENGINE_LINE_MEMORY_CAPACITY - 1; i++) memory.set(String(i), lines("d2d4"));
    const param = { tab, engine: engine.id };
    store.set(engineMovesFamily(param), memory);
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(1);
    memory.set("new", lines("g1f3"));
    expect(memory.has(key)).toBe(true);
    expect(memory.has("0")).toBe(false);
    expect(store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves))).toBe(
        engine.id,
    );
    disposeTabAtoms(tab);
    expect(store.get(engineMovesFamily(param)).size).toBe(0);
    expect(store.get(engineMovesFamily(param))).toBeInstanceOf(AnalysisLineMemory);
    disposeTabAtoms(tab);
});

function terminal(searchedKey: string): AnalysisTerminal {
    return {
        type: "completed-without-lines",
        searchedKey,
        context: "context",
        fingerprint: "attempt",
        engineIdentity: "engine",
        generation: "generation",
        retry: 0,
    };
}

test("terminal no-lines atoms are independent per tab and engine and disposed with their tab", () => {
    const owner = { tab: "terminal-owner", engine: "same-name-1" };
    const sibling = { tab: owner.tab, engine: "same-name-2" };
    const otherTab = { tab: "terminal-other", engine: owner.engine };
    const store = createStore();
    const oldAtom = engineTerminalFamily(owner);
    const oldRetry = engineRetryFamily(owner);
    store.set(oldRetry, 2);
    store.set(oldAtom, terminal("position-a:"));
    store.set(engineTerminalFamily(sibling), terminal("position-b:"));
    store.set(engineTerminalFamily(otherTab), terminal("position-c:"));
    expect(store.get(engineTerminalFamily(owner))).toEqual(terminal("position-a:"));
    expect(store.get(engineTerminalFamily(sibling))).toEqual(terminal("position-b:"));
    disposeTabAtoms(owner.tab);
    expect(engineTerminalFamily(owner)).not.toBe(oldAtom);
    expect(engineRetryFamily(owner)).not.toBe(oldRetry);
    expect(store.get(engineRetryFamily(owner))).toBe(0);
    expect(store.get(engineTerminalFamily(owner))).toBeNull();
    expect(store.get(engineTerminalFamily(sibling))).toBeNull();
    expect(store.get(engineTerminalFamily(otherTab))).toEqual(terminal("position-c:"));
    disposeTabAtoms(owner.tab);
    disposeTabAtoms(otherTab.tab);
});

test("line readers ignore unloaded engines and empty entries with no active tab or engine list", async () => {
    const store = createStore();
    const tab = "analysis-reader-guards";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    const position = { fen: INITIAL_FEN, gameMoves: [] };
    store.set(activeTabAtom, null);
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(0);
    expect(
        store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves)),
    ).toBeNull();
    store.set(activeTabAtom, tab);
    store.set(threatFamily(tab), false);

    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(0);
    expect(
        store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves)),
    ).toBeNull();
    await store.set(enginesAtom, [{ ...engine, loaded: false }]);
    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new Map([[`${INITIAL_FEN}:`, lines("e2e4")]]),
    );
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(0);
    expect(
        store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves)),
    ).toBeNull();
    await store.set(enginesAtom, [engine]);
    store.set(engineMovesFamily({ tab, engine: engine.id }), new Map([[`${INITIAL_FEN}:`, []]]));
    expect(store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).size).toBe(0);
    expect(
        store.get(createFirstEngineWithLinesAtom(tab, position.fen, position.gameMoves)),
    ).toBeNull();
    disposeTabAtoms(tab);
});

test("threat arrows compare White-perspective scores against the searched turn and normal mode stays unchanged", async () => {
    const store = createStore();
    const tab = "analysis-threat-score-perspective";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tab);
    await store.set(enginesAtom, [engine]);
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3";
    const mate = lines("h5f7")[0];
    mate.score.value = { type: "mate", value: 1 };
    mate.sanMoves = ["Qxf7#"];
    const inferior = lines("a2a3")[0];
    inferior.score.value = { type: "cp", value: 0 };
    inferior.sanMoves = ["a3"];
    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new AnalysisLineMemory(
            new Map([
                [analysisSearch(fen, [], true).key!, [mate, inferior]],
                [analysisSearch(fen, [], false).key!, [mate, inferior]],
            ]),
        ),
    );
    const position = { fen, gameMoves: [] };
    store.set(threatFamily(tab), true);
    const threats = store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).get(0)!;
    expect(threats.map((line) => line.pv)).toEqual([["h5f7"]]);
    expect(threats[0].winChance).toBeGreaterThan(90);
    store.set(threatFamily(tab), false);
    const normal = store.get(createBestMovesAtom(tab, position.fen, position.gameMoves)).get(0)!;
    expect(normal.map((line) => line.pv)).toEqual([["h5f7"], ["a2a3"]]);
    expect(normal[0].winChance).toBeLessThan(10);
    expect(normal[1].winChance).toBe(50);
    disposeTabAtoms(tab);
});

test("unavailable threat returns no arrows or line owner despite poisoned cache and recovers the available key", async () => {
    const store = createStore();
    const tab = "unavailable-threat-arrows";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    await store.set(enginesAtom, [engine]);
    store.set(threatFamily(tab), true);
    const fen = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 7";
    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new Map([
            [analysisSearch(INITIAL_FEN, [], true).key!, lines("e7e5")],
            ["4k3/8/8/8/8/8/4r3/4K3 b - - 0 7:", lines("e2e1")],
            [`${fen}:`, lines("e1e2")],
        ]),
    );
    expect(store.get(createBestMovesAtom(tab, INITIAL_FEN, [])).size).toBe(1);
    expect(store.get(createFirstEngineWithLinesAtom(tab, INITIAL_FEN, []))).toBe(engine.id);
    expect(store.get(createBestMovesAtom(tab, fen, [])).size).toBe(0);
    expect(store.get(createFirstEngineWithLinesAtom(tab, fen, []))).toBeNull();
    store.set(threatFamily(tab), false);
    expect(store.get(createBestMovesAtom(tab, fen, [])).size).toBe(1);
    expect(store.get(createFirstEngineWithLinesAtom(tab, fen, []))).toBe(engine.id);
    store.set(threatFamily(tab), true);
    expect(store.get(createBestMovesAtom(tab, INITIAL_FEN, [])).size).toBe(1);
    expect(store.get(createFirstEngineWithLinesAtom(tab, INITIAL_FEN, []))).toBe(engine.id);
    disposeTabAtoms(tab);
});

test("best-move arrows keep only tablebase-winning dtz lines after normalizing like mate", async () => {
    const store = createStore();
    const tab = "analysis-dtz-arrows";
    store.set(tabsAtom, [
        { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tab);
    await store.set(enginesAtom, [engine]);
    store.set(threatFamily(tab), false);

    const line = (uci: string, value: BestMoves["score"]["value"]): BestMoves => ({
        ...lines(uci)[0],
        score: { value, wdl: null },
    });
    const payload = (sign: 1 | -1): BestMoves[] => [
        line("e2e4", { type: "dtz", value: 12 * sign }),
        line("d2d4", { type: "cp", value: 0 }),
        line("g1f3", { type: "dtz", value: -5 * sign }),
        line("c2c4", { type: "cp", value: -150 * sign }),
    ];

    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new AnalysisLineMemory(
            new Map([[analysisSearch(INITIAL_FEN, [], false).key!, payload(1)]]),
        ),
    );
    expect(
        store
            .get(createBestMovesAtom(tab, INITIAL_FEN, []))
            .get(0)
            ?.map((arrow) => arrow.pv),
    ).toEqual([["e2e4"]]);

    const blackFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    store.set(
        engineMovesFamily({ tab, engine: engine.id }),
        new AnalysisLineMemory(new Map([[analysisSearch(blackFen, [], false).key!, payload(-1)]])),
    );
    expect(
        store
            .get(createBestMovesAtom(tab, blackFen, []))
            .get(0)
            ?.map((arrow) => arrow.pv),
    ).toEqual([["e2e4"]]);

    disposeTabAtoms(tab);
});
