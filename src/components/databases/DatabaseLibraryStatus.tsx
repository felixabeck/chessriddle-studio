import { libraryButtonProps } from "@/components/library/presentation";
import { Button, Divider, Group, Loader, Stack, Text } from "@mantine/core";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { formatDecimal } from "@/utils/format";
import type { DatabaseLibrary } from "./useDatabaseLibrary";

export function DatabaseLibraryStatus({ library }: { library: DatabaseLibrary }) {
  const { t } = useTranslation();

  return (
    <Stack
      className="wrap-anywhere"
      role="region"
      aria-label={t("Databases.Title")}
      data-library-source="databases"
    >
      {library.failure !== "silent" && (
        <Stack role="alert" c="danger" p={{ base: "xs", sm: "md" }} miw={0}>
          <Text className="wrap-anywhere">{library.loadFailureMessage}</Text>
          {library.needsFolder ? (
            <Button
              miw={0}
              px="xs"
              disabled={library.pickerPending}
              onClick={() => void library.chooseWorkspace()}
              {...libraryButtonProps}
            >
              {t("Databases.ChooseFolder", { defaultValue: "Choose database folder" })}
            </Button>
          ) : (
            <Button
              {...libraryButtonProps}
              onClick={() =>
                void (library.importRefreshFailed
                  ? library.retryImportRefresh()
                  : library.retryLoad())
              }
            >
              {t("Databases.LoadRetry", { defaultValue: "Retry" })}
            </Button>
          )}
        </Stack>
      )}

      {!library.databases && library.failure === "silent" && (
        <Text role="status">
          {t("Library.DatabasesLoading", { defaultValue: "Loading games databases…" })}
        </Text>
      )}
    </Stack>
  );
}

export function DatabaseLibraryProgress({ library }: { library: DatabaseLibrary }) {
  const { t, i18n } = useTranslation();

  return (
    <>
      {library.importRefreshFailed && (
        <Button variant="default" onClick={() => void library.retryImportRefresh()}>
          {t("Databases.LoadRetry", { defaultValue: "Retry" })}
        </Button>
      )}
      {library.conversionState.map((entry) => (
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
                  ? ` • ${t("Databases.Add.GamesPerSecond", { rate: formatDecimal(entry.totalGames / entry.elapsedSeconds, i18n.language) })}`
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
  );
}
