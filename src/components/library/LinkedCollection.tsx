import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useSWRConfig } from "swr";
import type { AccountIdentity, CollectionDescriptor, FileWorkspaceHandle } from "@/bindings";
import type { Entry, FileMetadata } from "@/components/files/file";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { tauri } from "@/platform/tauri";
import { referenceDbAtom } from "@/state/atoms";
import { isCollectionConsumer, useCollectionCurrency } from "@/state/linkedCollections";
export { isCollectionConsumer } from "@/state/linkedCollections";
import { databaseHandleKey, type SuccessDatabaseInfo } from "@/utils/db";
import { pickPgnFile } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import { libraryButtonProps } from "./presentation";
import NewDatabaseGameButton from "@/components/boards/NewDatabaseGameButton";

const playerFieldStyles = {
  label: { maxWidth: "100%", overflowWrap: "anywhere" },
} as const;

export function collectionFiles(entries: readonly Entry[]): FileMetadata[] {
  return entries.flatMap((entry) =>
    entry.type === "file"
      ? [entry]
      : entry.type === "directory"
        ? collectionFiles(entry.children)
        : [],
  );
}

export function LinkedCollection({
  collection,
  workspace,
  files,
}: {
  collection: CollectionDescriptor;
  workspace: FileWorkspaceHandle;
  files: FileMetadata[];
}) {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const navigate = useNavigate();
  const currency = useCollectionCurrency(collection.database, collection);
  const current = currency.collection ?? collection;
  const [reference, setReference] = useAtom(referenceDbAtom);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setMessage(null);
    try {
      await action();
      await mutate(isCollectionConsumer);
    } catch (error) {
      if (mounted.current) notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function append(input: FileWorkspaceHandle) {
    const outcome = await tauri.appendCollectionGames(current.id, input);
    if ((!outcome.indexReady || !outcome.durabilityConfirmed) && mounted.current)
      setMessage(t("Collections.CommittedPending"));
  }
  const ready =
    !currency.error && !currency.pending && current.status === "ready" && current.database;
  if (current.status === "preservedOriginal")
    return (
      <Alert
        miw={0}
        flex="0 0 auto"
        className="wrap-anywhere"
        data-preserved-original={current.id}
        title={t("Collections.OriginalVersion")}
      >
        {t("Collections.PreservedOriginal")}
      </Alert>
    );
  return (
    <Stack gap="xs" miw={0} className="wrap-anywhere" data-linked-collection={current.id}>
      <Text fw={600}>{t("Collections.Linked")}</Text>
      {!ready && <Alert color="warning">{t("Collections.Unavailable")}</Alert>}
      {current.omitted > 0 && (
        <Alert color="warning">{t("Collections.Omitted", { omitted: current.omitted })}</Alert>
      )}
      {message && <Alert color="warning">{message}</Alert>}
      {current.pendingBatch && (
        <Alert color="warning">
          <Text>{t("Collections.PendingAppend")}</Text>
          <Button
            {...libraryButtonProps}
            loading={pending}
            onClick={() => void run(() => append(current.pendingBatch!))}
          >
            {t("Common.Retry")}
          </Button>
        </Alert>
      )}
      <Group wrap="wrap">
        <NewDatabaseGameButton database={current.database} disabled={!ready || pending} />
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending}
          onClick={() =>
            current.database &&
            void navigate({
              to: "/databases/$databaseId",
              params: { databaseId: databaseHandleKey(current.database) },
            })
          }
        >
          {t("Databases.Explore")}
        </Button>
        <Button
          {...libraryButtonProps}
          loading={pending}
          onClick={() =>
            void run(async () => {
              await tauri.rebuildLinkedCollection(current.id, true);
            })
          }
        >
          {t("Collections.Rebuild")}
        </Button>
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending}
          onClick={() =>
            void run(async () => {
              const input = await pickPgnFile();
              if (!input) return;
              await append(input.handle);
            })
          }
        >
          {t("Databases.Settings.AddGames")}
        </Button>
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending}
          onClick={() =>
            void run(async () => {
              const destination = await tauri.issuePgnExportDestination();
              if (current.database) await tauri.exportToPgn(current.database, destination.handle);
            })
          }
        >
          {t("Databases.Settings.ExportPGN")}
        </Button>
      </Group>
      <Checkbox
        disabled={!ready || pending}
        label={t("Databases.Settings.ReferenceDatabase")}
        checked={
          !!current.database &&
          !!reference &&
          databaseHandleKey(reference) === databaseHandleKey(current.database)
        }
        onChange={(event) => setReference(event.currentTarget.checked ? current.database : null)}
      />
      <Group wrap="wrap">
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending}
          onClick={() =>
            void run(async () => {
              await tauri.editLinkedCollection(current.id, current.generation, {
                kind: "cleanup",
                empty: true,
                duplicates: false,
              });
            })
          }
        >
          {t("Databases.Settings.RemoveEmpty")}
        </Button>
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending}
          onClick={() =>
            void run(async () => {
              await tauri.editLinkedCollection(current.id, current.generation, {
                kind: "cleanup",
                empty: false,
                duplicates: true,
              });
            })
          }
        >
          {t("Databases.Settings.RemoveDup")}
        </Button>
      </Group>
      <SimpleGrid type="container" cols={{ base: 1, "36rem": 3 }} style={{ alignItems: "end" }}>
        <TextInput
          miw={0}
          styles={playerFieldStyles}
          label={t("Collections.PlayerFrom")}
          value={from}
          onChange={(event) => setFrom(event.currentTarget.value)}
        />
        <TextInput
          miw={0}
          styles={playerFieldStyles}
          label={t("Collections.PlayerTo")}
          value={to}
          onChange={(event) => setTo(event.currentTarget.value)}
        />
        <Button
          {...libraryButtonProps}
          disabled={!ready || pending || !from || !to}
          onClick={() =>
            void run(async () => {
              await tauri.editLinkedCollection(current.id, current.generation, {
                kind: "renamePlayer",
                from,
                to,
              });
            })
          }
        >
          {t("Common.Save")}
        </Button>
      </SimpleGrid>
      {!ready && (
        <Group align="end" grow>
          <Select
            miw={0}
            label={t("Collections.Source")}
            value={source}
            onChange={setSource}
            data={files.map((file) => ({ value: fileWorkspaceKey(file.handle), label: file.name }))}
          />
          <Button
            {...libraryButtonProps}
            disabled={!source || pending}
            onClick={() =>
              void run(async () => {
                const file = files.find((file) => fileWorkspaceKey(file.handle) === source);
                if (file) await tauri.reselectLinkedCollection(current.id, workspace, file.handle);
              })
            }
          >
            {t("Collections.Relink")}
          </Button>
        </Group>
      )}
      {current.retiredDatabase && (
        <Button
          {...libraryButtonProps}
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const root = (await tauri.getDatabaseWorkspace()).root;
              const destination = await tauri.createWorkspaceDatabase(
                root,
                `restored-${crypto.randomUUID()}.db3`,
              );
              await tauri.restoreCollectionArchive(current.id, destination);
            })
          }
        >
          {t("Collections.Restore")}
        </Button>
      )}
    </Stack>
  );
}

