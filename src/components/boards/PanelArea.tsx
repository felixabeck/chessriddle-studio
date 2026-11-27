import { Paper } from "@mantine/core";
import { X } from "lucide-react";
import {
  createContext,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PanelAreaId } from "@/state/boardArrangement";
import IconAction from "../common/IconAction";
import classes from "./PanelArea.module.css";
import PanelHeader from "./PanelHeader";

export interface PanelAreaChrome {
  slot: HTMLElement | null;
}

/**
 * Non-null inside a detached `PanelArea` tile (with `slot` populated once the header's mount node
 * commits), `null` when a panel renders inside the tab strip.
 */
export const PanelAreaChromeContext = createContext<PanelAreaChrome | null>(null);

interface PanelAreaProps {
  panel: PanelAreaId;
  title: string;
  icon: ReactNode;
  onReturn: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onSuppressClick: (event: ReactMouseEvent) => void;
  onStartPlacing: () => void;
  children: ReactNode;
}

/**
 * A panel shown as its own tile on the analysis board, with its grip, icon, title and a button to
 * return it to the tab strip.
 */
export default function PanelArea({
  panel,
  title,
  icon,
  onReturn,
  onDragStart,
  onSuppressClick,
  onStartPlacing,
  children,
}: PanelAreaProps) {
  const { t } = useTranslation();
  const [chromeSlot, setChromeSlot] = useState<HTMLElement | null>(null);
  const chromeContext = useMemo<PanelAreaChrome>(() => ({ slot: chromeSlot }), [chromeSlot]);

  return (
    <Paper withBorder className={classes.area} data-panel-area={panel}>
      <PanelHeader
        area={panel}
        title={title}
        icon={icon}
        arrangeable
        onDragStart={onDragStart}
        onSuppressClick={onSuppressClick}
        onStartPlacing={onStartPlacing}
        actions={
          <>
            <span ref={setChromeSlot} className={classes.chromeSlot} />
            <IconAction
              label={t("Board.Area.ReturnToTabs")}
              size="sm"
              variant="subtle"
              data-no-drag="true"
              onClick={onReturn}
            >
              <X size="0.875rem" />
            </IconAction>
          </>
        }
      />
      <PanelAreaChromeContext.Provider value={chromeContext}>
        <div className={classes.body}>{children}</div>
      </PanelAreaChromeContext.Provider>
    </Paper>
  );
}
