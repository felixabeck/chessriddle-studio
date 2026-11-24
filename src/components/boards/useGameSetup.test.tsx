import { act } from "react";
import { createRoot } from "react-dom/client";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { afterEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  disposeTabAtoms,
  gameInputColorAtom,
  gamePlayer1SettingsAtom,
  gamePlayer2SettingsAtom,
  playFromHereColorFamily,
  type PlayFromHereColor,
} from "@/state/atoms";
import type { OpponentSettings } from "@/state/opponentSettings";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import {
  assignPlayers,
  nextInputColor,
  playerSideColors,
  seededInputColor,
  sideToMoveFromFen,
  useGameSetup,
} from "./useGameSetup";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/state/atoms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/atoms")>();
  const { atom } = await import("jotai");
  return {
    ...actual,
    gamePlayer1SettingsAtom: atom({ type: "human" as const, name: "Player" }),
    gamePlayer2SettingsAtom: atom({ type: "human" as const, name: "Player" }),
  };
});

test("the colour control cycles white, black, random and back to white", () => {
  expect(nextInputColor("white")).toBe("black");
  expect(nextInputColor("black")).toBe("random");
  expect(nextInputColor("random")).toBe("white");
});

test("player 2 takes the colour player 1 does not, and shares a random draw", () => {
  expect(playerSideColors("white")).toEqual(["white", "black"]);
  expect(playerSideColors("black")).toEqual(["black", "white"]);
  expect(playerSideColors("random")).toEqual(["random", "random"]);
});

test("a fixed colour seats player 1 on it without drawing", () => {
  const draw = () => {
    throw new Error("a fixed colour must not draw");
  };
  expect(assignPlayers("white", "p1", "p2", draw)).toEqual({ white: "p1", black: "p2" });
  expect(assignPlayers("black", "p1", "p2", draw)).toEqual({ white: "p2", black: "p1" });
});

test("a random colour seats player 1 on white only for a draw above one half", () => {
  expect(assignPlayers("random", "p1", "p2", () => 0.75)).toEqual({ white: "p1", black: "p2" });
  expect(assignPlayers("random", "p1", "p2", () => 0.5)).toEqual({ white: "p2", black: "p1" });
});

test.each([
  { side: "white", player1: "human", player2: "human", expected: "white" },
  { side: "white", player1: "human", player2: "engine", expected: "white" },
  { side: "white", player1: "engine", player2: "human", expected: "black" },
  { side: "white", player1: "engine", player2: "engine", expected: "white" },
  { side: "black", player1: "human", player2: "human", expected: "black" },
  { side: "black", player1: "human", player2: "engine", expected: "black" },
  { side: "black", player1: "engine", player2: "human", expected: "white" },
  { side: "black", player1: "engine", player2: "engine", expected: "black" },
] as const)(
  "seededInputColor seats player 1 on $expected when $side to move, player1 $player1, player2 $player2",
  ({ side, player1, player2, expected }) => {
    expect(seededInputColor(side, player1, player2)).toBe(expected);
  },
);

test("sideToMoveFromFen reads the FEN turn, not ply parity", () => {
  expect(sideToMoveFromFen("8/8/8/4k3/8/8/4P3/4K3 b - - 0 1")).toBe("black");
  expect(sideToMoveFromFen("8/8/8/4k3/8/8/4P3/4K3 w - - 0 1")).toBe("white");
});

const TAB_ID = "55555555-5555-4555-8555-555555555555";
const human = (name: string): OpponentSettings => ({ type: "human", name });
const engine = (): OpponentSettings => ({
  type: "engine",
  engine: null,
  go: { t: "Infinite" },
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BLACK_TO_MOVE_FEN = "8/8/8/4k3/8/8/4P3/4K3 b - - 0 1";
const WHITE_TO_MOVE_FEN = "8/8/8/4k3/8/8/4P3/4K3 w - - 0 1";

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let treeStore: TreeStore | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  if (treeStore) {
    closeTreeStore(TAB_ID);
    treeStore = undefined;
  }
  disposeTabAtoms(TAB_ID);
});

async function mountSetup(options: {
  seed?: PlayFromHereColor | null;
  player1?: OpponentSettings;
  player2?: OpponentSettings;
  inputColor?: "white" | "black" | "random";
  prepareTree?: (tree: TreeStore) => void;
}) {
  sessionStorage.clear();
  localStorage.clear();
  const store = createJotaiStore();
  if (options.inputColor) store.set(gameInputColorAtom, options.inputColor);
  if (options.player1) store.set(gamePlayer1SettingsAtom, options.player1);
  if (options.player2) store.set(gamePlayer2SettingsAtom, options.player2);
  if (options.seed !== undefined) store.set(playFromHereColorFamily(TAB_ID), options.seed);
  treeStore = createTreeStore(TAB_ID);
  options.prepareTree?.(treeStore);

  let latest: ReturnType<typeof useGameSetup>;
  function Probe() {
    latest = useGameSetup();
    return null;
  }

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <JotaiProvider store={store}>
        <WorkspaceTabScope tabId={TAB_ID}>
          <TreeStateContext.Provider value={treeStore!}>
            <Probe />
          </TreeStateContext.Provider>
        </WorkspaceTabScope>
      </JotaiProvider>,
    );
  });

  return {
    store,
    tree: treeStore,
    setup: () => latest,
  };
}

