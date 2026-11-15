import { MantineProvider } from "@mantine/core";
import { parseSquare, type Piece, type Square } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import PiecesGrid from "./PiecesGrid";

const mocks = vi.hoisted(() => ({
  putPiece: undefined as ((to: Square, piece: Piece) => void) | undefined,
}));

vi.mock("../common/Piece", () => ({
  default: ({ putPiece }: { putPiece: (to: Square, piece: Piece) => void }) => {
    mocks.putPiece = putPiece;
    return null;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let host: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  mocks.putPiece = undefined;
});

test("dropping a white knight on h1 clears the matching castling right", async () => {
  const onPut = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MantineProvider>
        <PiecesGrid fen={INITIAL_FEN} boardRef={createRef()} onPut={onPut} />
      </MantineProvider>,
    );
  });

  expect(mocks.putPiece).toBeTruthy();
  await act(async () => {
    mocks.putPiece!(parseSquare("h1")!, { role: "knight", color: "white" });
  });
  expect(onPut).toHaveBeenCalledWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNN w Qkq - 0 1");
});
