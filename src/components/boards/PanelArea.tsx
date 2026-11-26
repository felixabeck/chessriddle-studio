import { Paper } from "@mantine/core";
import { X } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { PanelAreaId } from "@/state/boardArrangement";
import IconAction from "../common/IconAction";
import classes from "./PanelArea.module.css";
import PanelHeader from "./PanelHeader";

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
          <IconAction
            label={t("Board.Area.ReturnToTabs")}
            size="sm"
            variant="subtle"
            data-no-drag="true"
            onClick={onReturn}
          >
            <X size="0.875rem" />
          </IconAction>
        }
      />
      <div className={classes.body}>{children}</div>
    </Paper>
  );
}
