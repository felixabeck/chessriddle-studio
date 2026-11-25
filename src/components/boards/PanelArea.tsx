import { Group, Paper, Text } from "@mantine/core";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PanelAreaId } from "@/state/boardArrangement";
import IconAction from "../common/IconAction";
import classes from "./PanelArea.module.css";

interface PanelAreaProps {
  panel: PanelAreaId;
  title: string;
  icon: ReactNode;
  onReturn: () => void;
  children: ReactNode;
}

/**
 * A panel shown as its own tile on the analysis board, with its icon, title and a button to
 * return it to the tab strip.
 */
export default function PanelArea({ panel, title, icon, onReturn, children }: PanelAreaProps) {
  const { t } = useTranslation();

  return (
    <Paper withBorder className={classes.area} data-panel-area={panel}>
      <Group className={classes.header} justify="space-between" gap="xs" wrap="nowrap">
        <Group className={classes.titleGroup} gap="xs" wrap="nowrap">
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
          onClick={onReturn}
        >
          <X size="0.875rem" />
        </IconAction>
      </Group>
      <div className={classes.body}>{children}</div>
    </Paper>
  );
}
