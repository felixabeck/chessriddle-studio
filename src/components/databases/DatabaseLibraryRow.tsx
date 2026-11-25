import { libraryButtonProps, libraryClasses } from "@/components/library/presentation";
import { Box, Button, Group, Loader, Rating, Stack, Text } from "@mantine/core";
import { DatabaseIcon } from "@/components/common/iconCatalog";
import { useTranslation } from "react-i18next";
import { databaseHandleKey, sameDatabaseHandle } from "@/utils/db";
import { formatBytes, formatNumber } from "@/utils/format";
import GenericCard from "../common/GenericCard";
import type { DatabaseLibrary } from "./useDatabaseLibrary";

export function DatabaseLibraryUnreadRow({ item }: { item: DatabaseLibrary["unread"][number] }) {
  return (
    <Stack gap={4} miw={0} className={libraryClasses.unreadDatabase}>
      <Text fw={500} fz="sm" className="wrap-anywhere">
        {item.filename}
      </Text>
      <Text c="danger" size="sm" className="wrap-anywhere">
        {item.error}
      </Text>
    </Stack>
  );
}

export function DatabaseLibraryRow({
  library,
  item,
}: {
  library: DatabaseLibrary;
  item: NonNullable<DatabaseLibrary["databases"]>[number];
}) {
  const { t } = useTranslation();

  return (
    <GenericCard
      tabIndex={-1}
      id={databaseHandleKey(item.file)}
      isSelected={sameDatabaseHandle(library.selectedDatabase?.file, item.file)}
      setSelected={library.setSelected}
      error={item.type === "error" && !item.transient ? item.error : ""}
      orientation="horizontal"
      className={libraryClasses.databaseCard}
      onDoubleClick={() => {
        if (item.type === "error") return;
        library.openDatabase(item);
      }}
      Header={
        <div className={libraryClasses.databaseMain}>
          <div className={libraryClasses.databaseName}>
            <span className={libraryClasses.databaseIcon} aria-hidden>
              <DatabaseIcon size="1.125rem" />
            </span>
            <Box miw={0}>
              <Text fw={600} fz="sm" className="wrap-anywhere">
                {item.type === "success" ? item.title : item.transient ? item.filename : item.error}
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
              value={sameDatabaseHandle(library.referenceDatabase, item.file) ? 1 : 0}
              count={1}
              onChange={() => {
                library.changeReferenceDatabase(item.file);
              }}
            />
            <Button
              variant="default"
              miw={0}
              {...libraryButtonProps}
              px="xs"
              onClick={() => library.openDatabase(item)}
            >
              {t("Databases.OpenDatabase", { defaultValue: "Open database" })}
            </Button>
          </Group>
        ) : undefined
      }
    />
  );
}
