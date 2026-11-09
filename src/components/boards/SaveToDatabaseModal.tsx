import { Alert, Button, Group, Loader, Select, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoreApi } from "zustand";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { listingFailure } from "@/components/files/listingFailure";
import { databaseLoadFailureMessage } from "@/components/databases/databaseLoadFailure";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import type { TreeStoreState } from "@/state/store/tree";
import { databaseHandleKey } from "@/utils/db";
import { saveToDatabase, useTabActions, type Tab } from "@/utils/tabs";

export default function SaveToDatabaseModal({
  opened,
  onClose,
  tab,
  store,
}: {
  opened: boolean;
  onClose: () => void;
  tab: Tab | undefined;
  store: StoreApi<TreeStoreState>;
}) {
  const { t } = useTranslation();
  const { data, error, isLoading, mutate } = useDatabaseList(opened);
  const failure = listingFailure(error);
  const { getTab, updateTab } = useTabActions();
  const [selected, setSelected] = useState<string | null>(null);
  const { pending, run, isMounted } = useSingleFlight();
  const targets = (data?.databases ?? []).filter(
    (item) => item.type === "success" && (!item.collection || item.collection.status === "ready"),
  );
  const target = targets.find((item) => databaseHandleKey(item.file) === selected);
  async function submit() {
    if (!target || target.type !== "success") return;
    await run(async () => {
      const result = await saveToDatabase({ tab, store, database: target.file, getTab, updateTab });
      if (!isMounted()) return;
      if (typeof result === "object") notifyUnlessCancelled(t("Common.Error"), result.error);
      else if (result === "saved") {
        notifications.show({ message: t("Board.Database.Saved", { database: target.title }) });
        onClose();
        void mutate().catch((error) => {
          if (isMounted()) notifyUnlessCancelled(t("Common.Error"), error);
        });
      } else if (result === "superseded")
        notifyUnlessCancelled(t("Common.Error"), {
          category: "validation",
          message: t("Tab.SaveSuperseded"),
        });
    });
  }
  return (
    <AppModal opened={opened} onClose={onClose} pending={pending} title={t("Board.Database.Save")}>
      <Stack>
        {isLoading && <Loader size="sm" />}
        {failure !== "silent" && (
          <Alert color="danger">{databaseLoadFailureMessage(error, t)}</Alert>
        )}
        <Select
          label={t("Board.Database.Target")}
          value={target ? selected : null}
          onChange={setSelected}
          disabled={pending || !!error}
          data={targets.flatMap((item) =>
            item.type === "success"
              ? [{ value: databaseHandleKey(item.file), label: item.title }]
              : [],
          )}
          nothingFoundMessage={t("Board.Database.NoTargets")}
          searchable
        />
        {!isLoading && !error && targets.length === 0 && (
          <Alert>{t("Board.Database.NoTargets")}</Alert>
        )}
        <Group justify="end">
          <Button styles={wrappingButton} variant="default" disabled={pending} onClick={onClose}>
            {t("Common.Cancel")}
          </Button>
          <Button
            styles={wrappingButton}
            disabled={!target || !!error}
            loading={pending}
            onClick={() => void submit()}
          >
            {t("Common.Save")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}
