import { libraryButtonProps, libraryClasses } from "@/components/library/presentation";
import NewDatabaseGameButton from "@/components/boards/NewDatabaseGameButton";
import { tauri } from "@/platform/tauri";
import { listingFailure } from "@/components/files/listingFailure";
import { useNativePicker } from "@/hooks/useNativePicker";
import {
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Rating,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useToggle } from "@mantine/hooks";
import { ArrowRight, Database, Plus } from "lucide-react";
import { Link, useNavigate, type RegisteredRouter } from "@tanstack/react-router";
import { useAtom } from "jotai";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import {
  refreshDatabaseList,
  revalidateDatabaseList,
  useDatabaseList,
} from "@/hooks/useDatabaseList";
import type { DatabaseHandle, DatabaseInfo } from "@/bindings";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import {
  databaseConversionStateAtom,
  databaseConversionRefreshFailedAtom,
  referenceDbAtom,
  runDatabaseConversion,
} from "@/state/atoms";
import { activeDatabaseViewStore, useActiveDatabaseViewStore } from "@/state/store/database";
import { databaseHandleKey, sameDatabaseHandle, type SuccessDatabaseInfo } from "@/utils/db";
import { pickPgnFile } from "@/utils/files";
import { formatBytes, formatNumber } from "@/utils/format";
import ConfirmModal from "../common/ConfirmModal";
import GenericCard from "../common/GenericCard";
import AddDatabase from "./AddDatabase";
import {
  deleteDatabaseAndInvalidate,
  invalidateDeletedDatabase,
  runAddGamesToDatabase,
  runPgnExport,
  refreshAfterDatabaseConversion,
} from "./databaseMutation";
import { PlayerSearchInput } from "./PlayerSearchInput";
import { databaseRouteTarget, type DatabaseRouteTarget } from "./databaseRoute";
import { databaseLoadFailureMessage } from "./databaseLoadFailure";
import { capabilityKey } from "@/utils/pathCapabilities";
import { standaloneDatabases } from "@/components/library/libraryData";
import { openDatabaseTable } from "@/components/library/openDatabaseTable";

