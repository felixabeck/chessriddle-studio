import { useTabAtom } from "@/state/tabScope";
import { Button } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { localOptionsFamily } from "@/state/atoms";
import PositionSearchEditor from "./options/PositionSearchEditor";

/** Names the tab's match mode and opens the position search shared by every local source. */
function PositionSearchControl({ boardFen }: { boardFen: string }) {
  const { t } = useTranslation();
  const type = useAtomValue(useTabAtom(localOptionsFamily)).type;
  const [opened, setOpened] = useState(false);
  const mode =
    type === "partial" ? t("Board.Database.Local.Partial") : t("Board.Database.Local.Exact");
  return (
    <>
      <Button variant="default" size="compact-sm" onClick={() => setOpened(true)}>
        {t("Board.Database.PositionMode", { mode })}
      </Button>
      <AppModal
        opened={opened}
        onClose={() => setOpened(false)}
        title={t("Board.Database.Local.Position")}
        size="auto"
      >
        <PositionSearchEditor boardFen={boardFen} />
      </AppModal>
    </>
  );
}

export default PositionSearchControl;
