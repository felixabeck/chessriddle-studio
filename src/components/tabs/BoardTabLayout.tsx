import { useAtom, useAtomValue } from "jotai";
import {
  createContext,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Mosaic } from "react-mosaic-component";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { useElementWidth } from "@/hooks/useElementWidth";
import {
  applyShownSplits,
  arrangementEngineAreas,
  arrangementLeaves,
  arrangementPanelAreas,
  BASE_AREA_IDS,
  BOARD_AREA_IDS,
  type BoardAreaId,
  canTakeOutEngine,
  canTakeOutPanel,
  type EngineAreaId,
  type HideableAreaId,
  hiddenEngineAreas,
  isEngineArea,
  isPanelArea,
  type PanelAreaId,
  placeArea,
  type PlacementSide,
  pruneMissingEngineAreas,
  returnEngineArea,
  returnPanelArea,
  shownArrangement,
  type StaticBoardAreaId,
} from "@/state/boardArrangement";
import { enginesAtom } from "@/state/atoms";
import { coachEnabledAtom } from "@/state/coach";
import {
  analysisTabsHiddenAtom,
  boardArrangementAtom,
  type ViewId,
  windowsStateAtom,
} from "@/state/layoutStorage";
import { arrangementFitsWidth, needsTwoPaneStack } from "@/state/paneLayout";
import BoardArrangeOverlay from "./BoardArrangeOverlay";
import classes from "./BoardsPage.module.css";
import { type EngineCardReorderOptions, useBoardArranging } from "./useBoardArranging";

const resize = { minimumPaneSizePercentage: 0 };
const EMPTY_PANEL_SET: ReadonlySet<PanelAreaId> = new Set();
const EMPTY_ENGINE_SET: ReadonlySet<EngineAreaId> = new Set();

/** DOM id of the portal destination for a static board area. Base areas keep their existing ids. */
export function boardAreaTargetId(area: StaticBoardAreaId): string {
  return isPanelArea(area) ? `board-area-${area}` : area;
}

function createAreaTarget(id: BoardAreaId): HTMLDivElement {
  const element = document.createElement("div");
  if (!isEngineArea(id)) {
    element.id = boardAreaTargetId(id);
  }
  element.dataset.boardArea = id;
  element.className = classes.portalTarget;
  return element;
}

export interface BoardArrangementContextValue {
  /** Panel areas currently shown as their own tiles on the board. */
  shownPanelAreas: ReadonlySet<PanelAreaId>;
  /** Engine areas currently shown as their own tiles on the board. */
  shownEngineAreas: ReadonlySet<EngineAreaId>;
  /** Portal destination element owned by the layout mount for `area`. */
  getAreaTarget: (area: BoardAreaId) => HTMLElement | undefined;
  /** Whether the analysis board's own arrangement is currently displayed and arrangeable. */
  arrangingAvailable: boolean;
  /** Whether `panel` is in the strip and can be taken out without breaking the strip rule. */
  canTakeOut: (panel: PanelAreaId) => boolean;
  /** Whether `area` is an engine not yet in the arrangement and below the engine window cap. */
  canTakeOutEngine: (area: EngineAreaId) => boolean;
  /** Returns a panel area back to the tab strip. */
  returnPanel: (panel: PanelAreaId) => void;
  /** Returns a pulled-out engine area back to the Engines panel. */
  returnEngine: (area: EngineAreaId) => void;
  /** Registers a listener invoked whenever a panel area returns to the tab strip. */
  registerReturnListener: (listener: ((panel: PanelAreaId) => void) | null) => void;
  /** Starts a pointer-capture drag for `area` (with optional reorder slots for engine cards). */
  beginDrag: (
    area: BoardAreaId,
    event: ReactPointerEvent<HTMLElement>,
    reorder?: EngineCardReorderOptions,
  ) => void;
  /** Suppresses the trailing click after a drag gesture finishes. */
  consumeSuppressedClick: (event: ReactMouseEvent) => void;
  /** Starts keyboard/click placing for `area`, returning focus on cancel to `originArea`. */
  startPlacing: (area: BoardAreaId, originArea?: BoardAreaId) => void;
  /** Whether the tab strip is hidden from the displayed arrangement. */
  tabsHidden: boolean;
  /** Hides or shows the tab strip; it keeps its place and size in the arrangement. */
  setTabsHidden: (hidden: boolean) => void;
}

