import { Button, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { workspaceErrorMessage } from "../files/workspaceError";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { normalizeError } from "@/platform/errors";
import { tabsAtom } from "@/state/atoms";
import { headersToPGN } from "@/utils/chess";
import { createFile, ensureFileWorkspace, openFile } from "@/utils/files";
import AppModal from "../common/AppModal";

export default function CreateRepertoireModal({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const listingCache = useSWRConfig();
  const [name, setName] = useState("");
  const [color, setColor] = useState<"white" | "black">("white");
  const [error, setError] = useState("");
  const { pending, run, isMounted } = useSingleFlight();

  const [, setTabs] = useAtom(tabsAtom);
  const navigate = useNavigate();

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("Common.RequireName"));
      return;
    }

    await run(async () => {
      try {
        const pgn = headersToPGN({
          id: 0,
          fen: INITIAL_FEN,
          black: "",
          white: "",
          result: "*",
          event: trimmedName,
          site: "",
          orientation: color,
        });

        const workspace = await ensureFileWorkspace();
        if (!isMounted()) return;
        if (!workspace) return;
        const result = await createFile({
          filename: trimmedName,
          filetype: "repertoire",
          content: { kind: "text", pgn },
          workspace,
          parent: workspace,
          listingCache,
        });
        if (!isMounted()) return;

        if (result.isErr) {
          setError(workspaceErrorMessage(result.error, result.error.message, t));
          return;
        }

        const fileInfo = result.value;
        const id = await openFile(fileInfo, setTabs, { tabName: trimmedName });
        if (!isMounted()) return;
        if (id === null) return;
        navigate({ to: "/" });

        setName("");
        setColor("white");
        setError("");
        setOpened(false);
      } catch (error) {
        if (!isMounted()) return;
        setError(workspaceErrorMessage(error, normalizeError(error).message, t));
      }
    });
  }

  return (
    <AppModal
      opened={opened}
      onClose={() => {
        if (!pending) setOpened(false);
      }}
      pending={pending}
      title={t("Home.Card.NewRepertoire.Title")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <Stack>
          <TextInput
            label={t("Common.Name")}
            placeholder={t("Home.Card.NewRepertoire.NamePlaceholder")}
            value={name}
            disabled={pending}
            onChange={(e) => {
              setName(e.currentTarget.value);
              if (error) setError("");
            }}
            error={error}
            data-autofocus
          />

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Home.Card.NewRepertoire.Color")}
            </Text>
            <SegmentedControl
              fullWidth
              value={color}
              disabled={pending}
              onChange={(v) => setColor(v as "white" | "black")}
              data={[
                { label: t("Common.WHITE"), value: "white" },
                { label: t("Common.BLACK"), value: "black" },
              ]}
            />
          </div>

          <Button type="submit" loading={pending}>
            {t("Common.Create")}
          </Button>
        </Stack>
      </form>
    </AppModal>
  );
}
