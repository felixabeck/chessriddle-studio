import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, expect, test, vi } from "vitest";
import type { OutOpening } from "@/bindings/generated";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { getPGN } from "@/utils/chess";
import FenSearch from "./FenSearch";

const mocks = vi.hoisted(() => ({ searchOpeningName: vi.fn() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, searchOpeningName: mocks.searchOpeningName },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

const standardFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const sicilian: OutOpening = {
  name: "Sicilian Defense",
  fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  chess960: false,
};
const frc: OutOpening = {
  name: "Fischer Random 0",
  fen: "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1",
  chess960: true,
};
const sharedFenOpenings: OutOpening[] = [
  { name: "Starting Position", fen: standardFen, chess960: false },
  { name: "Fischer Random 518", fen: standardFen, chess960: true },
];

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  tree?.dispose();
  mocks.searchOpeningName.mockReset();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

async function setup(openings: OutOpening[]) {
  mocks.searchOpeningName.mockResolvedValue(openings);
  tree = createTreeStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MantineProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TreeStateContext.Provider value={tree}>
            <FenSearch />
          </TreeStateContext.Provider>
        </SWRConfig>
      </MantineProvider>,
    );
  });
}

function input() {
  return host.querySelector("input")!;
}

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(mocks.searchOpeningName).toHaveBeenLastCalledWith(text);
}

async function select(name: string) {
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(name),
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}

async function enter() {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
  });
}

function expectPosition(fen: string, variant?: "Chess960") {
  const state = tree.getState();
  expect(state.root.fen).toBe(fen);
  expect(state.headers.variant).toBe(variant);
  const pgn = getPGN(state.root, {
    headers: state.headers,
    glyphs: true,
    comments: true,
    variations: true,
    extraMarkups: true,
  });
  expect(pgn.match(/\[Variant "[^"]*"\]/g) ?? []).toEqual(variant ? ['[Variant "Chess960"]'] : []);
  expect(input().value).toBe(fen);
}

test("orthodox and FRC suggestions set their own variant and export it faithfully", async () => {
  await setup([sicilian, frc]);
  await type("Sicilian");
  await select(sicilian.name);
  expectPosition(sicilian.fen);

  await type("Fischer");
  await select(frc.name);
  expectPosition(frc.fen, "Chess960");
});

test.each([
  { opening: sicilian, move: "Nf3" },
  { opening: frc, move: "e4" },
])(
  "$opening.name selection retains its variant through a legal $move and Copy PGN",
  async ({ opening, move }) => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await setup([opening]);
    await type(opening.name);
    await select(opening.name);
    await act(async () => tree.getState().makeMove({ payload: move }));
    expect(tree.getState().position).toEqual([0]);
    expect(tree.getState().currentNode().san).toBe(move);

    expect(await tree.getState().copyPgn()).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const pgn = writeText.mock.calls[0][0];
    expect(pgn).toContain(`[FEN "${opening.fen}"]`);
    expect(pgn).toContain(move);
    expect(pgn.includes('[Variant "Chess960"]')).toBe(opening.chess960);
  },
);

test("suggestions sharing the standard FEN remain independently selectable", async () => {
  await setup(sharedFenOpenings);
  await type("Position");
  await select("Fischer Random 518");
  expectPosition(standardFen, "Chess960");

  await type("Starting");
  await select("Starting Position");
  expectPosition(standardFen);
});

test("typed Enter requires exclusively FRC matches and unmatched created FENs clear the variant", async () => {
  await setup(sharedFenOpenings);
  await type("Starting");
  await type(standardFen);
  await enter();
  expectPosition(standardFen);

  mocks.searchOpeningName.mockResolvedValue([frc]);
  await type(frc.fen);
  await enter();
  expectPosition(frc.fen, "Chess960");

  mocks.searchOpeningName.mockResolvedValue([]);
  await type(sicilian.fen);
  await select(sicilian.fen);
  expectPosition(sicilian.fen);
});
