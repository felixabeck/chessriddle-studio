import { Button } from "@mantine/core";
import { Plus } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { tabsAtom } from "@/state/atoms";
import type { GameOrigin } from "@/state/workspaceTypes";
import { createTab, runTabCreation } from "@/utils/tabs";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryButtonProps } from "@/components/library/presentation";
import ExplainedAction from "@/components/library/ExplainedAction";

export type NewGameDraftOrigin = Extract<GameOrigin, { kind: "databaseDraft" | "fileDraft" }>;

export default function NewGameButton({
  origin,
  explanation,
  disabled,
  fullWidth = false,
}: {
  origin: NewGameDraftOrigin | null;
  explanation: string;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  const { t } = useTranslation();
  const setTabs = useSetAtom(tabsAtom);
  const navigate = useNavigate();
  const unavailable = disabled || !origin;
  return (
    <ExplainedAction explanation={explanation} disabled={unavailable}>
      <Button
        {...libraryButtonProps}
        disabled={unavailable}
        fullWidth={fullWidth}
        // A stretched button also takes wrap-button so its label keeps word-wrapping padding at
        // full width (see src/styles/global.css .wrap-button); wrappingButton alone does not.
        className={fullWidth ? "wrap-button" : undefined}
        leftSection={<Plus size="1rem" />}
        onClick={() =>
          origin &&
          void runTabCreation({
            create: () =>
              createTab({
                tab: {
                  name: t("Databases.NewGame", { defaultValue: "New game" }),
                  type: "analysis",
                },
                gameOrigin: origin,
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
