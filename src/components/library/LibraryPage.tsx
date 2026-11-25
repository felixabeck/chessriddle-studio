import { libraryButtonProps } from "./presentation";
import { ChessBaseGuideLink } from "./ChessBaseGuideLink";
import { libraryFilterAtom, librarySearchAtom, librarySelectionAtom } from "./memory";
import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Input,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
  useMatches,
  VisuallyHidden,
} from "@mantine/core";
import { TriangleAlert, ChevronRight, Search } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { fileWorkspaceDisplayNameAtom } from "@/state/atoms";
import useSWR, { useSWRConfig } from "swr";
import { tauri } from "@/platform/tauri";
import { CollectionMigration, LinkedCollection, isCollectionConsumer } from "./LinkedCollection";
import { useTranslation } from "react-i18next";
import DirectoryTree, { type CollectionPeer } from "@/components/files/DirectoryTree";
import { FILE_TYPES } from "@/components/files/file";
import { useFileWorkspace } from "@/components/files/useFileWorkspace";
import { useDatabaseLibrary } from "@/components/databases/useDatabaseLibrary";
import {
  DatabaseLibraryRow,
  DatabaseLibraryUnreadRow,
} from "@/components/databases/DatabaseLibraryRow";
import {
  DatabaseLibraryProgress,
  DatabaseLibraryStatus,
} from "@/components/databases/DatabaseLibraryStatus";
import { DatabaseLibraryDetail } from "@/components/databases/DatabaseLibraryDetail";
import { DatabaseLibraryDialogs } from "@/components/databases/DatabaseLibraryDialogs";
import AddOpponentAccount from "@/components/databases/AddOpponentAccount";
import { enterOnlineOpponent } from "@/components/databases/onlineOpponent";
import OnlineOpponentDownload from "@/components/databases/OnlineOpponentDownload";
import { FileWorkspaceCreation, FileWorkspaceStatus } from "@/components/files/FileWorkspaceStatus";
import { FileTrashNotice, FileTrashView } from "@/components/files/FileTrash";
import { FileWorkspaceDetail } from "@/components/files/FileWorkspaceDetail";
import { FileWorkspaceDialogs } from "@/components/files/FileWorkspaceDialogs";
import { databaseHandleKey } from "@/utils/db";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { useCollectionCurrencies } from "@/state/linkedCollections";
import { collectionsByFile, joinLibraryCollections } from "./libraryData";

const LibrarySyncControl = lazy(() =>
  import("./LibrarySyncControl").then((module) => ({ default: module.LibrarySyncControl })),
);