export function useDatabaseLibrary(
  selected: string | null,
  setSelected: Dispatch<SetStateAction<string | null>>,
) {
  const { t } = useTranslation();
  const picker = useNativePicker();

  // Opening the overview ends the active session; mount-only lets double-click and Explore restore the sidebar's database target.
  useEffect(() => {
    if (activeDatabaseViewStore.getState().database) {
      activeDatabaseViewStore.getState().clearDatabase();
    }
  }, []);

  const { data, error, mutate, owner: databaseOwner } = useDatabaseList();
  const databases = data?.databases;
  const unread = (data?.unread ?? []).map((item, index) => ({
    ...item,
    key: `${capabilityKey(data!.root)}:unread:${index}`,
  }));
  const failure = listingFailure(error);
  const loadFailureMessage = databaseLoadFailureMessage(error, t);
  const needsFolder = failure !== "silent" && failure !== "retry";
  function chooseWorkspace() {
    return picker.run(async () => {
      const result = await runUnlessCancelled(
        t("Common.Error"),
        () => tauri.issueDatabaseWorkspace(),
        "database",
      );
      if (!result) return;
      await databaseOwner!.supersede();
      await mutate();
    });
  }
  const { mutate: mutateCache } = useSWRConfig();
  const { run, supersede } = databaseOwner!;
  const revalidateDatabases = useCallback(
    () => revalidateDatabaseList({ run, supersede }, mutateCache),
    [run, supersede, mutateCache],
  );

  const [open, setOpen] = useState(false);
  const [referenceDatabase, setReferenceDatabase] = useAtom(referenceDbAtom);
  const [conversionState, setConversionState] = useAtom(databaseConversionStateAtom);
  const [importRefreshFailed, setImportRefreshFailed] = useAtom(
    databaseConversionRefreshFailedAtom,
  );
  function retryImportRefresh() {
    return runUnlessCancelled(
      t("Common.Error"),
      async () => {
        await refreshDatabaseList(databaseOwner!, mutateCache);
        setImportRefreshFailed(false);
      },
      "database",
    );
  }
  const conversionInProgress = conversionState.length > 0;
  const visibleDatabases = useMemo(() => {
    return standaloneDatabases(databases ?? [], conversionState);
  }, [databases, conversionState]);
  const selectedDatabase = useMemo(
    () => visibleDatabases.find((db) => databaseHandleKey(db.file) === selected) ?? null,
    [visibleDatabases, selected],
  );
  const setActiveDatabase = useActiveDatabaseViewStore((store) => store.setDatabase);

  const isReference = sameDatabaseHandle(referenceDatabase, selectedDatabase?.file);

  const [deleteModal, setDeleteModal] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const selectedIsTransient = selectedDatabase?.type === "error" && !!selectedDatabase.transient;
  useEffect(() => {
    if (selectedIsTransient) setDeleteModal(false);
  }, [selectedIsTransient]);

  function invalidateDeletedDatabaseState(deleted: DatabaseHandle) {
    setSelected(
      (currentSelected) =>
        invalidateDeletedDatabase(deleted, {
          selected: currentSelected,
          reference: referenceDatabase,
          active: activeDatabaseViewStore.getState().database,
        }).selected,
    );
    if (sameDatabaseHandle(referenceDatabase, deleted)) {
      setReferenceDatabase(null);
      void tauri.clearGames();
    }
    if (sameDatabaseHandle(activeDatabaseViewStore.getState().database?.file, deleted)) {
      activeDatabaseViewStore.getState().clearDatabase();
    }
    // Clear every result-set cache bound to this exact opaque handle. A later
    // revalidation must never resurrect data belonging to the deleted database.
    void mutateCache(
      (key) =>
        Array.isArray(key) &&
        key.length > 1 &&
        typeof key[1] === "object" &&
        key[1] !== null &&
        "id" in key[1] &&
        "kind" in key[1] &&
        key[1].kind === "database" &&
        sameDatabaseHandle(key[1] as DatabaseHandle, deleted),
      undefined,
      { revalidate: false },
    );
    void revalidateDatabases();
  }

  function changeReferenceDatabase(file: DatabaseHandle) {
    void tauri.clearGames();
    if (sameDatabaseHandle(file, referenceDatabase)) {
      setReferenceDatabase(null);
    } else {
      setReferenceDatabase(file);
    }
  }
  const navigate = useNavigate();

  function openDatabase(database: SuccessDatabaseInfo) {
    openDatabaseTable(database, navigate);
  }

  return {
    databases,
    visibleDatabases,
    collections: data?.collections ?? [],
    unread,
    renderUnreadRow: (item: (typeof unread)[number]) => (
      <Stack key={item.key} gap={4} miw={0} className={libraryClasses.unreadDatabase}>
        <Text fw={500} fz="sm" className="wrap-anywhere">
          {item.filename}
        </Text>
        <Text c="danger" size="sm" className="wrap-anywhere">
          {item.error}
        </Text>
      </Stack>
    ),
    selectedDatabase,
    failure,
    conversionInProgress,
    convertingSelected: conversionState.some(
      (entry) => entry.targetDatabase && databaseHandleKey(entry.targetDatabase) === selected,
    ),
    openDatabase: (item: NonNullable<typeof databases>[number]) => {
      if (item.type === "success") openDatabase(item);
    },
    add: () => setOpen(true),
    renderRow: (item: NonNullable<typeof databases>[number]) => (
      <GenericCard
        tabIndex={-1}
        id={databaseHandleKey(item.file)}
        key={databaseHandleKey(item.file)}
        isSelected={sameDatabaseHandle(selectedDatabase?.file, item.file)}
        setSelected={setSelected}
        error={item.type === "error" && !item.transient ? item.error : ""}
        orientation="horizontal"
        className={libraryClasses.databaseCard}
        onDoubleClick={() => {
          if (item.type === "error") return;
          openDatabase(item);
        }}
        Header={
          <div className={libraryClasses.databaseMain}>
            <div className={libraryClasses.databaseName}>
              <span className={libraryClasses.databaseIcon} aria-hidden>
                <Database size="1.125rem" />
              </span>
              <Box miw={0}>
                <Text fw={600} fz="sm" className="wrap-anywhere">
                  {item.type === "success"
                    ? item.title
                    : item.transient
                      ? item.filename
                      : item.error}
                </Text>
                {!(item.type === "error" && item.transient) && (
                  <Text size="xs" c="dimmed" className="wrap-anywhere">
                    {item.type === "error" ? item.filename : item.description}
                  </Text>
                )}
              </Box>
            </div>
            {item.type === "error" && item.transient ? (
              <Group gap="xs" role="status" miw={0} style={{ gridColumn: "2 / -1" }}>
                <Loader size="xs" />
                <Text size="sm" className="wrap-anywhere" miw={0}>
                  {item.transient === "upgrading"
                    ? t("Databases.Upgrading.Label")
                    : t("Databases.Busy.Label")}
                </Text>
              </Group>
            ) : (
              <>
                <div className={libraryClasses.databaseStat}>
                  <span className={libraryClasses.statLabel}>{t("Databases.Card.Games")}</span>
                  <Text fz="sm" fw={600}>
                    {item.type === "success" ? formatNumber(item.game_count) : "???"}
                  </Text>
                </div>
                <div className={libraryClasses.databaseStat}>
                  <span className={libraryClasses.statLabel}>{t("Databases.Card.Storage")}</span>
                  <Text fz="sm" c="dimmed">
                    {item.type === "success" ? formatBytes(item.storage_size ?? 0) : "???"}
                  </Text>
                </div>
              </>
            )}
          </div>
        }
        footer={
          item.type === "success" ? (
            <Group justify="space-between" gap="xs" wrap="wrap">
              <Rating
                aria-label={t("Databases.Settings.ReferenceDatabase")}
                value={sameDatabaseHandle(referenceDatabase, item.file) ? 1 : 0}
                count={1}
                onChange={() => {
                  changeReferenceDatabase(item.file);
                }}
              />
              <Button
                variant="default"
                miw={0}
                {...libraryButtonProps}
                px="xs"
                onClick={() => openDatabase(item)}
              >
                {t("Databases.OpenDatabase", { defaultValue: "Open database" })}
              </Button>
            </Group>
          ) : undefined
        }
      />
    ),
    status: (
      <Stack
        className="wrap-anywhere"
        role="region"
        aria-label={t("Databases.Title")}
        data-library-source="databases"
      >
        {failure !== "silent" && (
          <Stack role="alert" c="danger" p={{ base: "xs", sm: "md" }} miw={0}>
            <Text className="wrap-anywhere">{loadFailureMessage}</Text>
            {needsFolder ? (
              <Button
                miw={0}
                px="xs"
                disabled={picker.pending}
                onClick={() => void chooseWorkspace()}
                {...libraryButtonProps}
              >
                {t("Databases.ChooseFolder", { defaultValue: "Choose database folder" })}
              </Button>
            ) : (
              <Button
                {...libraryButtonProps}
                onClick={() => void (importRefreshFailed ? retryImportRefresh() : mutate())}
              >
                {t("Databases.LoadRetry", { defaultValue: "Retry" })}
              </Button>
            )}
          </Stack>
        )}

        {!databases && failure === "silent" && (
          <Text role="status">
            {t("Library.DatabasesLoading", { defaultValue: "Loading games databases…" })}
          </Text>
        )}
      </Stack>
    ),
    progress: (
      <>
        {importRefreshFailed && (
          <Button variant="default" onClick={() => void retryImportRefresh()}>
            {t("Databases.LoadRetry", { defaultValue: "Retry" })}
          </Button>
        )}
        {conversionState.map((entry) => (
          <Fragment key={entry.id}>
            <Group
              px="xs"
              py={6}
              gap="xs"
              justify="space-between"
              role="group"
              aria-label={`${t("Databases.Add.Convert")}: ${entry.sourceFileName ?? entry.targetDatabaseTitle ?? entry.id}`}
            >
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: "1 1 12rem" }}>
                <Loader size="xs" />
                <Text size="sm" className="wrap-anywhere">
                  {entry.sourceFileName || entry.targetDatabaseTitle
                    ? `${t("Databases.Add.Convert")}: ${entry.sourceFileName ?? entry.targetDatabaseTitle}`
                    : t("Databases.Add.Convert")}
                </Text>
              </Group>
              {entry.totalGames > 0 && (
                <Text size="xs" c="dimmed" className="wrap-anywhere">
                  {t("Files.GameCountSuffix", { number: entry.totalGames })}
                  {entry.elapsedSeconds > 0
                    ? ` • ${(entry.totalGames / entry.elapsedSeconds).toFixed(1)} games/s`
                    : ""}
                </Text>
              )}
              {entry.cancel && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  loading={entry.cancelPending}
                  disabled={entry.cancelPending}
                  aria-label={`${t("Common.Cancel")}: ${entry.sourceFileName ?? entry.targetDatabaseTitle ?? entry.id}`}
                  onClick={() => void entry.cancel?.()}
                >
                  {t("Common.Cancel")}
                </Button>
              )}
            </Group>
            <Divider />
          </Fragment>
        ))}
      </>
    ),
    detail: selectedDatabase ? (
      <Stack>
        {selectedDatabase.type === "error" ? (
          selectedDatabase.transient ? (
            <>
              <Text fz="lg" fw="bold" className="wrap-anywhere">
                {selectedDatabase.transient === "upgrading"
                  ? t("Databases.Upgrading.Label")
                  : t("Databases.Busy.Label")}
              </Text>
              <Text className="wrap-anywhere">{selectedDatabase.error}</Text>
            </>
          ) : selectedDatabase.upgradeFailed ? (
            <>
              <Text fz="lg" fw="bold" className="wrap-anywhere">
                {t("Databases.UpgradeFailed.Description")}
              </Text>
              <Text className="wrap-anywhere">{selectedDatabase.error}</Text>
            </>
          ) : selectedDatabase.databaseAdmission === true ? (
            <>
              <Text fz="lg" fw="bold">
                {t("Databases.LoadError.Admission")}
              </Text>
              <Text>{t("Databases.LoadError.AdmissionRecovery")}</Text>
            </>
          ) : (
            <>
              <Text fz="lg" fw="bold">
                {t("Databases.LoadError.Title")}
              </Text>

              <Text>
                <Text td="underline" span>
                  {t("Common.Reason")}:
                </Text>
                {` ${selectedDatabase.error}`}
              </Text>

              <Text>{t("Databases.LoadError.Description")}</Text>
            </>
          )
        ) : (
          <>
            <Divider variant="dashed" label={t("Common.GeneralSettings")} />
            <GeneralSettings
              key={databaseHandleKey(selectedDatabase.file)}
              selectedDatabase={selectedDatabase}
              mutate={revalidateDatabases}
            />
            <Checkbox
              label={t("Databases.Settings.ReferenceDatabase")}
              checked={isReference}
              onChange={() => {
                changeReferenceDatabase(selectedDatabase.file);
              }}
            />
            <IndexInput
              indexed={selectedDatabase.indexed}
              file={selectedDatabase.file}
              reload={revalidateDatabases}
            />

            <Divider variant="dashed" label={t("Common.Data")} />
            <Group grow>
              <Stack gap={0} justify="center" ta="center">
                <Text size="md" tt="uppercase" fw="bold" c="dimmed">
                  {t("Databases.Card.Games")}
                </Text>
                <Text fw={700} size="lg">
                  {formatNumber(selectedDatabase.game_count)}
                </Text>
              </Stack>
              <Stack gap={0} justify="center" ta="center">
                <Text size="md" tt="uppercase" fw="bold" c="dimmed">
                  {t("Databases.Card.Players")}
                </Text>
                <Text fw={700} size="lg">
                  {formatNumber(selectedDatabase.player_count - 1)}
                </Text>
              </Stack>
              <Stack gap={0} justify="center" ta="center">
                <Text size="md" tt="uppercase" fw="bold" c="dimmed">
                  {t("Databases.Settings.Events")}
                </Text>
                <Text fw={700} size="lg">
                  {formatNumber(selectedDatabase.event_count - 1)}
                </Text>
              </Stack>
            </Group>

            <div>
              {selectedDatabase.type === "success" && (
                <Button
                  {...libraryButtonProps}
                  component={Link<RegisteredRouter, string, DatabaseRouteTarget["to"]>}
                  {...databaseRouteTarget(selectedDatabase)}
                  onClick={(event) => {
                    if (setActiveDatabase(selectedDatabase) !== true) event.preventDefault();
                  }}
                  fullWidth
                  variant="default"
                  size="lg"
                  rightSection={<ArrowRight size="1rem" />}
                >
                  {t("Databases.Settings.Explore")}
                </Button>
              )}
            </div>
          </>
        )}

        {!selectedIsTransient && (
          <>
            <Divider variant="dashed" label={t("Databases.Settings.AdvancedTools")} />

            {selectedDatabase.type === "success" && (
              <AdvancedSettings
                key={databaseHandleKey(selectedDatabase.file)}
                selectedDatabase={selectedDatabase}
                reload={revalidateDatabases}
              />
            )}

            <Divider variant="dashed" label={t("Databases.Settings.Actions")} />
            <Group justify="space-between">
              {selectedDatabase.type === "success" && (
                <Group>
                  <NewDatabaseGameButton database={selectedDatabase.file} />
                  <Button
                    {...libraryButtonProps}
                    variant="default"
                    rightSection={<Plus size="1rem" />}
                    onClick={() => {
                      const dest = selectedDatabase.file;
                      void runAddGamesToDatabase({
                        pickPgnFile,
                        convertPgn: async (progressId, files, destination, ticket) => {
                          await refreshAfterDatabaseConversion(
                            () =>
                              tauri.convertPgn(progressId, files, destination, "", null, ticket),
                            async () => {
                              await refreshDatabaseList(databaseOwner!, mutateCache);
                            },
                            setImportRefreshFailed,
                            t("Common.Error"),
                          );
                        },
                        dest,
                        notifyTitle: t("Common.Error"),
                        runConversion: (sourceFileName, convert) =>
                          runDatabaseConversion(
                            setConversionState,
                            {
                              targetDatabase: dest,
                              targetDatabaseTitle: selectedDatabase.title,
                              sourceFileName,
                            },
                            convert,
                            {
                              onCancelError: (cause) =>
                                notifyUnlessCancelled(t("Common.Error"), cause, "database"),
                            },
                          ),
                      });
                    }}
                  >
                    {t("Databases.Settings.AddGames")}
                  </Button>
                  <Button
                    {...libraryButtonProps}
                    rightSection={<ArrowRight size="1rem" />}
                    variant="default"
                    loading={exportLoading}
                    onClick={() => {
                      void runPgnExport({
                        issueDestination: () => tauri.issuePgnExportDestination(),
                        exportToPgn: (file, handle) => tauri.exportToPgn(file, handle),
                        file: selectedDatabase.file,
                        notifyTitle: t("Common.Error"),
                        setLoading: setExportLoading,
                      });
                    }}
                  >
                    {t("Databases.Settings.ExportPGN")}
                  </Button>
                </Group>
              )}
              <Button {...libraryButtonProps} onClick={() => setDeleteModal(true)} color="danger">
                {t("Common.Delete")}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    ) : null,
    dialogs: (
      <>
        <ConfirmModal
          title={t("Databases.Delete.Title")}
          description={t("Databases.Delete.Message")}
          opened={deleteModal && !selectedIsTransient}
          onClose={() => setDeleteModal(false)}
          onConfirm={async () => {
            if (!selectedDatabase || selectedIsTransient) return;
            await deleteDatabaseAndInvalidate(
              selectedDatabase.file,
              tauri.deleteDatabase,
              invalidateDeletedDatabaseState,
            );
          }}
        />

        <AddDatabase
          databases={databases ?? []}
          opened={open}
          setOpened={setOpen}
          disableLocalConversion={conversionInProgress}
          reloadDatabases={() => refreshDatabaseList(databaseOwner!, mutateCache)}
        />
      </>
    ),
  };
}

