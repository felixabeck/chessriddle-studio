import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import PieceComponent from "./Piece";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

// Black pieces vanish on the dark card and white ones on the light card without a tile.
test("a draggable palette piece sits on the scheme-independent palette tile", async () => {
  await act(async () => {
    root.render(
      <PieceComponent
        piece={{ role: "pawn", color: "black" }}
        boardRef={createRef<HTMLDivElement>()}
        putPiece={() => {}}
      />,
    );
  });
  const piece = host.querySelector<HTMLElement>(".black.pawn")!;
  // The literal, not the exported constant: a darker or lighter tile must turn this red.
  expect(piece.style.backgroundColor).toBe("rgb(170, 160, 147)");
});