export default function LibraryPage() {
  const { t } = useTranslation();
  const split = useMatches({ base: false, sm: true }, { getInitialValueInEffect: false });
  const [selection, setSelection] = useAtom(librarySelectionAtom);
  const [search, setSearch] = useAtom(librarySearchAtom);
  const [filter, setFilter] = useAtom(libraryFilterAtom);
  const [visibleCount, setVisibleCount] = useState(0);
  const folderName = useAtomValue(fileWorkspaceDisplayNameAtom);
  const [migrationDatabase, setMigrationDatabase] = useState<string | null>(null);
  const [addingOpponent, setAddingOpponent] = useState(false);
  const store = useStore();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const { data: linkSupported } = useSWR("linkedCollectionsSupported", () =>
    tauri.linkedCollectionsSupported(),
  );
  const databases = useDatabaseLibrary(
    selection?.kind === "database" ? selection.key : null,
    (next) => {
      setSelection((current) => {
        const key =
          typeof next === "function"
            ? next(current?.kind === "database" ? current.key : null)
            : next;
        return key ? { kind: "database", key } : current?.kind === "database" ? null : current;
      });
    },
  );
  const selectedLibraryFile =
    selection?.kind === "workspace" && selection.entry?.type === "file" ? selection.entry : null;
  const omitNewGame =
    selectedLibraryFile != null &&
    collectionsByFile(databases.collections).has(fileWorkspaceKey(selectedLibraryFile.handle));
  const files = useFileWorkspace(
    selection?.kind === "workspace" ? selection.entry : null,
    (entry) => {
      setSelection((current) =>
        entry && files.workspace
          ? { kind: "workspace", workspaceKey: fileWorkspaceKey(files.workspace), entry }
          : current?.kind === "workspace"
            ? null
            : current,
      );
    },
    selection?.kind === "workspace" ? selection.workspaceKey : undefined,
    omitNewGame,
  );
  const workspaceKey = files.workspace ? fileWorkspaceKey(files.workspace) : null;
  useEffect(() => {
    if (linkSupported && files.data) void mutate("databases");
  }, [linkSupported, files.data, mutate]);
  const fileSelection =
    selection?.kind === "workspace" && selection.workspaceKey === workspaceKey
      ? files.selected
      : null;
  useEffect(() => {
    if (
      selection?.kind === "workspace" &&
      (selection.workspaceKey !== workspaceKey || (files.data && !files.selected))
    )
      setSelection(null);
    if (
      selection?.kind === "database" &&
      databases.databases &&
      !databases.convertingSelected &&
      !databases.databases.some((db) => databaseHandleKey(db.file) === selection.key)
    )
      setSelection(null);
  }, [
    selection,
    setSelection,
    workspaceKey,
    files.data,
    files.selected,
    databases.databases,
    databases.convertingSelected,
  ]);
  const normalizedSearch = search.trim().toLowerCase();
  useCollectionCurrencies(databases.collections);
  const {
    files: sourceFiles,
    byFile,
    missing,
  } = joinLibraryCollections(files.data ?? [], databases.collections);
  const linked =
    fileSelection?.type === "file" ? byFile.get(fileWorkspaceKey(fileSelection.handle)) : undefined;
  const selectedMissing =
    selection?.kind === "missingCollection"
      ? missing.find((collection) => collection.id === selection.id)
      : undefined;
  const peers: CollectionPeer[] = [
    ...missing
      .filter(
        (collection) =>
          (!filter || filter === "game" || filter === "tournament") &&
          (!normalizedSearch || collection.name.toLowerCase().includes(normalizedSearch)),
      )
      .map((collection) => ({
        type: "database" as const,
        section: "files" as const,
        key: `linked:${collection.id}`,
        name: collection.name,
        selected: selection?.kind === "missingCollection" && selection.id === collection.id,
        onSelect: () => setSelection({ kind: "missingCollection", id: collection.id }),
        content: (
          <Alert
            color="warning"
            variant="outline"
            role="presentation"
            title={collection.name}
            styles={{ title: { color: "var(--cf-card-foreground)" } }}
            icon={<TriangleAlert size="1.125rem" aria-hidden />}
            className="wrap-anywhere"
            miw={0}
            style={{ cursor: "pointer" }}
          >
            <Text size="xs" c="var(--cf-foreground)" className="wrap-anywhere">
              {t("Collections.Unavailable", {
                defaultValue:
                  "The search index is unavailable. Retry, or select the collection's source file again.",
              })}
            </Text>
            <Group justify="space-between" gap="xs" mt={4}>
              <Text size="xs" fw={500}>
                {t("Common.Select", { defaultValue: "Select" })}
              </Text>
              <ChevronRight size="1rem" aria-hidden />
            </Group>
          </Alert>
        ),
      })),
    ...databases.visibleDatabases
      .filter(
        (item) =>
          (!filter || filter === "database") &&
          (!normalizedSearch ||
            [
              item.filename,
              item.type === "success" ? item.title : item.transient ? item.filename : item.error,
              item.type === "success" ? item.description : "",
            ].some((value) => value.toLowerCase().includes(normalizedSearch))),
      )
      .map((item) => ({
        type: "database" as const,
        key: databaseHandleKey(item.file),
        name: item.type === "success" ? item.title : item.filename,
        selected: selection?.kind === "database" && selection.key === databaseHandleKey(item.file),
        onSelect: () => setSelection({ kind: "database", key: databaseHandleKey(item.file) }),
        onOpen: () => databases.openDatabase(item),
        content: (
          <DatabaseLibraryRow key={databaseHandleKey(item.file)} library={databases} item={item} />
        ),
      })),
    ...databases.unread
      .filter(
        (item) =>
          (!filter || filter === "database") &&
          (!normalizedSearch ||
            [item.filename, item.error].some((value) =>
              value.toLowerCase().includes(normalizedSearch),
            )),
      )
      .map((item) => ({
        type: "database" as const,
        key: item.key,
        name: item.filename,
        selected: false,
        content: <DatabaseLibraryUnreadRow key={item.key} item={item} />,
      })),
  ];
  const loadedEmpty =
    files.workspace &&
    files.data?.length === 0 &&
    databases.databases?.length === 0 &&
    databases.unread.length === 0 &&
    missing.length === 0 &&
    files.failure === "silent" &&
    databases.failure === "silent";
  const filteredEmpty = (normalizedSearch || filter) && visibleCount === 0;
  return (
    <Stack
      h="100%"
      mih={0}
      p={{ base: "xs", sm: "md" }}
      style={{ overflow: split ? "hidden" : "auto" }}
    >
      <Title
        miw={0}
        fz={{ base: "h3", sm: "h1" }}
        className="wrap-anywhere"
        style={{ flexShrink: split ? 0 : undefined }}
      >
        {t("Library.Title", { defaultValue: "Library" })}
      </Title>
      <Group
        role="group"
        aria-label={t("Common.AddNew")}
        gap="xs"
        wrap="wrap"
        style={{ flexShrink: split ? 0 : undefined }}
      >
        <FileWorkspaceCreation files={files} />
        <Button
          miw={0}
          disabled={databases.conversionInProgress}
          onClick={databases.add}
          {...libraryButtonProps}
          variant="default"
        >
          {t("Library.AddDatabase", { defaultValue: "Import or download database" })}
        </Button>
        <Button
          miw={0}
          onClick={() => setAddingOpponent(true)}
          {...libraryButtonProps}
          variant="default"
        >
          {t("Library.OnlineOpponent", { defaultValue: "Online opponent" })}
        </Button>
        <Suspense fallback={null}>
          <LibrarySyncControl workspace={files.workspace} />
        </Suspense>
      </Group>
      <SimpleGrid
        cols={split ? 2 : 1}
        flex={split ? "1 1 0" : "1 0 auto"}
        miw={0}
        mih={split ? 0 : undefined}
        style={{
          gridTemplateRows: split ? "minmax(0, 1fr)" : undefined,
        }}
      >
        <Paper
          withBorder
          p={{ base: 6, sm: "sm" }}
          miw={0}
          mih={split ? 0 : undefined}
          style={{ overflow: split ? "auto" : undefined }}
        >
          <Stack gap="sm" miw={0} h={split ? "100%" : undefined}>
            <Group gap="xs" wrap="wrap">
              <Input
                flex="2 1 12rem"
                size="sm"
                miw={0}
                leftSection={<Search size="1rem" />}
                placeholder={t("Common.Search")}
                aria-label={t("Common.Search")}
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
              <Select
                flex="1 1 9rem"
                size="sm"
                miw={0}
                clearable
                styles={{
                  option: { overflowWrap: "anywhere", minWidth: 0 },
                  label: { clip: "rect(0, 0, 0, 0)", width: "max-content" },
                }}
                clearButtonProps={{
                  "aria-label": t("Library.ClearTypeFilter", { defaultValue: "Clear type filter" }),
                  "aria-hidden": false,
                  tabIndex: 0,
                }}
                label={t("Files.FileType")}
                // Preserve the associated label for assistive technology and the native verifier.
                classNames={{ label: VisuallyHidden.classes.root }}
                placeholder={t("Library.AllTypes", { defaultValue: "All types" })}
                value={filter || null}
                onChange={(value) => setFilter(value ?? "")}
                data={[
                  ...FILE_TYPES.map(({ value, translationKey }) => ({
                    value,
                    label: t(translationKey),
                  })),
                  {
                    value: "database",
                    label: t("Library.GamesDatabase", { defaultValue: "Games database" }),
                  },
                ]}
              />
            </Group>
            <FileTrashNotice files={files} />
            <FileWorkspaceStatus files={files} />
            <DatabaseLibraryStatus library={databases} />
            <Box
              mah={split ? undefined : "60vh"}
              mih="8rem"
              flex={split ? "1 1 0" : undefined}
              // The reserved gutter keeps the scrollbar off the row actions.
              pr={split ? "xs" : undefined}
              style={{ overflow: "auto", scrollbarGutter: split ? "stable" : undefined }}
            >
              <DatabaseLibraryProgress library={databases} />
              <DirectoryTree
                {...files.listProps}
                selectedFile={fileSelection}
                files={filter === "database" ? [] : files.listProps.files}
                search={search}
                filter={filter}
                peers={peers}
                grouped
                folderName={files.workspace ? folderName : ""}
                label={t("Library.Title", { defaultValue: "Library" })}
                onVisibleCount={setVisibleCount}
              />
              {(loadedEmpty || filteredEmpty) && (
                <>
                  {/* The tree draws its headings only around rows, so an empty folder is named here. */}
                  {loadedEmpty && !filteredEmpty && folderName && (
                    <Text c="dimmed" ta="center" size="sm" className="wrap-anywhere">
                      {`${t("Files.Title", { defaultValue: "Files" })} · ${folderName}`}
                    </Text>
                  )}
                  <Text c="dimmed" ta="center">
                    {filteredEmpty
                      ? t("Common.NoResults")
                      : t("Library.Empty", {
                          defaultValue:
                            "Your library is empty. Create a file or add a database to get started.",
                        })}
                  </Text>
                  {loadedEmpty && !filteredEmpty && (
                    <Center>
                      <ChessBaseGuideLink />
                    </Center>
                  )}
                </>
              )}
              <FileTrashView files={files} />
            </Box>
          </Stack>
        </Paper>
        <Paper
          withBorder
          p={{ base: 6, sm: "sm" }}
          miw={0}
          mih={split ? 0 : undefined}
          style={{ overflow: split ? "auto" : undefined }}
        >
          {fileSelection ? (
            linked && files.workspace ? (
              <Stack h="100%" miw={0}>
                <LinkedCollection
                  key={linked.id}
                  collection={linked}
                  workspace={files.workspace}
                  files={sourceFiles}
                />
                <Box
                  flex={linked.status === "preservedOriginal" ? "0 0 100%" : "1 0 auto"}
                  h={linked.status === "preservedOriginal" ? "100%" : undefined}
                  miw={0}
                >
                  <FileWorkspaceDetail files={files} />
                </Box>
              </Stack>
            ) : (
              <FileWorkspaceDetail files={files} />
            )
          ) : selectedMissing && files.workspace ? (
            <LinkedCollection
              key={selectedMissing.id}
              collection={selectedMissing}
              workspace={files.workspace}
              files={sourceFiles}
            />
          ) : databases.selectedDatabase ? (
            <Stack key={`database:${databaseHandleKey(databases.selectedDatabase.file)}`} miw={0}>
              <DatabaseLibraryDetail library={databases} />
              {linkSupported &&
                databases.selectedDatabase.type === "success" &&
                files.workspace && (
                  <Button
                    {...libraryButtonProps}
                    onClick={() =>
                      setMigrationDatabase(databaseHandleKey(databases.selectedDatabase!.file))
                    }
                  >
                    {t("Collections.Migrate", { defaultValue: "Link existing collection" })}
                  </Button>
                )}
            </Stack>
          ) : (
            <Center mih="12rem">
              <Text c="dimmed" ta="center">
                {databases.convertingSelected
                  ? t("Library.Converting", {
                      defaultValue:
                        "This database is being converted. Its actions will return when conversion finishes.",
                    })
                  : t("Library.NoSelection", { defaultValue: "Select a library item" })}
              </Text>
            </Center>
          )}
        </Paper>
      </SimpleGrid>
      <FileWorkspaceDialogs files={files} />
      <DatabaseLibraryDialogs library={databases} />
      <AddOpponentAccount
        opened={addingOpponent}
        onClose={() => setAddingOpponent(false)}
        linked={[]}
        onLink={(account) => {
          void enterOnlineOpponent({ store, navigate, mutateCache: mutate, t }, account);
        }}
      />
      <OnlineOpponentDownload />
      {databases.selectedDatabase?.type === "success" && files.workspace && (
        <CollectionMigration
          opened={migrationDatabase === databaseHandleKey(databases.selectedDatabase.file)}
          onClose={() =>
            setMigrationDatabase((current) =>
              current === databaseHandleKey(databases.selectedDatabase!.file) ? null : current,
            )
          }
          database={databases.selectedDatabase}
          workspace={files.workspace}
          files={sourceFiles}
          onComplete={async () => {
            await mutate(isCollectionConsumer);
            setSelection((current) => (current === selection ? null : current));
          }}
        />
      )}
    </Stack>
  );
}
