import { tauri, TauriCommandError } from "@/platform/tauri";
import { pickPgnWorkspace } from "@/utils/files";
import { ChessBaseGuideLink } from "../library/ChessBaseGuideLink";
import i18n from "@/i18n";
import {
  Alert,
  Box,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { AlertCircle } from "lucide-react";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type DatabaseHandle, type DatabaseInfo, type FileWorkspaceHandle } from "@/bindings";
import {
  databaseConversionStateAtom,
  databaseConversionRefreshFailedAtom,
  runDatabaseConversion,
  type DatabaseConversionOperation,
} from "@/state/atoms";
import {
  manifestDatabaseInstallCard,
  type DownloadableDatabaseInfo,
  useDefaultDatabases,
} from "@/utils/db";
import { capitalize, formatBytes, formatNumber } from "@/utils/format";
import {
  errorUnlessCancelled,
  logFailureSafely,
  runWithAppliedRecovery,
  safeFailureContext,
} from "@/platform/errors";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import { cancelDownloadJob, runDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import { CatalogVerificationError } from "@/utils/signedCatalog";
import { refreshAfterDatabaseConversion } from "./databaseMutation";
import AppModal from "../common/AppModal";
import FileInput from "../common/FileInput";
import ProgressButton from "../common/ProgressButton";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";

interface AddDatabaseFormValues {
  title: string;
  description: string;
  files: FileWorkspaceHandle[];
  filename: string;
}

export async function convertLocalDatabase(
  progressId: string,
  paths: FileWorkspaceHandle[],
  title: string,
  description: string | undefined,
  onCreated: (handle: DatabaseHandle) => void,
  operation?: Pick<DatabaseConversionOperation, "ticket" | "throwIfCancelled">,
  onSecondaryFailure?: (cause: unknown) => void,
): Promise<DatabaseHandle> {
  if (paths.length === 1 && (await tauri.linkedCollectionsSupported())) {
    const collection = (await tauri.listLinkedCollections(null)).find(
      (collection) =>
        collection.status !== "retired" &&
        fileWorkspaceKey(collection.file) === fileWorkspaceKey(paths[0]),
    );
    if (collection) {
      operation?.throwIfCancelled();
      const current = await tauri.rebuildLinkedCollection(collection.id, false);
      operation?.throwIfCancelled();
      if (current.status !== "ready" || !current.database) {
        const t = i18n.t.bind(i18n);
        throw new TauriCommandError({
          tag: "backend-error",
          category: "missing-resource",
          message: t("Collections.Unavailable", {
            defaultValue:
              "The search index is unavailable. Retry, or select the collection's source file again.",
          }),
        });
      }
      onCreated(current.database);
      return current.database;
    }
  }
  const root = (await tauri.getDatabaseWorkspace()).root;
  const filename = `${crypto.randomUUID()}.db3`;
  const dbPath = await runWithAppliedRecovery(
    () => tauri.createWorkspaceDatabase(root, filename),
    async () =>
      (await tauri.listWorkspaceDatabases(root)).entries.find(
        (candidate) => candidate.filename === filename,
      )?.handle,
  );
  onCreated(dbPath);
  try {
    operation?.throwIfCancelled();
    await tauri.convertPgn(
      progressId,
      paths,
      dbPath,
      title,
      description ?? null,
      operation?.ticket ?? null,
    );
  } catch (cause) {
    try {
      await tauri.deleteDatabase(dbPath);
    } catch (cleanupCause) {
      const primaryFailure = safeFailureContext(cleanupCause);
      await logFailureSafely(
        `Failed import database cleanup failed: ${primaryFailure.message}`,
        { operation: "failed import database cleanup", primaryFailure },
        "Import cleanup logging failed",
      );
      if (!errorUnlessCancelled(cause)) onSecondaryFailure?.(cleanupCause);
    }
    throw cause;
  }
  return dbPath;
}

function AddDatabase({
  databases,
  opened,
  setOpened,
  disableLocalConversion,
  reloadDatabases,
}: {
  databases: DatabaseInfo[];
  opened: boolean;
  setOpened: (opened: boolean) => void;
  disableLocalConversion: boolean;
  reloadDatabases: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const setConversionState = useSetAtom(databaseConversionStateAtom);
  const setRefreshFailed = useSetAtom(databaseConversionRefreshFailedAtom);

  const { defaultDatabases, error, isLoading } = useDefaultDatabases(opened);

  async function convertDB(paths: FileWorkspaceHandle[], title: string, description?: string) {
    if (paths.length === 0) return;
    await runDatabaseConversion(
      setConversionState,
      {
        targetDatabase: null,
        targetDatabaseTitle: title,
        sourceFileName: "PGN",
      },
      (operation) =>
        refreshAfterDatabaseConversion(
          () =>
            convertLocalDatabase(
              operation.id,
              paths,
              title,
              description,
              operation.setTarget,
              operation,
              (cause) => notifyUnlessCancelled(t("Common.Error"), cause, "database"),
            ),
          async () => {
            await reloadDatabases();
          },
          setRefreshFailed,
          t("Common.Error"),
        ),
      { onCancelError: (cause) => notifyUnlessCancelled(t("Common.Error"), cause, "database") },
    );
  }

  const form = useForm<AddDatabaseFormValues>({
    initialValues: {
      title: "",
      description: "",
      files: [],
      filename: "",
    },

    validate: {
      // Titles are display metadata, not a stable identity.  Handles keep two
      // identically titled databases distinct and native creation reports only
      // an actual filename collision.
      title: (value) => (!value ? t("Common.RequireName") : undefined),
      files: (value) => {
        if (value.length === 0) return t("Common.RequirePath");
      },
    },
  });

  return (
    <AppModal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Databases.Add.Title")}
      size="80%"
    >
      <Tabs defaultValue="web">
        <Tabs.List>
          <Tabs.Tab value="web">{t("Databases.Add.Web")}</Tabs.Tab>
          <Tabs.Tab value="local">{t("Common.Local")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="web" pt="xs">
          {isLoading && (
            <Center>
              <Loader />
            </Center>
          )}
          <ScrollArea.Autosize h={500} offsetScrollbars>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              {defaultDatabases?.map((db) => {
                const card = manifestDatabaseInstallCard(databases, db);
                return (
                  <DatabaseCard
                    database={db}
                    key={card.progressId}
                    progressId={card.progressId}
                    reloadDatabases={reloadDatabases}
                    initInstalled={card.initInstalled}
                  />
                );
              })}
              {error && (
                <Alert icon={<AlertCircle size="1rem" />} title={t("Common.Error")} color="danger">
                  {t(
                    error instanceof CatalogVerificationError
                      ? "Databases.Add.ErrorCatalog"
                      : "Databases.Add.ErrorFetch",
                  )}
                </Alert>
              )}
            </SimpleGrid>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="local" pt="xs">
          <form
            onSubmit={form.onSubmit(async (values) => {
              if (disableLocalConversion) return;
              await runUnlessCancelled(
                t("Common.Error"),
                async () => {
                  await convertDB(values.files, values.title, values.description);
                  setOpened(false);
                },
                "database",
              );
            })}
          >
            <TextInput label={t("Common.Name")} withAsterisk {...form.getInputProps("title")} />

            <TextInput label={t("Common.Description")} {...form.getInputProps("description")} />

            <FileInput
              label={t("Common.PGNFile")}
              description={t("Databases.Add.ClickToSelectPGN")}
              onClick={() => {
                void runUnlessCancelled(t("Common.Error"), async () => {
                  const selected = await pickPgnWorkspace();
                  if (!selected) return;
                  form.setFieldValue("files", [selected.handle]);
                  const firstFilename = selected.displayName;
                  if (firstFilename) {
                    form.setFieldValue("filename", firstFilename);
                    if (!form.values.title) {
                      form.setFieldValue(
                        "title",
                        capitalize(
                          firstFilename
                            .replaceAll(/[_-]/g, " ")
                            .replace(/\.pgn(\.(zst|bz2))?$/i, ""),
                        ),
                      );
                    }
                  }
                });
              }}
              filename={form.values.filename ?? null}
              error={form.errors.files}
            />
            <ChessBaseGuideLink />

            <Button fullWidth mt="xl" type="submit" disabled={disableLocalConversion}>
              {t("Databases.Add.Convert")}
            </Button>
          </form>
        </Tabs.Panel>
      </Tabs>
    </AppModal>
  );
}

function DatabaseCard({
  reloadDatabases,
  database,
  progressId,
  initInstalled,
}: {
  reloadDatabases: () => Promise<unknown>;
  database: DownloadableDatabaseInfo;
  progressId: string;
  initInstalled: boolean;
}) {
  const { t } = useTranslation();
  const [inProgress, setInProgress] = useState<boolean>(false);
  const hasJob = useDownloadJob(progressId);

  async function downloadDatabase() {
    setInProgress(true);
    try {
      await runUnlessCancelled(
        t("Common.Error"),
        () =>
          runDownloadJob(progressId, async (ticket) => {
            const root = (await tauri.getDatabaseWorkspace()).root;
            const destination = await tauri.databaseDownloadDestination(root);
            await tauri.downloadFile(
              progressId,
              database.downloadLink,
              destination,
              `${database.title}.db3`,
              null,
              ticket,
              { sha256: database.sha256, signature: database.signature },
            );
            await reloadDatabases();
          }),
        "database",
      );
    } finally {
      setInProgress(false);
    }
  }

  return (
    <Paper withBorder radius="md" p={0} key={database.title}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("Board.Tabs.Database")}
          </Text>
          <Text fw="bold" mb="xs">
            {database.title}
          </Text>

          <Text size="xs" c="dimmed">
            {database.description}
          </Text>
          <Divider />
          <Group wrap="nowrap" grow my="md">
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("Common.Size")}
              </Text>
              <Text size="xs">{formatBytes(database.storage_size ?? 0)}</Text>
            </Stack>
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("Databases.Card.Games")}
              </Text>
              <Text size="xs">{formatNumber(database.game_count)}</Text>
            </Stack>
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("Databases.Card.Players")}
              </Text>
              <Text size="xs">{formatNumber(database.player_count)}</Text>
            </Stack>
          </Group>
          <ProgressButton
            id={progressId}
            initInstalled={initInstalled}
            labels={{
              completed: t("Common.Installed"),
              action: t("Common.Install"),
              inProgress: t("Common.Downloading"),
              finalizing: t("Common.Extracting"),
            }}
            onClick={() => {
              void downloadDatabase();
            }}
            onCancel={() => cancelDownloadJob(progressId, t("Common.Error"))}
            clearOnCancel={false}
            inProgress={inProgress || hasJob}
            setInProgress={setInProgress}
          />
        </Box>
      </Group>
    </Paper>
  );
}

export default AddDatabase;