function GeneralSettings({
  selectedDatabase,
  mutate,
}: {
  selectedDatabase: SuccessDatabaseInfo;
  mutate: () => void;
}) {
  const { t } = useTranslation();

  // An un-persisted user draft wins over concurrent external metadata for that
  // field only; a null draft is clean and always follows props.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const title = titleDraft ?? selectedDatabase.title;
  const description = descriptionDraft ?? selectedDatabase.description;

  const [debouncedTitleDraft] = useDebouncedValue(titleDraft, 300);
  const [debouncedDescriptionDraft] = useDebouncedValue(descriptionDraft, 300);

  useEffect(() => {
    if (titleDraft !== null && titleDraft === selectedDatabase.title) {
      setTitleDraft(null);
    }
  }, [titleDraft, selectedDatabase.title]);

  useEffect(() => {
    if (descriptionDraft !== null && descriptionDraft === selectedDatabase.description) {
      setDescriptionDraft(null);
    }
  }, [descriptionDraft, selectedDatabase.description]);

  useEffect(() => {
    const titleSettled = debouncedTitleDraft === titleDraft;
    const descriptionSettled = debouncedDescriptionDraft === descriptionDraft;
    if (!titleSettled || !descriptionSettled) return;
    if (debouncedTitleDraft === null && debouncedDescriptionDraft === null) return;
    const nextTitle = debouncedTitleDraft ?? selectedDatabase.title;
    const nextDescription = debouncedDescriptionDraft ?? selectedDatabase.description;
    if (
      nextTitle === "" ||
      (nextTitle === selectedDatabase.title && nextDescription === selectedDatabase.description)
    ) {
      return;
    }
    tauri
      .editDbInfo(selectedDatabase.file, nextTitle, nextDescription)
      .then(() => mutate())
      .catch((error) => notifyUnlessCancelled(t("Common.Error"), error));
  }, [
    titleDraft,
    descriptionDraft,
    debouncedTitleDraft,
    debouncedDescriptionDraft,
    mutate,
    selectedDatabase.file,
    selectedDatabase.title,
    selectedDatabase.description,
    t,
  ]);

  return (
    <>
      <TextInput
        label={t("Common.Name")}
        value={title}
        onChange={(e) => setTitleDraft(e.currentTarget.value)}
        error={title === "" && t("Common.RequireName")}
      />
      <Textarea
        label={t("Common.Description")}
        value={description}
        onChange={(e) => setDescriptionDraft(e.currentTarget.value)}
      />
    </>
  );
}

