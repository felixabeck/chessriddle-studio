import { Button, Checkbox, Group, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { type FenError, makeFen, parseFen } from "chessops/fen";
import { useAtomValue, useStore } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { workspaceErrorMessage } from "../files/workspaceError";
import { match } from "ts-pattern";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useAbortableAction } from "@/hooks/useAbortableAction";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { addRecentFileAtom } from "@/state/atoms";
import { coachEnabledAtom } from "@/state/coachAvailability";
import { beginFileOpen } from "@/state/fileStructureChange";
import { parsePGN } from "@/utils/chess";
import { getChesscomGame } from "@/utils/chess.com/api";
import { translateChessopsError } from "@/utils/chessops";
import { createFile, ensureFileWorkspace, getFileGameName, loadFileGame } from "@/utils/files";
import { openFile } from "@/utils/openFile";
import { getLichessGame } from "@/utils/lichess/api";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { replaceNewTab, type ReplaceNewTabResult, type SetTabs, type Tab } from "@/utils/tabs";
import { defaultTree, getGameName, type TreeState } from "@/utils/treeReducer";
import AppModal from "../common/AppModal";
import GenericCard from "../common/GenericCard";
import { RetryableLazyPanel } from "../common/PanelErrorBoundary";
import { FILE_TYPES, type FileMetadata, type FileType } from "../files/file";
import { createRepertoireFromPgn, submitCreateRepertoireFromPgn } from "./createRepertoireFromPgn";
import classes from "./ImportModal.module.css";
import { PgnSourceControl } from "./PgnSourceControl";
import { RepertoireColorControl } from "./RepertoireColorControl";

function CardGroupFieldset({
  disabled,
  children,
}: {
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset disabled={disabled} className={classes.cardGroupFieldset}>
      {children}
    </fieldset>
  );
}

/** Testable seam for the "From photo" pane's lazy chunk loader. */
export const importPhotoPaneLoader = {
  load: () => import("./ImportPhotoPane"),
};

type ImportType = "PGN" | "Link" | "FEN" | "Photo";

/** Classifies a game link by its parsed hostname; a substring match would accept any host. */
function gameUrlHost(link: string): "chess.com" | "lichess" | null {
  let hostname: string;
  try {
    hostname = new URL(link).hostname;
  } catch {
    return null;
  }
  if (hostname === "chess.com" || hostname.endsWith(".chess.com")) return "chess.com";
  if (hostname === "lichess.org" || hostname.endsWith(".lichess.org")) return "lichess";
  return null;
}

