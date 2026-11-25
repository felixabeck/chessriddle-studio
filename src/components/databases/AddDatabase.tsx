import { tauri, TauriCommandError } from "@/platform/tauri";
import { pickPgnWorkspace } from "@/utils/files";
import { ChessBaseGuideLink } from "../library/ChessBaseGuideLink";
import i18n from "@/i18n";
import {
  Alert,
  Button,
  Center,
  Loader,
  ScrollArea,
  SimpleGrid,
  Tabs,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { AlertCircle } from "lucide-react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, FileWorkspaceHandle } from "@/bindings";
import {
  databaseConversionStateAtom,
  databaseConversionRefreshFailedAtom,
  runDatabaseConversion,
  type DatabaseConversionOperation,
} from "@/state/atoms";
import {
  catalogDatabaseFilename,
  manifestDatabaseInstallCard,
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
import { CatalogVerificationError } from "@/utils/signedCatalog";
import { refreshAfterDatabaseConversion } from "./databaseMutation";
import AppModal from "../common/AppModal";
import FileInput from "../common/FileInput";
import CatalogDownloadCard from "../common/CatalogDownloadCard";
import { DatabaseCredit } from "./DatabaseCredit";
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
  workspaceFilenames,
  opened,
  setOpened,
  disableLocalConversion,
  reloadDatabases,
}: {
  workspaceFilenames: readonly string[];
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
      files: (value) => (value.length === 0 ? t("Common.RequirePath") : undefined),
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
                const card = manifestDatabaseInstallCard(workspaceFilenames, db);
                return (
                  <CatalogDownloadCard
                    item={db}
                    key={card.progressId}
                    kindLabel={t("Board.Tabs.Database")}
                    stats={[
                      { label: t("Common.Size"), value: formatBytes(db.storage_size ?? 0) },
                      { label: t("Databases.Card.Games"), value: formatNumber(db.game_count) },
                      { label: t("Databases.Card.Players"), value: formatNumber(db.player_count) },
                    ]}
                    credit={db.credit && <DatabaseCredit credit={db.credit} />}
                    progressId={card.progressId}
                    initInstalled={card.initInstalled}
                    resolveDestination={async () =>
                      tauri.databaseDownloadDestination((await tauri.getDatabaseWorkspace()).root)
                    }
                    leaf={catalogDatabaseFilename(db.title)}
                    onInstalled={reloadDatabases}
                    errorDomain="database"
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
                  // The Library row shows the running import (game count, rate,
                  // Cancel); the dialog would only hide it until the import ends.
                  const conversion = convertDB(values.files, values.title, values.description);
                  setOpened(false);
                  await conversion;
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

export default AddDatabase;
