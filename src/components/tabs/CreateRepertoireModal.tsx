import { Button, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { workspaceErrorMessage } from "../files/workspaceError";
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
  const [pending, setPending] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [, setTabs] = useAtom(tabsAtom);
  const navigate = useNavigate();

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("Common.RequireName"));
      return;
    }

    if (flight.current) return;
    flight.current = true;
    setPending(true);

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
      if (!mounted.current) return;
      if (!workspace) return;
      const result = await createFile({
        filename: trimmedName,
        filetype: "repertoire",
        content: { kind: "text", pgn },
        workspace,
        parent: workspace,
        listingCache,
      });
      if (!mounted.current) return;

      if (result.isErr) {
        setError(workspaceErrorMessage(result.error, result.error.message, t));
        return;
      }

      const fileInfo = result.value;
      const id = await openFile(fileInfo, setTabs, { tabName: trimmedName });
      if (!mounted.current) return;
      if (id === null) return;
      navigate({ to: "/" });

      setName("");
      setColor("white");
      setError("");
      setOpened(false);
    } catch (error) {
      if (!mounted.current) return;
      setError(workspaceErrorMessage(error, normalizeError(error).message, t));
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
    }
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
