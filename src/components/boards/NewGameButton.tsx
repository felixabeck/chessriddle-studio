import { Button } from "@mantine/core";
import { Plus } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { tabsAtom } from "@/state/atoms";
import type { GameOrigin } from "@/state/workspaceTypes";
import { isRepertoireFile, repertoireFileColor } from "@/components/files/repertoireColor";
import { createTab, runTabCreation } from "@/utils/tabs";
import { defaultTree, type TreeState } from "@/utils/treeReducer";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryButtonProps } from "@/components/library/presentation";
import ExplainedAction from "@/components/library/ExplainedAction";

/**
 * A new chapter of a repertoire starts from the repertoire's side, so it is saved — and trained —
 * as that color. Other drafts start from an empty tree.
 */
async function draftTreeFor(origin: NewGameDraftOrigin): Promise<TreeState | undefined> {
  if (origin.kind !== "fileDraft" || !isRepertoireFile(origin.file)) return undefined;
  const color = await repertoireFileColor(origin.file);
  if (!color) return undefined;
  const tree = defaultTree();
  tree.headers.orientation = color;
  return tree;
}

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
            create: async () =>
              createTab({
                tab: {
                  name: t("Databases.NewGame", { defaultValue: "New game" }),
                  type: "analysis",
                },
                gameOrigin: origin,
                initialTree: await draftTreeFor(origin),
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
