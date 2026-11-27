import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INITIAL_FEN } from "chessops/fen";
import { press } from "@/tests/keyboard";

const mocks = vi.hoisted(() => ({
  scoreTypeFamily: vi.fn((_engineId: string) => Symbol("scoreType")),
  setEvalDisplay: vi.fn(),
  makeMoves: vi.fn(),
  notify: vi.fn(),
  keyMap: Symbol("keyMapAtom"),
}));

import AnalysisRow from "./AnalysisRow";
import scoreBubbleClasses from "./ScoreBubble.module.css";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/state/atoms", () => ({
  moveHighlightAtom: Symbol("moveHighlightAtom"),
  previewBoardOnHoverAtom: Symbol("previewBoardOnHoverAtom"),
  scoreTypeFamily: mocks.scoreTypeFamily,
}));
vi.mock("@/state/keybinds", () => ({ keyMapAtom: mocks.keyMap }));
vi.mock("jotai", () => ({
  useAtom: () => ["cp", mocks.setEvalDisplay],
  useAtomValue: (atom: unknown) =>
    atom === mocks.keyMap
      ? { NEXT_MOVE: { keys: "arrowright" }, PREVIOUS_MOVE: { keys: "arrowleft" } }
      : true,
}));
vi.mock("zustand", () => ({ useStore: () => mocks.makeMoves }));
vi.mock("@mantine/core", () => {
  const Container = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  return {
    Box: Container,
    Flex: Container,
    Text: ({ children, c, opacity, style, ...props }: any) => (
      <span
        {...props}
        c={c}
        style={{
          ...style,
          ...(c === "dimmed" ? { color: "var(--mantine-color-dimmed)" } : {}),
          ...(opacity !== undefined ? { opacity } : {}),
        }}
      >
        {children}
      </span>
    ),
    Tooltip: ({ label, children }: any) => <div title={label}>{children}</div>,
    Portal: Container,
    rem: (value: number) => value,
    getDefaultZIndex: () => 300,
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
  default: ({ move, onClick, onContextMenu, isCurrentVariation }: any) => (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={isCurrentVariation ? "true" : undefined}
    >
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
  vi.unstubAllGlobals();
});

test.each(["success", "failure"])(
  "keys score display by id while clipboard %s keeps the engine name",
  async (outcome) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    if (outcome === "failure") writeText.mockRejectedValue(new Error("clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
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
      (
        host.querySelectorAll('[aria-label="Board.Analysis.Expand"]')[0] as HTMLButtonElement
      ).click();
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Menu.Edit.Copy"]')!.click(),
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Duplicate +0.34");
    expect(mocks.notify.mock.calls).toEqual(
      outcome === "failure"
        ? [
            [
              {
                message: "Board.Analysis.CopyLineFailed",
                color: "danger",
              },
            ],
          ]
        : [],
    );
    expect(host.querySelector('[aria-label="Common.Copied"]') !== null).toBe(outcome === "success");
  },
);

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
      chessdb={{ note: "!! (30-11)", winrate: "100" }}
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
  await act(async () => {
    (host.querySelector(`.${scoreBubbleClasses.bubble}`) as HTMLDivElement).click();
  });
  expect(mocks.setEvalDisplay).toHaveBeenCalledWith("wdl");
  mocks.setEvalDisplay.mockClear();
  mocks.makeMoves.mockClear();
  await act(async () => root.render(row(true)));
  await act(async () => {
    (host.querySelector(`.${scoreBubbleClasses.bubble}`) as HTMLDivElement).click();
    move.click();
    move.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    move.parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    (host.querySelector('[aria-label="Board.Analysis.Expand"]') as HTMLButtonElement).click();
  });
  expect(mocks.setEvalDisplay).not.toHaveBeenCalled();
  expect(mocks.makeMoves).not.toHaveBeenCalled();
  expect(host.querySelector("[data-preview]")).toBeNull();
  expect(host.querySelector('[aria-label="Board.Analysis.Expand"]')?.hasAttribute("disabled")).toBe(
    true,
  );
  expect(host.querySelector("[inert]")).not.toBeNull();
  expect(host.querySelector('[aria-label="Menu.Edit.Copy"]')).toBeNull();
  const inertRow = host.querySelector<HTMLElement>("[inert]")!;
  expect(inertRow.style.opacity).toBe("");
  expect(inertRow.getAttribute("style") ?? "").not.toContain("opacity");
  const dimmed = [...inertRow.querySelectorAll<HTMLElement>('[c="dimmed"]')];
  expect(dimmed.map((el) => el.textContent)).toEqual(["!!", "100.0%"]);
  for (const el of dimmed) {
    expect(el.style.color).toBe("var(--mantine-color-dimmed)");
    expect(el.style.opacity).toBe("");
  }
});

test("move keys step a collapsed line's preview up to its twelfth shown move, an expanded one to its end", async () => {
  const moves = [
    "e4",
    "e5",
    "Nf3",
    "Nc6",
    "Bb5",
    "a6",
    "Ba4",
    "Nf6",
    "O-O",
    "Be7",
    "Re1",
    "b5",
    "Bb3",
    "d6",
  ];
  await act(async () =>
    root.render(
      <AnalysisRow
        engineId="engine"
        engineName="Engine"
        score={{ value: { type: "cp", value: 34 }, wdl: null }}
        moves={moves}
        halfMoves={0}
        threat={false}
        fen={INITIAL_FEN}
        orientation="white"
      />,
    ),
  );
  const previewed = () => host.querySelector('[aria-current="true"]')?.textContent;
  await act(async () => {
    host
      .querySelectorAll("button")[0]
      .parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  for (let i = 0; i < 15; i++) press("ArrowRight");
  expect(previewed()).toBe("b5");

  await act(async () => {
    (host.querySelector('[aria-label="Board.Analysis.Expand"]') as HTMLButtonElement).click();
  });
  for (let i = 0; i < 5; i++) press("ArrowRight");
  expect(previewed()).toBe("d6");
  expect(mocks.makeMoves).not.toHaveBeenCalled();
});