export const BoardArrangementContext = createContext<BoardArrangementContextValue>({
  shownPanelAreas: EMPTY_PANEL_SET,
  shownEngineAreas: EMPTY_ENGINE_SET,
  getAreaTarget: () => undefined,
  arrangingAvailable: false,
  canTakeOut: () => false,
  canTakeOutEngine: () => false,
  returnPanel: () => undefined,
  returnEngine: () => undefined,
  registerReturnListener: () => undefined,
  beginDrag: () => undefined,
  consumeSuppressedClick: () => undefined,
  startPlacing: () => undefined,
  tabsHidden: false,
  setTabsHidden: () => undefined,
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
    <div
      ref={attach}
      className={`mosaic-tile ${classes.targetHost}`}
      data-board-slot={target.id || target.dataset.boardArea}
    />
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
  const engines = useAtomValue(enginesAtom);
  const [tabsHiddenStored, setTabsHidden] = useAtom(analysisTabsHiddenAtom);
  const { ref, width } = useElementWidth();
  const rootFont = useRootFontPx();
  const returnListenerRef = useRef<((panel: PanelAreaId) => void) | null>(null);

  // Prune stored engine leaves whose engine was deleted once the engine list has loaded.
  useEffect(() => {
    if (!arrangeable || engines === undefined) return;
    const pruned = pruneMissingEngineAreas(storedArrangement, engines);
    if (pruned !== storedArrangement) {
      setStoredArrangement(pruned);
    }
  }, [arrangeable, engines, storedArrangement, setStoredArrangement]);

  // The tab strip is hidden only from the analysis board's arrangement; other boards and the
  // stacked and too-narrow layouts below always show it.
  const tabsHiddenHere = arrangeable && tabsHiddenStored;
  const hiddenAreas = useMemo<ReadonlySet<HideableAreaId>>(() => {
    const next = new Set<HideableAreaId>();
    if (!coachEnabled) next.add("coach");
    if (tabsHiddenHere) next.add("topRight");
    for (const area of hiddenEngineAreas(storedArrangement, engines)) {
      next.add(area);
    }
    return next;
  }, [coachEnabled, tabsHiddenHere, storedArrangement, engines]);
  const displayedArrangement = useMemo(
    () => shownArrangement(storedArrangement, hiddenAreas),
    [storedArrangement, hiddenAreas],
  );

  const stacked = needsTwoPaneStack(width, rootFont);
  // Three cases for an analysis tab: stacked below two pane floors, the shown arrangement when it
  // fits, or the shared three-area layout from `windowsState` while the window is too narrow.
  const useArrangement =
    arrangeable && !stacked && arrangementFitsWidth(displayedArrangement, width, rootFont);
  const tabsHidden = useArrangement && tabsHiddenHere;
  const mode: "stacked" | "mosaic" = stacked ? "stacked" : "mosaic";

  // React owns the hosts, while this mount owns the portal destinations.
  // Moving destinations preserves Mantine's one-time target lookup and child state.
  const [targets] = useState<Map<BoardAreaId, HTMLDivElement>>(
    () => new Map(BOARD_AREA_IDS.map((id) => [id, createAreaTarget(id)])),
  );
  const storedEngineAreas = useMemo(
    () => arrangementEngineAreas(storedArrangement),
    [storedArrangement],
  );
  const activeAreaIds = useMemo<ReadonlySet<BoardAreaId>>(
    () => new Set<BoardAreaId>([...BOARD_AREA_IDS, ...storedEngineAreas]),
    [storedEngineAreas],
  );
  for (const engineArea of storedEngineAreas) {
    if (!targets.has(engineArea)) {
      targets.set(engineArea, createAreaTarget(engineArea));
    }
  }
  useEffect(() => {
    for (const id of [...targets.keys()]) {
      if (!activeAreaIds.has(id)) targets.delete(id);
    }
  }, [targets, activeAreaIds]);

  const getAreaTarget = useCallback(
    (area: BoardAreaId): HTMLElement | undefined =>
      activeAreaIds.has(area) ? targets.get(area) : undefined,
    [targets, activeAreaIds],
  );

  const registerReturnListener = useCallback((listener: ((panel: PanelAreaId) => void) | null) => {
    returnListenerRef.current = listener;
  }, []);

  const returnPanel = useCallback(
    (panel: PanelAreaId) => {
      returnListenerRef.current?.(panel);
      setStoredArrangement((stored) => returnPanelArea(stored, panel));
    },
    [setStoredArrangement],
  );

  const returnEngineLeaf = useCallback(
    (area: EngineAreaId) => {
      setStoredArrangement((stored) => returnEngineArea(stored, area));
    },
    [setStoredArrangement],
  );

  const handlePlace = useCallback(
    (area: BoardAreaId, target: BoardAreaId, side: PlacementSide) => {
      setStoredArrangement((stored) => placeArea(stored, area, target, side));
    },
    [setStoredArrangement],
  );

  const canTakeOut = useCallback(
    (panel: PanelAreaId) => canTakeOutPanel(storedArrangement, panel),
    [storedArrangement],
  );

  const canTakeOutEngineHere = useCallback(
    (area: EngineAreaId) => canTakeOutEngine(storedArrangement, area),
    [storedArrangement],
  );

  const arranging = useBoardArranging({
    enabled: useArrangement,
    layoutRef: ref,
    targets,
    storedArrangement,
    displayedArrangement,
    hiddenAreas,
    width,
    rootFont,
    onPlace: handlePlace,
    onReturn: returnPanel,
    onReturnEngine: returnEngineLeaf,
  });

  const { scheduleEngineReturnFocus } = arranging;
  const returnEngine = useCallback(
    (area: EngineAreaId) => {
      scheduleEngineReturnFocus(area);
      returnEngineLeaf(area);
    },
    [scheduleEngineReturnFocus, returnEngineLeaf],
  );

  const resolveEngineName = useCallback(
    (engineId: string) => engines?.find((engine) => engine.id === engineId)?.name,
    [engines],
  );

  const shownPanelAreas = useMemo<ReadonlySet<PanelAreaId>>(
    () => (useArrangement ? new Set(arrangementPanelAreas(displayedArrangement)) : EMPTY_PANEL_SET),
    [useArrangement, displayedArrangement],
  );

  const shownEngineAreas = useMemo<ReadonlySet<EngineAreaId>>(
    () =>
      useArrangement ? new Set(arrangementEngineAreas(displayedArrangement)) : EMPTY_ENGINE_SET,
    [useArrangement, displayedArrangement],
  );

  const arrangementContext = useMemo<BoardArrangementContextValue>(
    () => ({
      shownPanelAreas,
      shownEngineAreas,
      getAreaTarget,
      arrangingAvailable: useArrangement,
      canTakeOut,
      canTakeOutEngine: canTakeOutEngineHere,
      returnPanel,
      returnEngine,
      registerReturnListener,
      beginDrag: arranging.beginDrag,
      consumeSuppressedClick: arranging.consumeSuppressedClick,
      startPlacing: arranging.startPlacing,
      tabsHidden,
      setTabsHidden,
    }),
    [
      shownPanelAreas,
      shownEngineAreas,
      getAreaTarget,
      useArrangement,
      canTakeOut,
      canTakeOutEngineHere,
      returnPanel,
      returnEngine,
      registerReturnListener,
      arranging.beginDrag,
      arranging.consumeSuppressedClick,
      arranging.startPlacing,
      tabsHidden,
      setTabsHidden,
    ],
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
              <TargetHost key={id} target={targets.get(id)!} />
            ))}
          </div>
        ) : useArrangement ? (
          <Mosaic<BoardAreaId>
            key="arrangement"
            renderTile={(id) => {
              const target = targets.get(id);
              return target ? <TargetHost target={target} direct /> : <></>;
            }}
            value={displayedArrangement}
            onChange={(next) => {
              if (next === null) return;
              setStoredArrangement((stored) => applyShownSplits(stored, next, hiddenAreas));
            }}
            resize={resize}
          />
        ) : (
          <Mosaic<ViewId>
            key="mosaic"
            renderTile={(id) => <TargetHost target={targets.get(id)!} direct />}
            value={windowsState.currentNode}
            onChange={(currentNode) => setWindowsState({ currentNode })}
            resize={resize}
          />
        )}
        <div hidden>
          {[...targets.entries()]
            .filter(([id]) => activeAreaIds.has(id) && !shown.includes(id))
            .map(([id, target]) => (
              <TargetHost key={id} target={target} />
            ))}
        </div>
        {(useArrangement || arranging.dragPreview !== null) && (
          <BoardArrangeOverlay
            dragPreview={arranging.dragPreview}
            placing={useArrangement ? arranging.placing : null}
            onSelectTarget={arranging.applyPlacingTarget}
            onCancelPlacing={arranging.cancelPlacing}
            resolveEngineName={resolveEngineName}
          />
        )}
      </div>
      <BoardArrangementContext.Provider value={arrangementContext}>
        {children}
      </BoardArrangementContext.Provider>
    </>
  );
}