type CollectionMigrationProps = {
  database: SuccessDatabaseInfo;
  workspace: FileWorkspaceHandle;
  files: FileMetadata[];
  account?: AccountIdentity;
  opened: boolean;
  onClose: () => void;
  onComplete: (collection: CollectionDescriptor) => void | Promise<void>;
};

export function CollectionMigration(props: CollectionMigrationProps) {
  return <CollectionMigrationForm key={databaseHandleKey(props.database.file)} {...props} />;
}

function CollectionMigrationForm({
  database,
  workspace,
  files,
  account,
  opened,
  onClose,
  onComplete,
}: CollectionMigrationProps) {
  const { t } = useTranslation();
  const [, setReference] = useAtom(referenceDbAtom);
  const [source, setSource] = useState<string | null>(null);
  const [choice, setChoice] = useState<"pgn" | "database">("database");
  const [name, setName] = useState(`${database.title}-linked`);
  const [pending, setPending] = useState(false);
  const request = useRef(crypto.randomUUID());
  useEffect(() => {
    if (opened) request.current = crypto.randomUUID();
  }, [opened, database.file.id.id]);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const file = files.find((file) => fileWorkspaceKey(file.handle) === source);
  async function migrate(decline = false) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    try {
      const collection = await tauri.migrateLinkedCollection(
        request.current,
        workspace,
        database.file,
        file?.handle ?? null,
        decline ? "decline" : choice,
        account ?? null,
        name,
      );
      if (collection) {
        if (collection.database) {
          const current = collection.database;
          setReference((previous) =>
            previous && databaseHandleKey(previous) === databaseHandleKey(database.file)
              ? current
              : previous,
          );
        }
        await onComplete(collection);
      }
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <AppModal opened={opened} onClose={onClose} pending={pending} title={t("Collections.Migrate")}>
      <Stack>
        <Text>{t("Collections.MigrationExplanation")}</Text>
        <Text>
          {t("Collections.DatabaseCount", {
            games: database.game_count,
          })}
        </Text>
        <Select
          clearable
          label={t("Collections.Source")}
          value={source}
          onChange={setSource}
          data={files.map((file) => ({
            value: fileWorkspaceKey(file.handle),
            label: `${file.name} (${file.numGames})`,
          }))}
        />
        <Select
          label={t("Collections.FutureSource")}
          value={choice}
          onChange={(value) => setChoice(value === "pgn" ? "pgn" : "database")}
          data={[
            {
              value: "database",
              label: t("Collections.DatabaseVersion"),
            },
            ...(file
              ? [
                  {
                    value: "pgn",
                    label: t("Collections.PgnVersion"),
                  },
                ]
              : []),
          ]}
        />
        {choice === "database" && (
          <TextInput
            label={t("Common.Name")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        )}
        <Group>
          <Button
            {...libraryButtonProps}
            disabled={pending || (choice === "pgn" && !file) || !name}
            onClick={() => void migrate()}
          >
            {t("Collections.Migrate")}
          </Button>
          <Button
            styles={wrappingButton}
            variant="default"
            disabled={pending}
            onClick={() => void migrate(true)}
          >
            {t("Collections.Decline")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}
