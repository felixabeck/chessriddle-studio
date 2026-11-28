import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useStore } from "jotai";
import { Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { durabilityUncertainMessage } from "@/components/common/ConfirmModal";
import type { FileMetadata } from "@/components/files/file";
import { filesMutationErrorMessage } from "@/components/files/workspaceError";
import { normalizeError } from "@/platform/errors";
import { RepertoireColorControl } from "@/components/tabs/RepertoireColorControl";
import { tabsAtom } from "@/state/atoms";
import type { IndexedRepertoireFile } from "@/state/repertoireIndex";
import { firstBlockedFileGame, writeGamesOrientation } from "@/utils/fileGameWrite";
import { type RepertoireColor, sharedChapterColor } from "@/components/files/repertoireColor";

/** A repertoire file whose chapters without a color silently count as White. */
export type UncoloredRepertoire = {
  workspaceKey: string;
  file: FileMetadata;
  /** Zero-based game indices of the chapters without a color. */
  games: readonly number[];
  /** The color the file's other chapters share, else White. */
  suggested: RepertoireColor;
};

/**
 * Repertoire files with chapters that have no color, except files whose colored chapters are all
 * White: there the missing color already reads as the right one.
 */
export function uncoloredRepertoires(
  files: readonly IndexedRepertoireFile[],
): UncoloredRepertoire[] {
  const result: UncoloredRepertoire[] = [];
  for (const { workspaceKey, file, chapters } of files) {
    const games = chapters
      .filter(({ headers }) => !headers.orientation)
      .map(({ chapter }) => chapter);
    if (games.length === 0) continue;
    const shared = sharedChapterColor(chapters);
    if (shared === "white") continue;
    result.push({ workspaceKey, file, games, suggested: shared ?? "white" });
  }
  return result;
}

/**
 * Names each repertoire file whose chapters lack a color and offers the color choice of the
 * Library's Edit metadata dialog. Only the chapters without a color are written. `onColored` runs
 * after a successful write, and when the dialog closes after a failed one, because chapters written
 * before the failure already carry the color, so the caller reads the files again.
 */
export function RepertoireColorNotice({
  repertoires,
  onColored,
}: {
  repertoires: readonly UncoloredRepertoire[];
  onColored: () => void;
}) {
  const { t } = useTranslation();
  const atoms = useStore();
  const [target, setTarget] = useState<UncoloredRepertoire | null>(null);
  const [color, setColor] = useState<RepertoireColor>("white");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed write may have colored some chapters already; closing then reads the files again.
  const [partlyWritten, setPartlyWritten] = useState(false);

  if (repertoires.length === 0) return null;

  const open = (repertoire: UncoloredRepertoire) => {
    setTarget(repertoire);
    setColor(repertoire.suggested);
    setError(null);
    setPartlyWritten(false);
  };
  const close = () => {
    setTarget(null);
    if (partlyWritten) onColored();
  };
  const save = async () => {
    if (!target || pending) return;
    setError(null);
    if (firstBlockedFileGame(atoms.get(tabsAtom), target.file.handle, target.games) !== null) {
      setError(t("Files.LineSection.UnsavedTab"));
      return;
    }
    setPending(true);
    try {
      await writeGamesOrientation(target.file.handle, target.games, color);
      setTarget(null);
      onColored();
    } catch (cause) {
      const failure = normalizeError(cause);
      if (failure.category === "cancelled") return;
      setPartlyWritten(true);
      setError(
        failure.backendCategory === "stale-game"
          ? t("Files.LineSection.Stale")
          : failure.backendCategory === "durability"
            ? durabilityUncertainMessage(t)
            : filesMutationErrorMessage(cause, t("Files.OperationFailed"), t) ||
              t("Files.OperationFailed"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Alert color="warning" icon={<Palette size="1rem" />} data-repertoire-color-notice="">
        <Stack gap="xs">
          {repertoires.map((repertoire) => (
            <Group
              key={repertoire.workspaceKey}
              justify="space-between"
              wrap="wrap"
              gap="xs"
              data-repertoire-color-file=""
            >
              <Text size="sm" miw={0} style={{ overflowWrap: "anywhere", flex: "1 1 14rem" }}>
                {t("Repertoire.Color.MissingInFile", {
                  count: repertoire.games.length,
                  file: repertoire.file.name,
                })}
              </Text>
              <Button size="xs" variant="default" onClick={() => open(repertoire)}>
                {t("Repertoire.Color.SetColor")}
              </Button>
            </Group>
          ))}
        </Stack>
      </Alert>
      <AppModal
        opened={target !== null}
        onClose={close}
        pending={pending}
        title={t("Repertoire.Color.DialogTitle", { file: target?.file.name ?? "" })}
      >
        <Stack miw={0}>
          <Text size="sm">{t("Repertoire.Color.DialogText")}</Text>
          <RepertoireColorControl value={color} onChange={setColor} disabled={pending} />
          {error && (
            <Text size="sm" c="danger" role="alert" data-repertoire-color-error="">
              {error}
            </Text>
          )}
          <Button loading={pending} onClick={() => void save()} data-repertoire-color-save="">
            {t("Common.Save")}
          </Button>
        </Stack>
      </AppModal>
    </>
  );
}
