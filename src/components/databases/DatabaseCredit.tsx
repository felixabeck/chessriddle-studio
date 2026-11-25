import { Anchor, Divider, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  catalogEntryForInstalledDatabase,
  useDefaultDatabases,
  type DatabaseCredit as Credit,
  type ManagedDatabaseInfo,
} from "@/utils/db";

/** `YYYY-MM` as the localized month and year, e.g. "June 2025". */
export function formatCreditRelease(release: string, locale: string): string {
  const [year, month] = release.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, 1));
}

function websiteLabel(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * The attribution a catalog database's licence asks for: author, source
 * website, licence with its deed, and which release Studio's copy was made from.
 */
export function DatabaseCredit({ credit }: { credit: Credit }) {
  const { t, i18n } = useTranslation();
  const converter = credit.convertedBy;

  return (
    <Stack gap={2} data-testid="database-credit">
      <Text size="xs" c="dimmed">
        {t("Databases.Credit.Author", { author: credit.author })}
        {" · "}
        <Anchor href={credit.website} target="_blank" rel="noreferrer" inherit>
          {websiteLabel(credit.website)}
        </Anchor>
      </Text>
      <Text size="xs" c="dimmed">
        {t("Databases.Credit.License")}{" "}
        <Anchor href={credit.license.url} target="_blank" rel="noreferrer" inherit>
          {credit.license.name}
        </Anchor>
      </Text>
      {(credit.release || converter) && (
        <Text size="xs" c="dimmed">
          {credit.release && converter
            ? t("Databases.Credit.ReleaseConverted", {
                release: formatCreditRelease(credit.release, i18n.language),
                converter,
              })
            : credit.release
              ? t("Databases.Credit.Release", {
                  release: formatCreditRelease(credit.release, i18n.language),
                })
              : t("Databases.Credit.Converted", { converter })}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The credit of the catalog entry an installed database was downloaded from;
 * nothing for databases the user imported or a catalog that fails verification.
 */
export function InstalledDatabaseCredit({
  database,
}: {
  database: Pick<ManagedDatabaseInfo, "filename" | "collection">;
}) {
  const { t } = useTranslation();
  const { defaultDatabases } = useDefaultDatabases(!database.collection);
  const credit = defaultDatabases
    ? catalogEntryForInstalledDatabase(defaultDatabases, database)?.credit
    : undefined;
  if (!credit) return null;
  return (
    <>
      <Divider variant="dashed" label={t("Databases.Credit.Source")} />
      <DatabaseCredit credit={credit} />
    </>
  );
}
