import { Button, Stack, Text } from "@mantine/core";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import type { FileMetadata } from "@/components/files/file";
import {
  notifyRepertoireImportSuccess,
  repertoireImportErrorMessage,
  repertoireMergeRefusalMessage,
} from "@/components/tabs/createRepertoireFromPgn";
import { PgnSourceControl } from "@/components/tabs/PgnSourceControl";
import { useAbortableAction } from "@/hooks/useAbortableAction";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { errorUnlessCancelled } from "@/platform/errors";
import { readRepertoireSource, type RepertoireImportSource } from "@/utils/repertoireImport";

/** Modal for importing PGN games into the currently open repertoire tab. */
export function ImportIntoRepertoireModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [pgn, setPgn] = useState("");
  const [error, setError] = useState("");
  const { canCancel, abort, runAbortable } = useAbortableAction(opened);
  const { pending, run, isMounted } = useSingleFlight();

  async function handleSubmit() {
    if (!file && pgn.trim() === "") return;

    const submittedDocumentId = store.getState().documentId;
    const source: RepertoireImportSource = file ? { kind: "file", file } : { kind: "text", pgn };

    await run(() =>
      runAbortable(async (signal) => {
        setError("");
        let readResult;
        try {
          readResult = await readRepertoireSource(source, { signal });
        } catch (err) {
          if (errorUnlessCancelled(err) === null || signal.aborted) {
            return;
          }
          if (!isMounted()) return;
          setError(repertoireImportErrorMessage(err, t));
          return;
        }

        if (!isMounted() || signal.aborted || store.getState().documentId !== submittedDocumentId) {
          return;
        }

        const state = store.getState();
        const orientation = state.headers.orientation || "white";
        const result = state.importIntoRepertoire(readResult.games, orientation);
        if (!result.ok) {
          setError(repertoireMergeRefusalMessage(result.reason, t));
          return;
        }

        notifyRepertoireImportSuccess(t, {
          read: readResult.games.length,
          skipped: readResult.skipped,
          report: result.report,
        });
        setFile(null);
        setPgn("");
        setError("");
        onClose();
      }),
    );
  }

  return (
    <AppModal
      opened={opened}
      onClose={() => {
        if (pending) return;
        onClose();
      }}
      pending={pending}
      title={t("Board.Practice.Build.ImportPgnTitle")}
    >
      <Stack>
        <PgnSourceControl
          file={file}
          onFileChange={(selected) => {
            setFile(selected);
            if (error) setError("");
          }}
          pgn={pgn}
          onPgnChange={(value) => {
            setPgn(value);
            if (error) setError("");
          }}
          disabled={pending}
          autoFocusTextarea
          rows={8}
        />

        {error && (
          <Text c="danger" size="sm" role="alert">
            {error}
          </Text>
        )}

        <Button
          fullWidth
          loading={pending}
          disabled={(!file && pgn.trim() === "") || pending}
          onClick={() => void handleSubmit()}
        >
          {pending ? t("Import.Importing") : t("Home.Card.ImportGame.Button")}
        </Button>

        {pending && canCancel && (
          <Button type="button" variant="default" fullWidth onClick={abort}>
            {t("Common.Cancel")}
          </Button>
        )}
      </Stack>
    </AppModal>
  );
}
