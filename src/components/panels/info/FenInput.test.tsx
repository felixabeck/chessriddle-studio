import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import FenInput from "./FenInput";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./FenSearch", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

const fourFieldEpd = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const staleCastlingFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w KQkq - 0 1";
const mainline = ["e4", "e5", "Nc3"];

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function renderFenInput(currentFen: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MantineProvider>
        <TreeStateContext.Provider value={tree}>
          <FenInput currentFen={currentFen} />
        </TreeStateContext.Provider>
      </MantineProvider>,
    );
  });
}

function prepareRoot(fen: string) {
  tree = createTreeStore();
  tree.getState().setFen(fen);
  expect(tree.getState().makeMoves({ payload: mainline }).success).toBe(true);
  tree.getState().goToStart();
}

test.each([
  { name: "a 4-field EPD root", fen: fourFieldEpd },
  { name: "a root with stale castling rights", fen: staleCastlingFen },
])("mounting FenInput does not rewrite $name or drop its moves", async ({ fen }) => {
  prepareRoot(fen);
  const dirty = tree.getState().dirty;
  const rootFen = tree.getState().root.fen;
  expect(tree.getState().root.children).toHaveLength(1);

  await renderFenInput(rootFen);

  expect(tree.getState().root.children).toHaveLength(1);
  expect(tree.getState().root.fen).toBe(rootFen);
  expect(tree.getState().dirty).toBe(dirty);
});

test("toggling white queenside castling still writes the root FEN", async () => {
  tree = createTreeStore();
  await renderFenInput(INITIAL_FEN);

  const whiteQueensideLabel = [...host.querySelectorAll("label")].find(
    (label) => label.textContent === "O-O-O",
  );
  expect(whiteQueensideLabel).toBeTruthy();
  const queenside =
    whiteQueensideLabel!.parentElement?.parentElement?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
  expect(queenside).toBeTruthy();
  await act(async () => queenside!.click());

  expect(tree.getState().root.fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1");
});
