import { Button, Stack, Text, TextInput } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import type { FileMetadata } from "../files/file";
import { workspaceErrorMessage } from "../files/workspaceError";
import { useAbortableAction } from "@/hooks/useAbortableAction";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { normalizeError } from "@/platform/errors";
import { tabsAtom } from "@/state/atoms";
import { headersToPGN } from "@/utils/chess";
import { createFile, ensureFileWorkspace } from "@/utils/files";
import { openFile } from "@/utils/openFile";
import AppModal from "../common/AppModal";
import { createRepertoireFromPgn, submitCreateRepertoireFromPgn } from "./createRepertoireFromPgn";
import { PgnSourceControl } from "./PgnSourceControl";
import { RepertoireColorControl } from "./RepertoireColorControl";

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
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [pgn, setPgn] = useState("");
  const [error, setError] = useState("");
  const [importError, setImportError] = useState("");
  const { canCancel, abort, runAbortable } = useAbortableAction(opened);
  const { pending, run, isMounted } = useSingleFlight();

  const [, setTabs] = useAtom(tabsAtom);
  const navigate = useNavigate();

  function resetDraft() {
    setName("");
    setColor("white");
    setFile(null);
    setPgn("");
    setError("");
    setImportError("");
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("Common.RequireName"));
      return;
    }

    const hasPgnSource = file !== null || pgn.trim() !== "";

    await run(async () => {
      setError("");
      setImportError("");
      if (hasPgnSource) {
        await submitCreateRepertoireFromPgn({
          runAbortable,
          isMounted,
          t,
          request: (signal) =>
            createRepertoireFromPgn({
              name: trimmedName,
              color,
              source: file ? { kind: "file", file } : { kind: "text", pgn },
              listingCache,
              setTabs,
              t,
              signal,
            }),
          onCreateRefusal: setError,
          onSourceRefusal: setImportError,
          onComplete: (outcome) => {
            if (outcome.status === "opened") {
              navigate({ to: "/" });
            }
            resetDraft();
            setOpened(false);
          },
        });
        return;
      }

      try {
        const emptyPgn = headersToPGN({
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
          content: { kind: "text", pgn: emptyPgn },
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

        resetDraft();
        setOpened(false);
      } catch (err) {
        if (!isMounted()) return;
        setError(workspaceErrorMessage(err, normalizeError(err).message, t));
      }
    });
  }

  return (
    <AppModal
      opened={opened}
      onClose={() => {
        if (pending) return;
        setOpened(false);
      }}
      pending={pending}
      title={t("Home.Card.NewRepertoire.Title")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
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

          <RepertoireColorControl value={color} onChange={setColor} disabled={pending} />

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Home.Card.NewRepertoire.FromPgn")}
            </Text>
            <PgnSourceControl
              file={file}
              onFileChange={(selected) => {
                setFile(selected);
                if (importError) setImportError("");
              }}
              pgn={pgn}
              onPgnChange={(value) => {
                setPgn(value);
                if (importError) setImportError("");
              }}
              disabled={pending}
              rows={5}
            />
          </div>

          {importError && (
            <Text c="danger" size="sm" role="alert">
              {importError}
            </Text>
          )}

          <Button type="submit" loading={pending}>
            {t("Common.Create")}
          </Button>

          {pending && canCancel && (
            <Button type="button" variant="default" onClick={abort}>
              {t("Common.Cancel")}
            </Button>
          )}
        </Stack>
      </form>
    </AppModal>
  );
}
