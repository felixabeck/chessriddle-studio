import { useContext } from "react";
import { useStore } from "zustand";
import MoveCell from "@/components/common/MoveCell";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import classes from "./BestMoves.module.css";

/**
 * Colour and full-move number of the `index`-th move of an engine line searched after
 * `halfMoves` plies. A threat search plays one extra (null) ply first.
 */
export function engineLineMoveNumber(halfMoves: number, index: number, threat: boolean) {
  const totalMoves = halfMoves + index + 1 + (threat ? 1 : 0);
  return { isWhite: totalMoves % 2 === 1, moveNumber: Math.ceil(totalMoves / 2) };
}

/** One move of an engine line, with its move number, that plays the line up to it on click. */
function EngineLineMove({
  san,
  index,
  moves,
  halfMoves,
  threat,
  inert,
}: {
  san: string;
  index: number;
  moves: string[];
  halfMoves: number;
  threat: boolean;
  inert: boolean;
}) {
  const { isWhite, moveNumber } = engineLineMoveNumber(halfMoves, index, threat);
  const store = useContext(TreeStateContext)!;
  const makeMoves = useStore(store, (s) => s.makeMoves);

  return (
    <>
      {(index === 0 || isWhite) && (
        <span className={classes.moveNumber}>{`${moveNumber}${isWhite ? "." : "..."}`}</span>
      )}
      <MoveCell
        move={san}
        isCurrentVariation={false}
        annotations={[]}
        onContextMenu={() => undefined}
        isStart={false}
        onClick={() => {
          if (!inert && !threat) {
            makeMoves({ payload: moves.slice(0, index + 1) });
          }
        }}
      />
    </>
  );
}

export default EngineLineMove;
