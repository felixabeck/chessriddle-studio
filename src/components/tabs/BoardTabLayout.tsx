import { useAtom, useAtomValue } from "jotai";
import { createContext, type ReactNode, useCallback, useMemo, useState } from "react";
import { Mosaic } from "react-mosaic-component";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  applyShownSplits,
  arrangementLeaves,
  arrangementPanelAreas,
  BASE_AREA_IDS,
  BOARD_AREA_IDS,
  type BoardAreaId,
  isPanelArea,
  type PanelAreaId,
  returnPanelArea,
  shownArrangement,
} from "@/state/boardArrangement";
import { coachEnabledAtom } from "@/state/coach";
import { boardArrangementAtom, type ViewId, windowsStateAtom } from "@/state/layoutStorage";
import { arrangementFitsWidth, needsTwoPaneStack } from "@/state/paneLayout";
import classes from "./BoardsPage.module.css";

const resize = { minimumPaneSizePercentage: 0 };
const EMPTY_PANEL_SET: ReadonlySet<PanelAreaId> = new Set();
const COACH_HIDDEN_SET: ReadonlySet<PanelAreaId> = new Set(["coach"]);

/** DOM id of the portal destination for a board area. Base areas keep their existing ids. */
export function boardAreaTargetId(area: BoardAreaId): string {
  return isPanelArea(area) ? `board-area-${area}` : area;
}

export interface BoardArrangementContextValue {
  /** Panel areas currently shown as their own tiles on the board. */
  shownPanelAreas: ReadonlySet<PanelAreaId>;
  /** Whether the analysis board's own arrangement is currently displayed and arrangeable. */
  arrangingAvailable: boolean;
  /** Returns a panel area back to the tab strip. */
  returnPanel: (panel: PanelAreaId) => void;
}

export const BoardArrangementContext = createContext<BoardArrangementContextValue>({
  shownPanelAreas: EMPTY_PANEL_SET,
  arrangingAvailable: false,
  returnPanel: () => undefined,
});

function TargetHost({ target, direct = false }: { target: HTMLDivElement; direct?: boolean }) {
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
    <div ref={attach} className={`mosaic-tile ${classes.targetHost}`} data-board-slot={target.id} />
  );
}

export default function BoardTabLayout({
  children,
  arrangeable = false,
}: {
  children: ReactNode;
  /** Whether this tab uses the analysis board's stored arrangement. */
  arrangeable?: boolean;
}) {
  const [windowsState, setWindowsState] = useAtom(windowsStateAtom);
  const [storedArrangement, setStoredArrangement] = useAtom(boardArrangementAtom);
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const { ref, width } = useElementWidth();
  const rootFont = useRootFontPx();

  const hiddenPanels = coachEnabled ? EMPTY_PANEL_SET : COACH_HIDDEN_SET;
  const displayedArrangement = useMemo(
    () => shownArrangement(storedArrangement, hiddenPanels),
    [storedArrangement, hiddenPanels],
  );

  const stacked = needsTwoPaneStack(width, rootFont);
  // Three cases for an analysis tab: stacked below two pane floors, the shown arrangement when it
  // fits, or the shared three-area layout from `windowsState` while the window is too narrow.
  const useArrangement =
    arrangeable && !stacked && arrangementFitsWidth(displayedArrangement, width, rootFont);
  const mode: "stacked" | "mosaic" = stacked ? "stacked" : "mosaic";

  // React owns the hosts, while this mount owns the portal destinations.
  // Moving destinations preserves Mantine's one-time target lookup and child state.
  const [targets] = useState(
    () =>
      Object.fromEntries(
        BOARD_AREA_IDS.map((id) => {
          const element = document.createElement("div");
          element.id = boardAreaTargetId(id);
          element.dataset.boardArea = id;
          element.className = classes.portalTarget;
          return [id, element];
        }),
      ) as Record<BoardAreaId, HTMLDivElement>,
  );

  const returnPanel = useCallback(
    (panel: PanelAreaId) => {
      setStoredArrangement((stored) => returnPanelArea(stored, panel));
    },
    [setStoredArrangement],
  );

  const shownPanelAreas = useMemo<ReadonlySet<PanelAreaId>>(
    () => (useArrangement ? new Set(arrangementPanelAreas(displayedArrangement)) : EMPTY_PANEL_SET),
    [useArrangement, displayedArrangement],
  );

  const arrangementContext = useMemo<BoardArrangementContextValue>(
    () => ({
      shownPanelAreas,
      arrangingAvailable: useArrangement,
      returnPanel,
    }),
    [shownPanelAreas, useArrangement, returnPanel],
  );

  const shown: readonly BoardAreaId[] = stacked
    ? BASE_AREA_IDS
    : useArrangement
      ? arrangementLeaves(displayedArrangement)
      : windowsState.currentNode
        ? arrangementLeaves(windowsState.currentNode)
        : [];

  return (
    <>
      <div ref={ref} className={classes.boardLayout} data-board-layout={mode}>
        {stacked ? (
          <div className={classes.boardStack}>
            {BASE_AREA_IDS.map((id) => (
              <TargetHost key={id} target={targets[id]} />
            ))}
          </div>
        ) : useArrangement ? (
          <Mosaic<BoardAreaId>
            key="arrangement"
            renderTile={(id) => <TargetHost target={targets[id]} direct />}
            value={displayedArrangement}
            onChange={(next) => {
              if (next === null) return;
              setStoredArrangement((stored) => applyShownSplits(stored, next, hiddenPanels));
            }}
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
          {BOARD_AREA_IDS.filter((id) => !shown.includes(id)).map((id) => (
            <TargetHost key={id} target={targets[id]} />
          ))}
        </div>
      </div>
      <BoardArrangementContext.Provider value={arrangementContext}>
        {children}
      </BoardArrangementContext.Provider>
    </>
  );
}
