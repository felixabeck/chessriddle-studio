import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import BoardSettingsPreview from "./BoardSettingsPreview";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  boardProps: undefined as any,
}));

vi.mock("@/state/atoms", () => ({
  moveHighlightAtom: "moveHighlight",
  showCoordinatesAtom: "coordinates",
  showDestsAtom: "dests",
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: string) => state.values[atom],
}));
vi.mock("@mantine/core", () => ({
  Box: (props: any) => <div {...props} />,
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: any) => {
    state.boardProps = props;
    return <div data-board />;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

function render(values: Record<string, unknown>) {
  state.values = values;
  act(() => root.render(<BoardSettingsPreview />));
  return state.boardProps;
}

beforeEach(() => {
  state.boardProps = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("shows the last move, the destinations and edge coordinates when they are on", () => {
  const props = render({ moveHighlight: true, coordinates: "edge", dests: true });

  expect(props.viewOnly).toBe(true);
  expect(props.orientation).toBe("white");
  expect(props.drawable).toEqual({ enabled: false, visible: false });
  expect(props.lastMove).toEqual(["g1", "f3"]);
  expect(props.coordinates).toBe(true);
  expect(props.coordinatesOnSquares).toBe(false);
  expect(props.selected).toBe("d2");
  expect(props.movable.showDests).toBe(true);
  expect(props.movable.dests.get("d2")).toEqual(["d3", "d4"]);
  // Off-turn, Chessground paints premove targets (c3, e3) instead of the pawn's moves.
  expect(props.turnColor).toBe("white");
  expect(props.movable.color).toBe("white");
  expect(props.premovable).toEqual({ enabled: false });
});

test("follows the settings when they are switched off or set to every square", () => {
  const off = render({ moveHighlight: false, coordinates: "no", dests: false });
  expect(off.lastMove).toBeUndefined();
  expect(off.coordinates).toBe(false);
  expect(off.movable.showDests).toBe(false);

  const all = render({ moveHighlight: true, coordinates: "all", dests: true });
  expect(all.coordinates).toBe(true);
  expect(all.coordinatesOnSquares).toBe(true);
});

test("is hidden from assistive technology and the last move fits the position", () => {
  const props = render({ moveHighlight: true, coordinates: "edge", dests: true });
  expect(
    host.querySelector('[data-testid="board-settings-preview"]')?.getAttribute("aria-hidden"),
  ).toBe("true");
  // The knight that made the last move stands on its destination square.
  expect(props.fen.split(" ")[0].split("/")[5]).toBe("5N2");
});
