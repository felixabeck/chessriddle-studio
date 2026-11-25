import { libraryButtonProps, libraryDangerButtonProps } from "@/components/library/presentation";
import NewGameButton from "@/components/boards/NewGameButton";
import ExplainedAction from "@/components/library/ExplainedAction";
import { tauri } from "@/platform/tauri";
import {
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useToggle } from "@mantine/hooks";
import { ArrowRight, Plus } from "lucide-react";
import { Link, type RegisteredRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, DatabaseInfo } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { databaseHandleKey, type SuccessDatabaseInfo } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import { PlayerSearchInput } from "./PlayerSearchInput";
import { InstalledDatabaseCredit } from "./DatabaseCredit";
import { databaseRouteTarget, type DatabaseRouteTarget } from "./databaseRoute";
import type { DatabaseLibrary } from "./useDatabaseLibrary";

export function DatabaseLibraryDetail({ library }: { library: DatabaseLibrary }) {
  const { t } = useTranslation();
  const { selectedDatabase } = library;
  if (!selectedDatabase) return null;

  return (
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
            mutate={library.revalidateDatabases}
          />
          <Checkbox
            label={t("Databases.Settings.ReferenceDatabase")}
            checked={library.isReference}
            onChange={() => {
              library.changeReferenceDatabase(selectedDatabase.file);
            }}
          />
          <IndexInput
            indexed={selectedDatabase.indexed}
            file={selectedDatabase.file}
            reload={library.revalidateDatabases}
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
          <InstalledDatabaseCredit database={selectedDatabase} />

          <div>
            {selectedDatabase.type === "success" && (
              <Button
                {...libraryButtonProps}
                component={Link<RegisteredRouter, string, DatabaseRouteTarget["to"]>}
                {...databaseRouteTarget(selectedDatabase)}
                onClick={(event) => {
                  if (library.setActiveDatabase(selectedDatabase) !== true) event.preventDefault();
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

      {!library.selectedIsTransient && (
        <>
          <Divider variant="dashed" label={t("Databases.Settings.AdvancedTools")} />

          {selectedDatabase.type === "success" && (
            <AdvancedSettings
              key={databaseHandleKey(selectedDatabase.file)}
              selectedDatabase={selectedDatabase}
              reload={library.revalidateDatabases}
            />
          )}

          <Divider variant="dashed" label={t("Databases.Settings.Actions")} />
          <Group justify="space-between">
            {selectedDatabase.type === "success" && (
              <Group>
                <NewGameButton
                  origin={{ kind: "databaseDraft", database: selectedDatabase.file }}
                  explanation={t("Databases.NewGame.Desc")}
                />
                <ExplainedAction explanation={t("Databases.Settings.AddGames.Desc")}>
                  <Button
                    {...libraryButtonProps}
                    variant="default"
                    rightSection={<Plus size="1rem" />}
                    onClick={() => library.addGames(selectedDatabase)}
                  >
                    {t("Databases.Settings.AddGames")}
                  </Button>
                </ExplainedAction>
                <Button
                  {...libraryButtonProps}
                  rightSection={<ArrowRight size="1rem" />}
                  variant="default"
                  loading={library.exportLoading}
                  onClick={() => library.exportPgn(selectedDatabase)}
                >
                  {t("Databases.Settings.ExportPGN")}
                </Button>
              </Group>
            )}
            <Button {...libraryDangerButtonProps} onClick={() => library.requestDelete()}>
              {t("Common.Delete")}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
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
          disabled={player1 === undefined || player2 === undefined}
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
