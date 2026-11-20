import { MantineProvider } from "@mantine/core";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import ShowMaterial from "./ShowMaterial";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// White has a bishop for Black's knight and pawn: Black leads by one.
const KNIGHT_AND_PAWN_FOR_BISHOP =
  "r2q1rk1/1p2ppbp/1n1p4/p2P1p2/P1n5/2N4P/1P2BPP1/R1BQ1RK1 w - - 0 15";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(props: ComponentProps<typeof ShowMaterial>) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <ShowMaterial {...props} />
      </MantineProvider>,
    ),
  );
}

function sides() {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-material-side]")).map((side) => ({
    side: side.dataset.materialSide,
    pieces: Array.from(side.querySelectorAll<HTMLElement>("[data-material-piece]")).map(
      (piece) => piece.dataset.materialPiece,
    ),
    // Pieces draw through the board's piece-set classes, never a generic icon.
    classes: Array.from(side.querySelectorAll("[data-material-piece] > div")).map(
      (piece) => piece.className,
    ),
    lead: side.querySelector("p")?.textContent ?? null,
  }));
}

test("without a colour both sides share one group, each showing its surplus in its own colour", async () => {
  await render({ fen: KNIGHT_AND_PAWN_FOR_BISHOP });
  expect(sides()).toEqual([
    { side: "white", pieces: ["white-bishop"], classes: ["white bishop"], lead: null },
    {
      side: "black",
      pieces: ["black-pawn", "black-knight"],
      classes: ["black pawn", "black knight"],
      lead: "+1",
    },
  ]);
});

test("one colour renders only that side", async () => {
  await render({ fen: KNIGHT_AND_PAWN_FOR_BISHOP, color: "white" });
  expect(sides()).toEqual([
    { side: "white", pieces: ["white-bishop"], classes: ["white bishop"], lead: null },
  ]);
});

test("all mode shows captured pieces in the captured colour, repeats overlapping", async () => {
  await render({ fen: KNIGHT_AND_PAWN_FOR_BISHOP, mode: "all" });
  expect(sides()).toEqual([
    {
      side: "white",
      pieces: ["black-pawn", "black-bishop"],
      classes: ["black pawn", "black bishop"],
      lead: null,
    },
    {
      side: "black",
      pieces: ["white-pawn", "white-pawn", "white-knight"],
      classes: ["white pawn", "white pawn", "white knight"],
      lead: "+1",
    },
  ]);
  const pawns = host.querySelectorAll<HTMLElement>('[data-material-piece="white-pawn"]');
  expect(pawns[0].style.marginLeft).toBe("0px");
  expect(pawns[1].style.marginLeft).toBe("-0.7rem");
});

test("a points lead without countable pieces still shows the lead", async () => {
  // White promoted a pawn to a second queen; nothing was captured.
  await render({ fen: "rnbqkbnr/pppppppp/8/8/8/3Q4/1PPPPPPP/RNBQKBNR w KQkq - 0 1", mode: "all" });
  expect(sides()).toEqual([{ side: "white", pieces: [], classes: [], lead: "+8" }]);
});

test("an unparsable position renders nothing", async () => {
  await render({ fen: "not a fen" });
  expect(host.querySelector("[data-material]")).toBeNull();
});

test("equal material renders nothing", async () => {
  await render({ fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" });
  expect(host.querySelector("[data-material]")).toBeNull();
});

test.each([undefined, "white", "black"] as const)(
  "none mode renders nothing even with unequal material (colour %s)",
  async (color) => {
    await render({ fen: KNIGHT_AND_PAWN_FOR_BISHOP, color, mode: "none" });
    expect(host.querySelector("[data-material]")).toBeNull();
    expect(sides()).toEqual([]);
    expect(host.querySelector("[data-material-piece]")).toBeNull();
  },
);
