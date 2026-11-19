import { Group, Select } from "@mantine/core";
import { Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type PathRef, type PuzzleDatabaseInfo } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { puzzleDatabaseExtension } from "@/utils/db";
import { capabilityKey } from "@/utils/pathCapabilities";
import ConfirmModal from "../common/ConfirmModal";

const addOptionLabel = (label: string) => `+ ${label}`;

function PuzzleDatabaseToolbar({
  puzzleDbs,
  selectedDb,
  onSelectDb,
  onAdd,
  settingsOpened,
  onToggleSettings,
  onDeleteConfirmed,
}: {
  puzzleDbs: PuzzleDatabaseInfo[];
  selectedDb: PathRef | null;
  onSelectDb: (database: PathRef | null) => void;
  onAdd: () => void;
  settingsOpened: boolean;
  onToggleSettings: () => void;
  onDeleteConfirmed: (database: PathRef, close: () => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);

  return (
    <>
      <ConfirmModal
        title={t("Puzzle.DeleteDatabase")}
        description={t("Puzzle.DeleteDatabaseConfirm")}
        opened={deleteModalOpened}
        onClose={() => setDeleteModalOpened(false)}
        onConfirm={async () => {
          if (selectedDb) await onDeleteConfirmed(selectedDb, () => setDeleteModalOpened(false));
        }}
      />
      <Group justify="space-between" pb="sm">
        <Select
          style={{ flex: 1 }}
          data={puzzleDbs
            .map((p) => ({
              label: p.title.split(puzzleDatabaseExtension)[0],
              value: capabilityKey(p.path),
            }))
            .concat({ label: addOptionLabel(t("Common.AddNew")), value: "add" })}
          value={selectedDb ? capabilityKey(selectedDb) : null}
          clearable={false}
          placeholder={t("Puzzle.SelectDatabase")}
          onChange={(v) => {
            if (v === "add") {
              onAdd();
            } else {
              onSelectDb(
                puzzleDbs.find((database) => capabilityKey(database.path) === v)?.path ?? null,
              );
            }
          }}
        />
        <Group gap="xs">
          <IconAction
            label={t("Puzzle.DeleteDatabase")}
            color="danger"
            disabled={!selectedDb}
            onClick={() => setDeleteModalOpened(true)}
          >
            <Trash2 size={20} />
          </IconAction>
          <IconAction
            label={t("SideBar.Settings")}
            pressed={settingsOpened}
            onClick={onToggleSettings}
          >
            <Settings size={20} />
          </IconAction>
        </Group>
      </Group>
    </>
  );
}

export default PuzzleDatabaseToolbar;
