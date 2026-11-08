import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INITIAL_FEN } from "chessops/fen";

const mocks = vi.hoisted(() => ({
  scoreTypeFamily: vi.fn((_engineId: string) => Symbol("scoreType")),
  makeMoves: vi.fn(),
}));

import AnalysisRow from "./AnalysisRow";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/state/atoms", () => ({
  moveHighlightAtom: Symbol("moveHighlightAtom"),
  previewBoardOnHoverAtom: Symbol("previewBoardOnHoverAtom"),
  scoreTypeFamily: mocks.scoreTypeFamily,
}));
vi.mock("jotai", () => ({
  useAtom: () => ["cp", vi.fn()],
  useAtomValue: () => true,
}));
vi.mock("zustand", () => ({ useStore: () => mocks.makeMoves }));
vi.mock("@mantine/hooks", () => ({ useForceUpdate: () => vi.fn() }));
vi.mock("@mantine/core", () => {
  const Container = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  return {
    Box: Container,
    CopyButton: ({ value, children }: any) => (
      <div data-testid="copy-value" data-value={value}>
        {children({ copied: false, copy: vi.fn() })}
      </div>
    ),
    Flex: Container,
    Text: ({ children }: any) => <span>{children}</span>,
    Tooltip: ({ label, children }: any) => <div title={label}>{children}</div>,
    Portal: Container,
    rem: (value: number) => value,
    Table: { Tr: Container, Td: Container, Th: Container },
  };
});
vi.mock("lucide-react", () => ({
  Check: () => null,
  ChevronDown: () => null,
  Copy: () => null,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ label, onClick, children, disabled }: any) => (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/common/MoveCell", () => ({
  default: ({ move, onClick, onContextMenu }: any) => (
    <button onClick={onClick} onContextMenu={onContextMenu}>
      {move}
    </button>
  ),
}));
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => <div data-preview /> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("keys score display by id while copied output keeps the engine name", async () => {
  await act(async () => {
    root.render(
      <>
        <AnalysisRow
          engineId="engine-uuid-1"
          engineName="Duplicate"
          score={{ value: { type: "cp", value: 34 }, wdl: null }}
          moves={[]}
          halfMoves={0}
          threat={false}
          fen="irrelevant"
          orientation="white"
        />
        <AnalysisRow
          engineId="engine-uuid-2"
          engineName="Duplicate"
          score={{ value: { type: "cp", value: 21 }, wdl: null }}
          moves={[]}
          halfMoves={0}
          threat={false}
          fen="irrelevant"
          orientation="white"
        />
      </>,
    );
  });

  expect(mocks.scoreTypeFamily.mock.calls.map(([id]) => id)).toEqual([
    "engine-uuid-1",
    "engine-uuid-2",
  ]);
  await act(async () => {
    (host.querySelectorAll('[aria-label="Board.Analysis.Expand"]')[0] as HTMLButtonElement).click();
  });
  const copied = host.querySelector('[data-testid="copy-value"]')?.getAttribute("data-value");
  expect(copied).toContain("Duplicate");
  expect(copied).not.toContain("engine-uuid-1");
});

test.each([
  ["! (30-11)", "49.92", "!", "49.9%"],
  ["? (12-7)", "0", "?", "0.0%"],
  ["!! (30-11)", "100", "!!", "100.0%"],
  ["* (5-3)", " 49.92 ", "*", "49.9%"],
  ["!?123", undefined, "!?", null],
  ["(30-11)", "invalid", null, null],
  ["30-11", "", null, null],
  ["", " ", null, null],
  ["book", "49.92oops", null, null],
  [" !", "Infinity", null, null],
] as const)(
  "ChessDB phase 2 shows the mark and finite win rate with raw note on hover: %s / %s",
  async (note, winrate, mark, rate) => {
    await act(async () =>
      root.render(
        <AnalysisRow
          engineId="chessdb"
          engineName="ChessDB"
          score={{ value: { type: "cp", value: 34 }, wdl: null }}
          moves={[]}
          halfMoves={1}
          threat={false}
          fen="4k3/8/8/8/8/8/8/4K3 b - - 0 1"
          orientation="white"
          chessdb={{ note, winrate }}
        />,
      ),
    );
    const annotation = host.querySelector("[title]");
    expect(annotation?.getAttribute("title")).toBe(note);
    expect(annotation?.textContent).toBe(["+0.34", mark, rate].filter(Boolean).join(""));
  },
);

test("regression coverage: rows without ChessDB annotations keep their score and move output", async () => {
  await act(async () =>
    root.render(
      <AnalysisRow
        engineId="local"
        engineName="Stockfish"
        score={{ value: { type: "cp", value: 34 }, wdl: null }}
        moves={["e4"]}
        halfMoves={0}
        threat={false}
        fen={INITIAL_FEN}
        orientation="white"
      />,
    ),
  );
  expect(host.querySelector("[title]")).toBeNull();
  expect(host.textContent).toContain("e4");
  expect(host.textContent).not.toContain("%");
});

test("inert previous rows ignore insertion, hover preview, context and expansion; current rows remain interactive", async () => {
  const row = (inert: boolean) => (
    <AnalysisRow
      engineId="engine"
      engineName="Engine"
      score={{ value: { type: "cp", value: 34 }, wdl: null }}
      moves={["e4", "e5"]}
      halfMoves={0}
      threat={false}
      fen={INITIAL_FEN}
      orientation="white"
      inert={inert}
    />
  );
  await act(async () => root.render(row(false)));
  const move = host.querySelectorAll("button")[0];
  await act(async () => {
    move.click();
    move.parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(mocks.makeMoves).toHaveBeenCalledWith({ payload: ["e4"] });
  expect(host.querySelector("[data-preview]")).not.toBeNull();
  mocks.makeMoves.mockClear();
  await act(async () => root.render(row(true)));
  await act(async () => {
    move.click();
    move.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    move.parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    (host.querySelector('[aria-label="Board.Analysis.Expand"]') as HTMLButtonElement).click();
  });
  expect(mocks.makeMoves).not.toHaveBeenCalled();
  expect(host.querySelector("[data-preview]")).toBeNull();
  expect(host.querySelector('[aria-label="Board.Analysis.Expand"]')?.hasAttribute("disabled")).toBe(
    true,
  );
  expect(host.querySelector("[inert]")).not.toBeNull();
  expect(host.querySelector('[data-testid="copy-value"]')).toBeNull();
});
