import { Group, Text } from "@mantine/core";
import { GripVertical } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { BoardAreaId } from "@/state/boardArrangement";
import IconAction from "../common/IconAction";
import classes from "./PanelArea.module.css";

export interface PanelHeaderProps {
  area?: BoardAreaId;
  title: string;
  icon: ReactNode;
  arrangeable?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSuppressClick?: (event: ReactMouseEvent) => void;
  onStartPlacing?: () => void;
  actions?: ReactNode;
}

/**
 * Shared window header frame for detached panels and the notation card: optional arrange grip
 * and drag handling, identity icon, title, and right-end actions excluded from drag start.
 */
export default function PanelHeader({
  area,
  title,
  icon,
  arrangeable = false,
  onDragStart,
  onSuppressClick,
  onStartPlacing,
  actions,
}: PanelHeaderProps) {
  const { t } = useTranslation();

  return (
    <Group
      className={arrangeable ? `${classes.header} ${classes.headerDraggable}` : classes.header}
      justify="space-between"
      gap="xs"
      wrap="nowrap"
      data-panel-header={area}
      onPointerDown={
        arrangeable && onDragStart
          ? (event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest('[data-no-drag="true"]')) return;
              onDragStart(event);
            }
          : undefined
      }
      onClickCapture={arrangeable ? onSuppressClick : undefined}
    >
      <Group className={classes.titleGroup} gap="xs" wrap="nowrap">
        {arrangeable && area && (
          <IconAction
            label={t("Board.Arrange.MoveArea", { area: title })}
            size="sm"
            variant="subtle"
            className={classes.grip}
            data-arrange-grip={area}
            onClick={onStartPlacing}
          >
            <GripVertical size="0.875rem" />
          </IconAction>
        )}
        <span className={classes.icon} aria-hidden>
          {icon}
        </span>
        <Text fw={600} fz="sm" truncate className={classes.title}>
          {title}
        </Text>
      </Group>
      {actions && (
        <Group gap={4} wrap="nowrap" className={classes.actions} data-no-drag="true">
          {actions}
        </Group>
      )}
    </Group>
  );
}
