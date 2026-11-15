import { Tooltip } from "@mantine/core";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** Explains "Add Games" (PGN import) next to "New game" (enter a game by hand). */
export default function AddGamesTooltip({ children }: { children: ReactElement }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("Databases.Settings.AddGames.Desc")} multiline w={260}>
      {children}
    </Tooltip>
  );
}
