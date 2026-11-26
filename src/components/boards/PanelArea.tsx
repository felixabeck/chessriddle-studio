import { Group, Paper, Text } from "@mantine/core";
import { GripVertical, X } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { PanelAreaId } from "@/state/boardArrangement";
import IconAction from "../common/IconAction";
import classes from "./PanelArea.module.css";

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
      <Group
        className={classes.header}
        justify="space-between"
        gap="xs"
        wrap="nowrap"
        onPointerDown={onDragStart}
        onClickCapture={onSuppressClick}
      >
        <Group className={classes.titleGroup} gap="xs" wrap="nowrap">
          <IconAction
            label={t("Board.Arrange.MoveArea", { area: title })}
            size="sm"
            variant="subtle"
            className={classes.grip}
            data-arrange-grip={panel}
            onClick={onStartPlacing}
          >
            <GripVertical size="0.875rem" />
          </IconAction>
          <span className={classes.icon} aria-hidden>
            {icon}
          </span>
          <Text fw={600} fz="sm" truncate className={classes.title}>
            {title}
          </Text>
        </Group>
        <IconAction
          label={t("Board.Area.ReturnToTabs")}
          size="sm"
          variant="subtle"
          data-no-drag="true"
          onClick={onReturn}
        >
          <X size="0.875rem" />
        </IconAction>
      </Group>
      <div className={classes.body}>{children}</div>
    </Paper>
  );
}