export default function ImportModal({
  ownerId,
  openModal,
  setOpenModal,
  setTabs,
}: {
  ownerId: string;
  openModal: boolean;
  setOpenModal: React.Dispatch<React.SetStateAction<boolean>>;
  setTabs: SetTabs;
}) {
  const { t } = useTranslation();
  const listingCache = useSWRConfig();
  const [pgn, setPgn] = useState("");
  const [fen, setFen] = useState("");
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [link, setLink] = useState("");
  const [importType, setImportType] = useState<ImportType>("PGN");
  const [filetype, setFiletype] = useState<FileType>("game");
  const [color, setColor] = useState<"white" | "black">("white");
  const [inFlightCount, setInFlightCount] = useState(0);
  const { pending: repertoirePending, run: runRepertoireFlight } = useSingleFlight();
  const [photoReading, setPhotoReading] = useState(false);
  const loading = inFlightCount > 0 || repertoirePending;
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const [fenError, setFenError] = useState<FenError | null>(null);

  useEffect(() => {
    if (!coachEnabled && importType === "Photo") {
      setImportType("PGN");
    }
  }, [coachEnabled, importType]);

  const [save, setSave] = useState(false);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const store = useStore();
  const { canCancel, abort, isMounted, runAbortable } = useAbortableAction(openModal);

  function reportImportError(cause: unknown, fieldError = false) {
    // A tab switch can unmount the owner's page while an import is pending.
    if (isMounted()) {
      const message = workspaceErrorMessage(
        cause,
        cause instanceof Error ? cause.message : String(cause),
        t,
      );
      if (fieldError) setError(message);
      else setSubmitError(message);
    } else {
      notifyUnlessCancelled(t("Common.Error"), cause, "files");
    }
  }

  function replaceImportedTab(
    submittingOwnerId: string,
    tab: Omit<Tab, "value">,
    tree: TreeState,
  ): ReplaceNewTabResult | undefined {
    try {
      return replaceNewTab({ store, ownerId: submittingOwnerId, tab, tree });
    } catch (err) {
      notifyUnlessCancelled(t("Common.Error"), err);
      return undefined;
    }
  }

  async function handleSubmit() {
    const submittingOwnerId = ownerId;
    const isRepertoireImport = importType === "PGN" && save && filetype === "repertoire";
    if (isRepertoireImport) {
      const trimmedName = filename.trim();
      if (!trimmedName) {
        setError(t("Common.RequireName"));
        return;
      }
      if (!file && pgn.trim() === "") return;
      await runRepertoireFlight(async () => {
        setError("");
        setSubmitError("");
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
              ownerId: submittingOwnerId,
              store,
            }),
          onCreateRefusal: setError,
          onSourceRefusal: setSubmitError,
          onComplete: () => {
            setFile(null);
            setPgn("");
            setFilename("");
            setColor("white");
            setOpenModal(false);
          },
        });
      });
      return;
    }

    setInFlightCount((count) => count + 1);
    setError("");
    setSubmitError("");
    try {
      if (importType === "PGN") {
        if (file || pgn) {
          if (file) {
            const endSourceOpen = beginFileOpen(fileWorkspaceKey(file.handle));
            let endCopyOpen: (() => void) | undefined;
            try {
              let fileInfo: FileMetadata;
              const count = file.numGames;
              let loaded = await loadFileGame(file.handle, 0);
              if (save) {
                const workspace = await ensureFileWorkspace();
                if (!workspace) return;
                const newFile = await createFile({
                  filename,
                  filetype,
                  content: {
                    kind: "copy",
                    source: file.handle,
                    revision: loaded.revision,
                  },
                  workspace,
                  parent: workspace,
                  listingCache,
                });
                if (newFile.isErr) {
                  reportImportError(newFile.error, true);
                  return;
                }
                fileInfo = newFile.value;
                endCopyOpen = beginFileOpen(fileWorkspaceKey(fileInfo.handle));
                loaded = await loadFileGame(fileInfo.handle, 0);
              } else {
                fileInfo = {
                  type: "file",
                  handle: file.handle,
                  numGames: count,
                  name: filename,
                  lastModified: Date.now(),
                  metadata: {
                    type: "game",
                    tags: [],
                  },
                };
              }
              const tree = loaded.tree;
              const result = replaceImportedTab(
                submittingOwnerId,
                {
                  name: getFileGameName(tree.headers, fileInfo),
                  gameOrigin: {
                    kind: "file",
                    file: fileInfo,
                    gameNumber: 0,
                  },
                  type: "analysis",
                },
                tree,
              );

              if (result && (result.kind !== "refused" || result.stage === "workspace")) {
                store.set(addRecentFileAtom, {
                  name: fileInfo.name,
                  handle: fileInfo.handle,
                  type: fileInfo.metadata.type,
                });
              }
            } finally {
              endCopyOpen?.();
              endSourceOpen();
            }
          } else {
            const workspace = await ensureFileWorkspace();
            if (!workspace) return;
            const created = await createFile({
              filename: save ? filename : `import-${Date.now()}`,
              filetype: save ? filetype : "game",
              content: { kind: "text", pgn },
              workspace,
              parent: workspace,
              listingCache,
            });
            if (created.isErr) {
              if (save) {
                reportImportError(created.error, true);
                return;
              }
              throw created.error;
            }
            await openFile(created.value, setTabs);
          }
        }
      } else if (importType === "Link") {
        if (!link) {
          return;
        }
        const host = gameUrlHost(link);
        let linkPgn: string;
        if (host === "chess.com") {
          const res = await getChesscomGame(link);
          if (res === null) {
            return;
          }
          linkPgn = res;
        } else if (host === "lichess") {
          const excludedPathParts = ["game", "export", "white", "black"];
          const gameId = new URL(link).pathname
            .split("/")
            .find((x) => x && !excludedPathParts.includes(x));
          if (!gameId) {
            setSubmitError(t("Import.UnsupportedGameUrl"));
            return;
          }
          linkPgn = await getLichessGame(gameId);
        } else {
          setSubmitError(t("Import.UnsupportedGameUrl"));
          return;
        }

        const tree = await parsePGN(linkPgn);
        replaceImportedTab(
          submittingOwnerId,
          {
            name: getGameName(tree.headers),
            gameOrigin: { kind: "none" },
            type: "analysis",
          },
          tree,
        );
      } else if (importType === "FEN") {
        const res = parseFen(fen.trim());
        if (res.isErr) {
          setFenError(res.error);
          return;
        }
        setFenError(null);
        const tree = defaultTree(makeFen(res.value));
        replaceImportedTab(
          submittingOwnerId,
          {
            name: t("Home.Card.AnalysisBoard.Title"),
            gameOrigin: { kind: "none" },
            type: "analysis",
          },
          tree,
        );
      }
    } catch (e) {
      reportImportError(e);
    } finally {
      if (isMounted()) setInFlightCount((count) => count - 1);
    }
  }

  const Input = match(importType)
    .with("PGN", () => (
      <Stack>
        <PgnSourceControl
          file={file}
          onFileChange={(selected) => {
            setFile(selected);
            setFilename(selected?.name || "");
            if (submitError) setSubmitError("");
          }}
          pgn={pgn}
          onPgnChange={(value) => {
            setPgn(value);
            if (submitError) setSubmitError("");
          }}
          disabled={loading}
          autoFocusTextarea
          rows={8}
        />

        <Checkbox
          label={t("Import.SaveToCollection")}
          checked={save}
          disabled={loading}
          onChange={(e) => setSave(e.currentTarget.checked)}
        />

        {save && (
          <>
            <TextInput
              label={t("Common.Name")}
              placeholder={t("Common.EnterFileName")}
              required
              disabled={loading}
              value={filename}
              onChange={(e) => {
                setFilename(e.currentTarget.value);
                if (error) setError("");
              }}
              error={error}
            />

            <Text fz="sm" fw="bold">
              {t("Files.FileType")}
            </Text>

            <CardGroupFieldset disabled={loading}>
              <SimpleGrid cols={3} spacing="xs">
                {FILE_TYPES.map((v) => (
                  <GenericCard
                    key={v.value}
                    id={v.value}
                    isSelected={filetype === v.value}
                    setSelected={(value) => {
                      if (!loading) setFiletype(value);
                    }}
                    Header={
                      <Text ta="center" size="sm">
                        {t(v.translationKey)}
                      </Text>
                    }
                  />
                ))}
              </SimpleGrid>
            </CardGroupFieldset>

            {filetype === "repertoire" && (
              <RepertoireColorControl value={color} onChange={setColor} disabled={loading} />
            )}
          </>
        )}
      </Stack>
    ))
    .with("Link", () => (
      <TextInput
        value={link}
        onChange={(event) => setLink(event.currentTarget.value)}
        label={t("Import.GameURL")}
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSubmit();
        }}
      />
    ))
    .with("FEN", () => (
      <TextInput
        value={fen}
        onChange={(event) => setFen(event.currentTarget.value)}
        error={fenError && translateChessopsError(t, fenError)}
        label="FEN"
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSubmit();
        }}
      />
    ))
    .with("Photo", () => (
      <RetryableLazyPanel
        load={() => importPhotoPaneLoader.load()}
        panelProps={{
          ownerId,
          onClose: () => setOpenModal(false),
          replaceImportedTab,
          onReadingChange: setPhotoReading,
        }}
        operation="scoresheet-import-pane-load"
        logLabel="Scoresheet import pane failed to load"
        loadFailedText={t("Scoresheet.LoadFailed")}
        retryLabel={t("Common.Retry")}
      />
    ))
    .exhaustive();

  const disabled = match(importType)
    .with("PGN", () => pgn.trim() === "" && !file)
    .with("Link", () => !link)
    .with("FEN", () => !fen)
    .with("Photo", () => true)
    .exhaustive();

  return (
    <AppModal
      opened={openModal}
      onClose={() => {
        if (loading || photoReading) return;
        setOpenModal(false);
      }}
      title={t("Home.Card.ImportGame.Title")}
      pending={loading || photoReading}
    >
      <CardGroupFieldset disabled={loading}>
        <Group grow mb="sm">
          {(
            [
              { id: "PGN", label: "PGN" },
              { id: "Link", label: t("Import.Online") },
              { id: "FEN", label: "FEN" },
              ...(coachEnabled ? [{ id: "Photo" as const, label: t("Import.FromPhoto") }] : []),
            ] satisfies Array<{ id: ImportType; label: string }>
          ).map((mode) => (
            <GenericCard<ImportType>
              key={mode.id}
              id={mode.id}
              isSelected={importType === mode.id}
              setSelected={(value) => {
                if (!loading) setImportType(value);
              }}
              Header={<Text ta="center">{mode.label}</Text>}
            />
          ))}
        </Group>
      </CardGroupFieldset>

      {Input}

      {importType !== "Photo" && (
        <>
          <Button
            fullWidth
            mt="md"
            radius="md"
            loading={loading}
            disabled={loading || disabled}
            onClick={() => void handleSubmit()}
          >
            {loading ? t("Import.Importing") : t("Home.Card.ImportGame.Button")}
          </Button>

          {submitError && (
            <Text c="danger" size="sm" mt="xs">
              {submitError}
            </Text>
          )}

          {loading && canCancel && (
            <Button type="button" variant="default" fullWidth mt="xs" onClick={abort}>
              {t("Common.Cancel")}
            </Button>
          )}
        </>
      )}
    </AppModal>
  );
}
