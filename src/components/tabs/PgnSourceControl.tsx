import { Divider, FileInput, Textarea } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileMetadata } from "@/components/files/file";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { pickPgnFile } from "@/utils/files";

/** Shared PGN file-or-paste input control used across import and repertoire dialogs. */
export function PgnSourceControl({
  file,
  onFileChange,
  pgn,
  onPgnChange,
  disabled = false,
  autoFocusTextarea = false,
  rows = 8,
}: {
  file: FileMetadata | null;
  onFileChange: (file: FileMetadata | null) => void;
  pgn: string;
  onPgnChange: (pgn: string) => void;
  disabled?: boolean;
  autoFocusTextarea?: boolean;
  rows?: number;
}) {
  const { t } = useTranslation();

  return (
    <div>
      <FileInput
        label={t("Common.PGNFile")}
        description={t("Import.PGN.ClickToSelect")}
        onClick={() => {
          if (disabled) return;
          void runUnlessCancelled(t("Common.Error"), async () => {
            const selected = await pickPgnFile();
            onFileChange(selected);
          });
        }}
        value={file ? new File([new Blob()], file.name) : null}
        onChange={(e) => {
          if (disabled) return;
          if (e === null) {
            onFileChange(null);
          }
        }}
        disabled={disabled || pgn !== ""}
      />
      <Divider pt="xs" label={t("Import.Or")} labelPosition="center" />
      <Textarea
        value={pgn}
        disabled={disabled || file !== null}
        onChange={(event) => onPgnChange(event.currentTarget.value)}
        label={t("Common.PGNGame")}
        data-autofocus={autoFocusTextarea || undefined}
        rows={rows}
      />
    </div>
  );
}
