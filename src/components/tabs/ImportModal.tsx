import {
  Button,
  Checkbox,
  Divider,
  FileInput,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { type FenError, makeFen, parseFen } from "chessops/fen";
import { useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { workspaceErrorMessage } from "../files/workspaceError";
import { match } from "ts-pattern";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import { addRecentFileAtom } from "@/state/atoms";
import { beginFileOpen } from "@/state/fileStructureChange";
import { parsePGN } from "@/utils/chess";
import { getChesscomGame } from "@/utils/chess.com/api";
import { translateChessopsError } from "@/utils/chessops";
import {
  createFile,
  ensureFileWorkspace,
  getFileGameName,
  loadFileGame,
  openFile,
  pickPgnFile,
} from "@/utils/files";
import { getLichessGame } from "@/utils/lichess/api";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { replaceNewTab, type ReplaceNewTabResult, type SetTabs, type Tab } from "@/utils/tabs";
import { defaultTree, getGameName, type TreeState } from "@/utils/treeReducer";
import AppModal from "../common/AppModal";
import GenericCard from "../common/GenericCard";
import { FILE_TYPES, type FileMetadata, type FileType } from "../files/file";

type ImportType = "PGN" | "Link" | "FEN";

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
  const [inFlightCount, setInFlightCount] = useState(0);
  const loading = inFlightCount > 0;
  const [fenError, setFenError] = useState<FenError | null>(null);

  const [save, setSave] = useState(false);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const store = useStore();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function reportImportError(cause: unknown, fieldError = false) {
    // A tab switch can unmount the owner's page while an import is pending.
    if (mountedRef.current) {
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
    } catch (error) {
      notifyUnlessCancelled(t("Common.Error"), error);
      return undefined;
    }
  }

  async function handleSubmit() {
    const submittingOwnerId = ownerId;
    setInFlightCount((count) => count + 1);
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
        let pgn: string;
        if (host === "chess.com") {
          const res = await getChesscomGame(link);
          if (res === null) {
            return;
          }
          pgn = res;
        } else if (host === "lichess") {
          const excludedPathParts = ["game", "export", "white", "black"];
          const gameId = new URL(link).pathname
            .split("/")
            .find((x) => x && !excludedPathParts.includes(x));
          if (!gameId) {
            setSubmitError(t("Import.UnsupportedGameUrl"));
            return;
          }
          pgn = await getLichessGame(gameId);
        } else {
          setSubmitError(t("Import.UnsupportedGameUrl"));
          return;
        }

        const tree = await parsePGN(pgn);
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
        const parsedFen = makeFen(res.value);
        const tree = defaultTree(parsedFen);
        tree.headers.fen = parsedFen;
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
      setInFlightCount((count) => count - 1);
    }
  }

  const Input = match(importType)
    .with("PGN", () => (
      <Stack>
        <div>
          <FileInput
            label={t("Common.PGNFile")}
            description={t("Import.PGN.ClickToSelect")}
            onClick={() => {
              void runUnlessCancelled(t("Common.Error"), async () => {
                const selected = await pickPgnFile();
                setFile(selected);
                setFilename(selected?.name || "");
              });
            }}
            value={file ? new File([new Blob()], file.name) : null}
            onChange={(e) => {
              if (e === null) {
                setFile(null);
                setFilename("");
              }
            }}
            disabled={pgn !== ""}
          />
          <Divider pt="xs" label={t("Import.Or")} labelPosition="center" />
          <Textarea
            value={pgn}
            disabled={file !== null}
            onChange={(event) => setPgn(event.currentTarget.value)}
            label={t("Common.PGNGame")}
            data-autofocus
            rows={8}
          />
        </div>

        <Checkbox
          label={t("Import.SaveToCollection")}
          checked={save}
          onChange={(e) => setSave(e.currentTarget.checked)}
        />

        {save && (
          <>
            <TextInput
              label={t("Common.Name")}
              placeholder={t("Common.EnterFileName")}
              required
              value={filename}
              onChange={(e) => setFilename(e.currentTarget.value)}
              error={error}
            />

            <Text fz="sm" fw="bold">
              {t("Files.FileType")}
            </Text>

            <SimpleGrid cols={3}>
              {FILE_TYPES.map((v) => (
                <GenericCard
                  key={v.value}
                  id={v.value}
                  isSelected={filetype === v.value}
                  setSelected={setFiletype}
                  Header={<Text ta="center">{t(v.translationKey)}</Text>}
                />
              ))}
            </SimpleGrid>
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
          if (e.key === "Enter") handleSubmit();
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
          if (e.key === "Enter") handleSubmit();
        }}
      />
    ))
    .exhaustive();

  const disabled = match(importType)
    .with("PGN", () => !pgn && !file)
    .with("Link", () => !link)
    .with("FEN", () => !fen)
    .exhaustive();

  return (
    <AppModal
      opened={openModal}
      onClose={() => setOpenModal(false)}
      title={t("Home.Card.ImportGame.Title")}
      pending={loading}
    >
      <Group grow mb="sm">
        <GenericCard
          id={"PGN"}
          isSelected={importType === "PGN"}
          setSelected={setImportType}
          Header={<Text ta="center">PGN</Text>}
        />

        <GenericCard
          id={"Link"}
          isSelected={importType === "Link"}
          setSelected={setImportType}
          Header={<Text ta="center">{t("Import.Online")}</Text>}
        />

        <GenericCard
          id={"FEN"}
          isSelected={importType === "FEN"}
          setSelected={setImportType}
          Header={<Text ta="center">FEN</Text>}
        />
      </Group>

      {Input}

      <Button
        fullWidth
        mt="md"
        radius="md"
        loading={loading}
        disabled={disabled}
        onClick={handleSubmit}
      >
        {loading ? t("Import.Importing") : t("Home.Card.ImportGame.Button")}
      </Button>

      {submitError && (
        <Text c="danger" size="sm" mt="xs">
          {submitError}
        </Text>
      )}
    </AppModal>
  );
}
