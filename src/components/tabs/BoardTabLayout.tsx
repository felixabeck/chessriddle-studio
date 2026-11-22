import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { type ReactNode, useCallback, useState } from "react";
import { Mosaic, MosaicWithoutDragDropContext, type MosaicNode } from "react-mosaic-component";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  besideSplitsAtom,
  createWindowsStateStorage,
  defaultWindowsState,
  panelsBesideNotationAtom,
  type ViewId,
} from "@/state/layoutStorage";
import {
  besideSplitPositions,
  type BoardLayoutMode,
  BoardLayoutModeContext,
  fitsThreePanes,
  needsTwoPaneStack,
} from "@/state/paneLayout";
import classes from "./BoardsPage.module.css";

/**
 * A portal destination. The three tiles keep the names of where the panels-above layout puts them:
 * `left` is the board, `topRight` the panels, `bottomRight` the notation. `rightSpan` is the slot
 * across the notation and the panels in the beside arrangement; it holds what is pinned above both.
 */
type TargetId = ViewId | "rightSpan";
/** The two tiles of the outer split in the beside arrangement. */
type BesideTile = "left" | "right";
/** The split inside the right side in the beside arrangement: the notation, then the panels. */
type RightTile = "bottomRight" | "topRight";

const viewIds: ViewId[] = ["left", "topRight", "bottomRight"];
const targetIds: TargetId[] = [...viewIds, "rightSpan"];
const resize = { minimumPaneSizePercentage: 0 };
const windowsStateAtom = atomWithStorage(
  "windowsState",
  defaultWindowsState(),
  createWindowsStateStorage(localStorage),
  { getOnInit: true },
);

function leaves(node: MosaicNode<ViewId> | null): ViewId[] {
  return node === null
    ? []
    : typeof node === "string"
      ? [node]
      : [...leaves(node.first), ...leaves(node.second)];
}

/** A split's divider position, when the node is a split that has one. */
function splitOf(node: MosaicNode<string> | null) {
  return node !== null && typeof node !== "string" ? node.splitPercentage : undefined;
}

/**
 * Where the board's edge sits in the panels-above layout, when that layout has the board first in
 * a row. The beside arrangement starts from it, so switching does not resize the board.
 */
function classicBoardSplit(node: MosaicNode<ViewId> | null) {
  return node !== null &&
    typeof node !== "string" &&
    node.direction === "row" &&
    node.first === "left"
    ? node.splitPercentage
    : undefined;
}

function TargetHost({
  target,
  direct = false,
  className = `mosaic-tile ${classes.targetHost}`,
}: {
  target: HTMLDivElement;
  direct?: boolean;
  className?: string;
}) {
  const attach = useCallback(
    (host: HTMLElement | null) => {
      if (host) (direct ? host.parentElement : host)?.appendChild(target);
    },
    [target, direct],
  );
  // Keep desktop destinations directly inside Mosaic's tile, as before.
  return direct ? (
    <span hidden ref={attach} />
  ) : (
    <div ref={attach} className={className} data-board-slot={target.id} />
  );
}

export default function BoardTabLayout({
  children,
  besideCapable = false,
}: {
  children: ReactNode;
  /** Whether this tab's board can show its panels beside the notation (the analysis board). */
  besideCapable?: boolean;
}) {
  const [windowsState, setWindowsState] = useAtom(windowsStateAtom);
  const wantsPanelsBeside = useAtomValue(panelsBesideNotationAtom);
  const [besideSplits, setBesideSplits] = useAtom(besideSplitsAtom);
  const { ref, width } = useElementWidth();
  const rootFont = useRootFontPx();
  // The stored choice is kept while the window is too narrow for it; the layout only falls back.
  const mode: BoardLayoutMode = needsTwoPaneStack(width, rootFont)
    ? "stacked"
    : besideCapable && wantsPanelsBeside && fitsThreePanes(width, rootFont)
      ? "beside"
      : "mosaic";
  // React owns the hosts, while this mount owns the portal destinations.
  // Moving destinations preserves Mantine's one-time target lookup and child state.
  const [targets] = useState(
    () =>
      Object.fromEntries(
        targetIds.map((id) => {
          const element = document.createElement("div");
          element.id = id;
          element.className = id === "rightSpan" ? classes.spanTarget : classes.portalTarget;
          return [id, element];
        }),
      ) as Record<TargetId, HTMLDivElement>,
  );
  // The stored positions are what the user dragged; a window too narrow for them only moves the
  // dividers shown, and a drag stores the position it could actually reach.
  const splits = besideSplitPositions(width, rootFont, {
    board: besideSplits.board ?? classicBoardSplit(windowsState.currentNode),
    notation: besideSplits.notation,
  });
  const storeSplit = (divider: "board" | "notation", node: MosaicNode<string> | null) => {
    const dragged = splitOf(node);
    if (dragged === undefined) return;
    const reached = besideSplitPositions(width, rootFont, { ...splits, [divider]: dragged });
    setBesideSplits((previous) => ({ ...previous, [divider]: reached[divider] }));
  };
  const shown: TargetId[] =
    mode === "stacked" ? viewIds : mode === "beside" ? targetIds : leaves(windowsState.currentNode);

  return (
    <>
      <div ref={ref} className={classes.boardLayout} data-board-layout={mode}>
        {mode === "stacked" ? (
          <div className={classes.boardStack}>
            {viewIds.map((id) => (
              <TargetHost key={id} target={targets[id]} />
            ))}
          </div>
        ) : mode === "beside" ? (
          <Mosaic<BesideTile>
            key="beside"
            renderTile={(id) =>
              id === "left" ? (
                <TargetHost target={targets.left} direct />
              ) : (
                // One pane for what is pinned across the top: it measures against the whole side.
                <div className={classes.besideRegion} data-pinned-pane>
                  <TargetHost target={targets.rightSpan} className={classes.spanHost} />
                  <div className={classes.besideSplit}>
                    <MosaicWithoutDragDropContext<RightTile>
                      renderTile={(tile) => <TargetHost target={targets[tile]} direct />}
                      value={{
                        direction: "row",
                        first: "bottomRight",
                        second: "topRight",
                        splitPercentage: splits.notation,
                      }}
                      onChange={(node) => storeSplit("notation", node)}
                      resize={resize}
                    />
                  </div>
                </div>
              )
            }
            value={{
              direction: "row",
              first: "left",
              second: "right",
              splitPercentage: splits.board,
            }}
            onChange={(node) => storeSplit("board", node)}
            resize={resize}
          />
        ) : (
          <Mosaic<ViewId>
            key="mosaic"
            renderTile={(id) => <TargetHost target={targets[id]} direct />}
            value={windowsState.currentNode}
            onChange={(currentNode) => setWindowsState({ currentNode })}
            resize={resize}
          />
        )}
        <div hidden>
          {targetIds
            .filter((id) => !shown.includes(id))
            .map((id) => (
              <TargetHost key={id} target={targets[id]} />
            ))}
        </div>
      </div>
      <BoardLayoutModeContext.Provider value={mode}>{children}</BoardLayoutModeContext.Provider>
    </>
  );
}