function AdvancedSettings({
  selectedDatabase,
  reload,
}: {
  selectedDatabase: DatabaseInfo;
  reload: () => void;
}) {
  return (
    <Stack>
      <PlayerMerger selectedDatabase={selectedDatabase} reload={reload} />
      <DuplicateRemover selectedDatabase={selectedDatabase} reload={reload} />
    </Stack>
  );
}

function PlayerMerger({
  selectedDatabase,
  reload,
}: {
  selectedDatabase: DatabaseInfo;
  reload: () => void;
}) {
  const { t } = useTranslation();

  const [player1, setPlayer1] = useState<number | undefined>(undefined);
  const [player2, setPlayer2] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  async function mergePlayers() {
    if (player1 === undefined || player2 === undefined) {
      return;
    }
    const file = selectedDatabase.file;
    setLoading(true);
    try {
      await tauri.mergePlayers(file, player1, player2);
      reload();
      setPlayer1(undefined);
      setPlayer2(undefined);
    } catch (error) {
      notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack>
      <Text fz="lg" fw="bold">
        {t("Databases.Settings.MergePlayers")}
      </Text>
      <Text fz="sm">{t("Databases.Settings.MergePlayers.Desc")}</Text>
      <Group grow>
        <PlayerSearchInput
          label={t("Databases.Player.One")}
          file={selectedDatabase.file}
          value={player1}
          setValue={setPlayer1}
        />
        <Button
          {...libraryButtonProps}
          loading={loading}
          onClick={mergePlayers}
          rightSection={<ArrowRight size="1rem" />}
        >
          {t("Databases.Settings.Merge")}
        </Button>
        <PlayerSearchInput
          label={t("Databases.Player.Two")}
          file={selectedDatabase.file}
          value={player2}
          setValue={setPlayer2}
        />
      </Group>
    </Stack>
  );
}

function DuplicateRemover({
  selectedDatabase,
  reload,
}: {
  selectedDatabase: DatabaseInfo;
  reload: () => void;
}) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(false);
  function runCleanup(action: (file: DatabaseHandle) => Promise<unknown>) {
    setLoading(true);
    void action(selectedDatabase.file)
      .then(() => {
        setLoading(false);
        reload();
      })
      .catch((error) => {
        setLoading(false);
        reload();
        notifyUnlessCancelled(t("Common.Error"), error);
      });
  }

  return (
    <Stack>
      <Text fz="lg" fw="bold">
        {t("Databases.Settings.BatchDelete")}
      </Text>
      <Text fz="sm">{t("Databases.Settings.BatchDelete.Desc")}</Text>
      <Group>
        <Button
          {...libraryButtonProps}
          loading={loading}
          onClick={() => runCleanup(tauri.deleteDuplicatedGames)}
        >
          {t("Databases.Settings.RemoveDup")}
        </Button>

        <Button
          {...libraryButtonProps}
          loading={loading}
          onClick={() => runCleanup(tauri.deleteEmptyGames)}
        >
          {t("Databases.Settings.RemoveEmpty")}
        </Button>
      </Group>
    </Stack>
  );
}

function IndexInput({
  indexed,
  file,
  reload,
}: {
  indexed: boolean;
  file: DatabaseHandle;
  reload: () => Promise<unknown>;
}) {
  const { t } = useTranslation();

  const [loading, setLoading] = useToggle();
  return (
    <Group>
      <Tooltip label={t("Databases.Settings.Indexed.Desc")}>
        <Checkbox
          label={t("Databases.Settings.Indexed")}
          disabled={loading}
          checked={indexed}
          onChange={(e) => {
            setLoading(true);
            const fn = e.currentTarget.checked ? tauri.createIndexes : tauri.deleteIndexes;
            void fn(file)
              .then(() => reload())
              .catch((error) => notifyUnlessCancelled(t("Common.Error"), error))
              .finally(() => setLoading(false));
          }}
        />
      </Tooltip>
      {loading && <Loader size="sm" />}
    </Group>
  );
}
