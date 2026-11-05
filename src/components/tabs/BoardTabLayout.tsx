import { useElementSize } from "@mantine/hooks";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { type ReactNode, useCallback, useLayoutEffect, useState } from "react";
import { Mosaic, type MosaicNode } from "react-mosaic-component";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { createWindowsStateStorage, defaultWindowsState, type ViewId } from "@/state/layoutStorage";
import { needsTwoPaneStack } from "@/state/paneLayout";
import classes from "./BoardsPage.module.css";

const viewIds: ViewId[] = ["left", "topRight", "bottomRight"];
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

export default function BoardTabLayout({ children }: { children: ReactNode }) {
  const [windowsState, setWindowsState] = useAtom(windowsStateAtom);
  const { ref, width } = useElementSize();
  const [initialWidth, setInitialWidth] = useState(0);
  // ResizeObserver publishes on an animation frame. Measure before first paint too,
  // so a paused frame clock cannot leave a desktop tab in the initial zero-width mode.
  useLayoutEffect(() => {
    if (width === 0) setInitialWidth(ref.current?.getBoundingClientRect().width ?? 0);
  }, [ref, width]);
  const rootFont = useRootFontPx();
  const narrow = needsTwoPaneStack(width || initialWidth, rootFont);
  // React owns the hosts, while this mount owns the three portal destinations.
  // Moving destinations preserves Mantine's one-time target lookup and child state.
  const [targets] = useState(
    () =>
      Object.fromEntries(
        viewIds.map((id) => {
          const element = document.createElement("div");
          element.id = id;
          element.className = classes.portalTarget;
          return [id, element];
        }),
      ) as Record<ViewId, HTMLDivElement>,
  );
  const shown = narrow ? viewIds : leaves(windowsState.currentNode);

  return (
    <>
      <div
        ref={ref}
        className={classes.boardLayout}
        data-board-layout={narrow ? "stacked" : "mosaic"}
      >
        {narrow ? (
          <div className={classes.boardStack}>
            {viewIds.map((id) => (
              <TargetHost key={id} target={targets[id]} />
            ))}
          </div>
        ) : (
          <Mosaic<ViewId>
            renderTile={(id) => <TargetHost target={targets[id]} direct />}
            value={windowsState.currentNode}
            onChange={(currentNode) => setWindowsState({ currentNode })}
            resize={{ minimumPaneSizePercentage: 0 }}
          />
        )}
        <div hidden>
          {viewIds
            .filter((id) => !shown.includes(id))
            .map((id) => (
              <TargetHost key={id} target={targets[id]} />
            ))}
        </div>
      </div>
      {children}
    </>
  );
}