function blackToMoveMainline(tree: TreeStore) {
  tree.getState().makeMove({ payload: "e4" });
}

test("a seeded tab whose mainline ends black-to-move seats human P1 on black vs engine P2", async () => {
  const { setup } = await mountSetup({
    seed: { chosen: null },
    player1: human("Alice"),
    player2: engine(),
    prepareTree: blackToMoveMainline,
  });
  expect(setup().player1Side).toBe("Fen.Black");
  expect(setup().getPlayers().black).toMatchObject({ type: "human", name: "Alice" });
  expect(setup().getPlayers().white.type).toBe("engine");
});

test("a seeded tab whose mainline ends black-to-move seats engine P1 on white vs human P2", async () => {
  const { setup } = await mountSetup({
    seed: { chosen: null },
    player1: engine(),
    player2: human("Bob"),
    prepareTree: blackToMoveMainline,
  });
  expect(setup().player1Side).toBe("Fen.White");
  expect(setup().getPlayers().white.type).toBe("engine");
  expect(setup().getPlayers().black).toMatchObject({ type: "human", name: "Bob" });
});

test("switching P2 from engine to human after mount re-derives the seeded colour", async () => {
  const { setup } = await mountSetup({
    seed: { chosen: null },
    player1: engine(),
    player2: engine(),
    prepareTree: blackToMoveMainline,
  });
  expect(setup().player1Side).toBe("Fen.Black");

  await act(async () => {
    await setup().setPlayer2Settings(human("Bob"));
  });

  expect(setup().player1Side).toBe("Fen.White");
  expect(setup().getPlayers().white.type).toBe("engine");
  expect(setup().getPlayers().black).toMatchObject({ type: "human", name: "Bob" });
});

test("cycleColor in a seeded tab writes only the seed's chosen colour", async () => {
  const { store, setup } = await mountSetup({
    seed: { chosen: null },
    player1: human("Alice"),
    player2: engine(),
    inputColor: "white",
    prepareTree: blackToMoveMainline,
  });
  expect(setup().player1Side).toBe("Fen.Black");

  await act(async () => setup().cycleColor());

  expect(store.get(playFromHereColorFamily(TAB_ID))).toEqual({ chosen: "random" });
  expect(store.get(gameInputColorAtom)).toBe("white");
  expect(setup().player1Side).toBe("Board.Opponent.Random");
});

test("without a seed the global colour is used and cycleColor writes the global atom", async () => {
  const { store, setup } = await mountSetup({
    inputColor: "white",
    player1: human("Alice"),
    player2: human("Bob"),
  });
  expect(store.get(playFromHereColorFamily(TAB_ID))).toBeNull();
  expect(setup().player1Side).toBe("Fen.White");

  await act(async () => setup().cycleColor());

  expect(store.get(gameInputColorAtom)).toBe("black");
  expect(store.get(playFromHereColorFamily(TAB_ID))).toBeNull();
  expect(setup().player1Side).toBe("Fen.Black");
});

test("setFen to a white-to-move FEN in a seeded tab re-derives player 1 to white", async () => {
  const { setup, tree } = await mountSetup({
    seed: { chosen: null },
    player1: human("Alice"),
    player2: engine(),
    prepareTree: blackToMoveMainline,
  });
  expect(setup().player1Side).toBe("Fen.Black");

  await act(async () => tree.getState().setFen(WHITE_TO_MOVE_FEN));

  expect(setup().player1Side).toBe("Fen.White");
});

test("a black-to-move root FEN with no moves seats player 1 on black, not ply parity", async () => {
  const { setup } = await mountSetup({
    seed: { chosen: null },
    player1: human("Alice"),
    player2: engine(),
    prepareTree: (tree) => tree.getState().setFen(BLACK_TO_MOVE_FEN),
  });
  expect(treeStore!.getState().position).toEqual([]);
  expect(setup().player1Side).toBe("Fen.Black");
});

test("a seeded tab seats player 1 from the mainline end, not the cursor", async () => {
  const { setup, tree } = await mountSetup({
    seed: { chosen: null },
    player1: human("Alice"),
    player2: engine(),
    prepareTree: (store) => {
      store.getState().makeMoves({ payload: ["e4", "c5"] });
      store.getState().goToMove([0]);
    },
  });
  expect(tree.getState().position).toEqual([0]);
  expect(setup().player1Side).toBe("Fen.White");
});
