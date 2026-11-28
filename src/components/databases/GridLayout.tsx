import { Box } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useContext, useEffect, type ReactNode } from "react";
import { Mosaic, type MosaicNode } from "react-mosaic-component";
import {
  clampDatabasePercentage,
  databaseSplitAtoms,
  DatabaseLayoutContext,
} from "@/state/databaseLayout";
import "react-mosaic-component/react-mosaic-component.css";
import "@/styles/react-mosaic.css";
import classes from "./GridLayout.module.css";

type Tile = "table" | "preview";

function GridLayout({
  search,
  table,
  preview,
}: {
  search: ReactNode;
  table: ReactNode;
  preview: ReactNode;
}) {
  const { compact, minimum } = useContext(DatabaseLayoutContext);
  const ratio = useAtomValue(databaseSplitAtoms.displayed);
  const setTransient = useSetAtom(databaseSplitAtoms.transient);
  const commit = useSetAtom(databaseSplitAtoms.commit);
  const effective = clampDatabasePercentage(ratio, minimum);
  // Reflow interrupts a gesture. It never commits the unfinished pointer movement.
  useEffect(() => {
    if (compact) setTransient(null);
  }, [compact, setTransient]);
  useEffect(() => () => setTransient(null), [setTransient]);
  const update = (node: MosaicNode<Tile> | null, released: boolean) => {
    if (!node || typeof node === "string" || compact) return;
    const requested = node.splitPercentage ?? 50;
    if (!Number.isFinite(requested)) return;
    const percentage = clampDatabasePercentage(requested, minimum);
    if (released) commit(percentage);
    else setTransient(percentage);
  };
  return (
    <Box
      className={classes.layout}
      data-database-layout
      data-compact={compact || undefined}
      data-percentage={effective}
    >
      <Box className={classes.mosaicFrame}>
        <Mosaic<Tile>
          value={{
            direction: "row",
            first: "table",
            second: "preview",
            splitPercentage: effective,
          }}
          resize={compact ? "DISABLED" : { minimumPaneSizePercentage: minimum }}
          onChange={(node) => update(node, false)}
          onRelease={(node) => update(node, true)}
          renderTile={(id) => (
            <Box className={classes.pane} data-database-pane={id}>
              {id === "table" ? (
                <>
                  <Box className={classes.search}>{search}</Box>
                  <Box className={classes.table}>{table}</Box>
                </>
              ) : (
                <Box className={classes.previewContent}>{preview}</Box>
              )}
            </Box>
          )}
        />
      </Box>
    </Box>
  );
}

export default GridLayout;
