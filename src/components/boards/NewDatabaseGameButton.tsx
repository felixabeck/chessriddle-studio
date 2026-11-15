import { Button } from "@mantine/core";
import { Plus } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle } from "@/bindings";
import { tabsAtom } from "@/state/atoms";
import { createTab, runTabCreation } from "@/utils/tabs";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryButtonProps } from "@/components/library/presentation";
import ExplainedAction from "@/components/library/ExplainedAction";

export default function NewDatabaseGameButton({
  database,
  disabled,
}: {
  database: DatabaseHandle | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const setTabs = useSetAtom(tabsAtom);
  const navigate = useNavigate();
  const unavailable = disabled || !database;
  return (
    <ExplainedAction explanation={t("Databases.NewGame.Desc")} disabled={unavailable}>
      <Button
        {...libraryButtonProps}
        disabled={unavailable}
        leftSection={<Plus size="1rem" />}
        onClick={() =>
          database &&
          void runTabCreation({
            create: () =>
              createTab({
                tab: { name: "Tab.NewTab", type: "analysis" },
                gameOrigin: { kind: "databaseDraft", database },
                setTabs,
              }),
            onSuccess: () => navigate({ to: "/" }),
            onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
          })
        }
      >
        {t("Databases.NewGame", { defaultValue: "New game" })}
      </Button>
    </ExplainedAction>
  );
}
