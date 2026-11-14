import { tauri, tauriSubscriptions } from "@/platform/tauri";
import {
  Alert,
  Button,
  Badge,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  useMatches,
} from "@mantine/core";
import { CollectionMigration } from "@/components/library/LinkedCollection";
import { ensureFileWorkspace } from "@/utils/files";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CircleCheckBig,
  Download,
  type LucideProps,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { DATABASE_LIST_KEY, refreshDatabaseList } from "@/hooks/useDatabaseList";
import type { AccountCompletion, DatabaseHandle, FileWorkspaceHandle, PathRef } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import {
  notifyListenerError,
  notifyUnlessCancelled,
  runUnlessCancelled,
} from "@/components/files/notifyError";
import {
  accountDownloadsInFlightAtom,
  accountCompletionsAtom,
  downloadDestinationAtom,
} from "@/state/atoms";
import {
  accountCompletionKey,
  observeAccountCompletions,
  runAccountImport,
} from "@/state/accountCompletions";
import { type ManagedDatabaseInfo } from "@/utils/db";
import { accountDatabaseFilename, type AccountDatabaseIssue } from "./accountDatabase";
import { capitalize } from "@/utils/format";
import { useTauriListener } from "@/platform/useTauriListener";
import { logFailureSafely, runWithAppliedRecovery, safeFailureContext } from "@/platform/errors";
import LichessLogo from "./LichessLogo";

interface AccountCardProps {
  type: "lichess" | "chesscom";
  database: ManagedDatabaseInfo | null;
  title: string;
  /** Canonical provider identity, independent of cached profile display spelling. */
  accountUsername?: string;
  associationIssue?: AccountDatabaseIssue;
  associationPending?: boolean;
  updatedAt: number;
  total: number;
  stats: {
    value: number;
    label: string;
    diff?: number;
  }[];
  logout: () => void | Promise<void>;
  reload: () => void | Promise<void>;
  authenticated?: boolean;
  accountHandle?: string;
}

/**
 * An account with no games at all leaves the total at zero. The unguarded
 * division rendered `aria-valuenow="NaN"` and a `NaN%` bar width, which Axe
 * reports as an invalid ARIA attribute value.
 */
export function downloadProgressPercent(downloaded: number, total: number): number {
  return total === 0 ? 0 : (downloaded / total) * 100;
}

function isPathRef(value: unknown): value is PathRef {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}

export async function ensureAccountDatabaseHandle(
  existing: DatabaseHandle | undefined,
  title: string,
  type: "lichess" | "chesscom",
): Promise<DatabaseHandle> {
  if (existing) return existing;
  const root = (await tauri.getDatabaseWorkspace()).root;
  const filename = accountDatabaseFilename(title, type);
  const registered = (await tauri.listWorkspaceDatabases(root)).entries.find(
    (candidate) => candidate.filename === filename,
  );
  if (registered) return registered.handle;
  return runWithAppliedRecovery(
    () => tauri.createWorkspaceDatabase(root, filename),
    async () =>
      (await tauri.listWorkspaceDatabases(root)).entries.find(
        (candidate) => candidate.filename === filename,
      )?.handle,
  );
}

export function AccountCard({
  type,
  database,
  title,
  accountUsername = title,
  associationIssue,
  associationPending = false,
  updatedAt,
  total,
  stats,
  logout,
  reload,
  authenticated,
  accountHandle,
}: AccountCardProps) {
  const horizontalInset = useMatches({
    base: "var(--mantine-spacing-xs)",
    xs: "var(--mantine-spacing-lg)",
  });
  const { t, i18n } = useTranslation();
  const { mutate } = useSWRConfig();
  const databaseOwner = useNativeRequestOwner(DATABASE_LIST_KEY);
  const accountKey = accountCompletionKey({ provider: type, account: accountUsername });
  const store = useStore();
  const items = stats.map((stat) => {
    let color = "gray";
    let DiffIcon: React.FC<LucideProps> = ArrowRight;
    if (stat.diff) {
      const sign = Math.sign(stat.diff);
      if (sign === 1) {
        DiffIcon = ArrowUpRight;
        color = "success";
      } else {
        DiffIcon = ArrowDownRight;
        color = "danger";
      }
    }
    return (
      <Group key={stat.label} justify="space-between" wrap="wrap" miw={0}>
        <Text size="xs" c="dimmed" fw={700} tt="uppercase" miw={0} className="wrap-anywhere">
          {capitalize(stat.label)}
        </Text>
        <Group gap={4}>
          {stat.diff !== undefined && stat.diff !== 0 && (
            <Badge color={color} variant="light" size="xs" leftSection={<DiffIcon size="0.8rem" />}>
              {Math.abs(stat.diff)}
            </Badge>
          )}
          <Text fw={700} size="sm">
            {stat.value}
          </Text>
        </Group>
      </Group>
    );
  });
  const [downloadsInFlight, setDownloadsInFlight] = useAtom(accountDownloadsInFlightAtom);
  const completions = useAtomValue(accountCompletionsAtom);
  const retained = completions.get(accountKey);
  const pending = downloadsInFlight.has(accountKey) || retained?.outcome.state === "running";
  const [progress, setProgress] = useState<{
    id: string;
    attempt: number | null;
    value: number;
  } | null>(null);
  const [migrationWorkspace, setMigrationWorkspace] = useState<FileWorkspaceHandle | null>(null);
  const [collectionNotice, setCollectionNotice] = useState(false);
  const [downloadDestination, setDownloadDestination] = useAtom(downloadDestinationAtom);

  function activeProgressTicket(
    current: AccountCompletion | undefined,
    inFlight: ReadonlyMap<string, string | null>,
  ): { id: string; attempt: number | null } | null {
    if (current?.outcome.state === "running") {
      return { id: current.progressId, attempt: current.attempt };
    }
    const fallback = inFlight.get(accountKey);
    return typeof fallback === "string" ? { id: fallback, attempt: null } : null;
  }

  useTauriListener(
    tauriSubscriptions.progress,
    (e) => {
      const ticket = activeProgressTicket(
        store.get(accountCompletionsAtom).get(accountKey),
        store.get(accountDownloadsInFlightAtom),
      );
      if (ticket && e.payload.id === ticket.id) {
        setProgress({ id: ticket.id, attempt: ticket.attempt, value: e.payload.progress });
      }
    },
    { onError: notifyListenerError },
  );

  const currentTicket = activeProgressTicket(retained, downloadsInFlight);
  const currentProgress =
    pending &&
    currentTicket !== null &&
    progress?.id === currentTicket.id &&
    progress.attempt === currentTicket.attempt
      ? progress.value
      : null;

  const downloadedGames = database?.type === "success" ? database.game_count : 0;
  const effectiveTotal = Math.max(total, downloadedGames);

  async function ensureDownloadDestination(): Promise<PathRef> {
    if (
      isPathRef(downloadDestination) &&
      (await tauri.downloadDestinationIsKnown(downloadDestination))
    )
      return downloadDestination;
    if (downloadDestination !== null) setDownloadDestination(null);
    const result = await tauri.issueDownloadDestination();
    setDownloadDestination(result);
    return result;
  }

  async function refreshDatabases(importFailed: boolean): Promise<void> {
    try {
      // Supersede older listings, publish an owned fresh read, then let SWR revalidate mounted
      // consumers after mutation settles, including a remount that retired the refresh read.
      await refreshDatabaseList(databaseOwner!, mutate);
    } catch (refreshCause) {
      if (!importFailed) throw refreshCause;
      const primaryFailure = safeFailureContext(refreshCause);
      await logFailureSafely(
        `Account import database refresh failed for ${accountKey}: ${primaryFailure.message}`,
        { operation: "account import database refresh", primaryFailure },
        `Account import refresh logging failed for ${accountKey}`,
      );
    }
  }

  const refreshRef = useRef(refreshDatabases);
  refreshRef.current = refreshDatabases;
  useEffect(
    () =>
      observeAccountCompletions(store, accountKey, {
        refresh: (failed) => refreshRef.current(failed),
        collectionNotice: setCollectionNotice,
      }),
    [store, accountKey],
  );

  return (
    <Card
      withBorder
      radius="md"
      padding="lg"
      styles={{
        root: { paddingInline: horizontalInset },
        section: {
          paddingInline: horizontalInset,
          marginInline: `calc(${horizontalInset} * -1)`,
        },
      }}
    >
      <Card.Section withBorder inheritPadding py="xs">
        <Group justify="space-between">
          <Group wrap="wrap" miw={0}>
            {type === "lichess" ? (
              <LichessLogo />
            ) : (
              <img width={30} height={30} src="/chesscom.png" alt="chess.com" />
            )}
            <Text fw={600} size="sm" miw={0} className="wrap-anywhere">
              {title}
            </Text>
            {type === "lichess" && authenticated && (
              <Tooltip label={t("Home.Accounts.Authenticated")}>
                <Text c="success" lh={0} style={{ cursor: "default" }}>
                  <CircleCheckBig size="1.1rem" />
                </Text>
              </Tooltip>
            )}
          </Group>
          <Group gap={4}>
            <IconAction
              label={t("Home.Accounts.UpdateStats")}
              variant="subtle"
              color="gray"
              onClick={() =>
                void runUnlessCancelled(t("Common.Error"), async () => {
                  await reload();
                })
              }
            >
              <RefreshCw size="1rem" />
            </IconAction>
            <IconAction
              label={t("Home.Accounts.DownloadGames")}
              variant="subtle"
              color="gray"
              pending={pending}
              disabled={
                pending ||
                !!associationIssue ||
                associationPending ||
                (type === "lichess" && !accountHandle)
              }
              onClick={async () => {
                if (associationIssue || associationPending) return;
                if (store.get(accountCompletionsAtom).get(accountKey)?.outcome.state === "running")
                  return;
                if (store.get(accountDownloadsInFlightAtom).has(accountKey)) return;
                setDownloadsInFlight((previous) => new Map(previous).set(accountKey, null));
                try {
                  let preparation: Awaited<ReturnType<typeof tauri.prepareAccountCollection>> =
                    null;
                  if (await tauri.linkedCollectionsSupported()) {
                    const workspace = await ensureFileWorkspace();
                    if (!workspace) return;
                    preparation = await tauri.prepareAccountCollection(
                      workspace,
                      { provider: type, account: accountUsername },
                      database?.file ?? null,
                    );
                    if (preparation?.migrationRequired) {
                      setMigrationWorkspace(workspace);
                      return;
                    }
                    if (
                      preparation &&
                      (!preparation.collection || preparation.collection.status !== "ready")
                    )
                      throw new Error(t("Collections.Unavailable"));
                  }
                  const lastGameDate = preparation
                    ? preparation.collection?.fetchSinceMs
                      ? Number(preparation.collection.fetchSinceMs)
                      : null
                    : null;
                  if (type === "lichess" && !accountHandle && !preparation?.pendingBatch)
                    throw new Error(t("Home.Accounts.AuthenticationRequired"));
                  const target = preparation?.collection
                    ? { kind: "linked" as const, collection: preparation.collection.id }
                    : {
                        kind: "unlinked" as const,
                        database: await ensureAccountDatabaseHandle(
                          database?.file,
                          accountUsername,
                          type,
                        ),
                        title: title + (type === "lichess" ? " Lichess" : " Chess.com"),
                      };
                  const destination =
                    preparation?.destination ?? (await ensureDownloadDestination());
                  await runAccountImport(store, {
                    provider: type,
                    account: accountUsername,
                    accountHandle: accountHandle ?? null,
                    destination,
                    pendingBatch: preparation?.pendingBatch ?? null,
                    sinceMs: lastGameDate === null ? null : BigInt(lastGameDate),
                    target,
                  });
                } catch (cause) {
                  notifyUnlessCancelled(t("Common.Error"), cause, "database");
                } finally {
                  setDownloadsInFlight((previous) => {
                    if (!previous.has(accountKey)) return previous;
                    const next = new Map(previous);
                    next.delete(accountKey);
                    return next;
                  });
                }
              }}
            >
              <Download size="1rem" />
            </IconAction>
            <IconAction
              label={t("Home.Accounts.RemoveAccount")}
              variant="subtle"
              color="danger"
              onClick={() =>
                void runUnlessCancelled(t("Common.Error"), async () => {
                  await logout();
                })
              }
            >
              <Trash2 size="1rem" />
            </IconAction>
          </Group>
        </Group>
      </Card.Section>

      <Card.Section inheritPadding py="md">
        {associationIssue && (
          <Alert
            color="warning"
            px={0}
            miw={0}
            className="wrap-anywhere"
            styles={{ body: { minWidth: 0 }, message: { minWidth: 0 } }}
          >
            <Text>{t("Home.Accounts.HistoryUnavailable")}</Text>
            {associationIssue.filenames.length > 0 && (
              <Text className="wrap-anywhere">{associationIssue.filenames.join(", ")}</Text>
            )}
            {associationIssue.error && <Text>{associationIssue.error}</Text>}
            <Button
              variant="subtle"
              className="wrap-button"
              px={0}
              miw={0}
              maw="100%"
              disabled={associationPending}
              onClick={() =>
                void runUnlessCancelled(t("Common.Error"), () => refreshDatabases(false))
              }
            >
              {t("Common.Retry")}
            </Button>
          </Alert>
        )}
        {database?.type === "error" && <Alert color="warning">{database.error}</Alert>}
        {collectionNotice && <Alert color="warning">{t("Collections.CommittedPending")}</Alert>}
        {migrationWorkspace && database?.type === "success" && (
          <CollectionMigration
            opened
            onClose={() => setMigrationWorkspace(null)}
            database={database}
            workspace={migrationWorkspace}
            files={[]}
            account={{ provider: type, account: accountUsername }}
            onComplete={async () => {
              await refreshDatabases(false);
            }}
          />
        )}
        <SimpleGrid cols={1} spacing="xs">
          {items}
        </SimpleGrid>
      </Card.Section>

      <Card.Section inheritPadding pb="sm">
        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("Common.Games")}
            </Text>
            <Text size="xs" fw={500} miw={0} className="wrap-anywhere">
              {associationIssue || database?.type === "error"
                ? t("Common.Unknown")
                : `${downloadedGames} / ${effectiveTotal}`}
            </Text>
          </Group>
          <Progress
            // An account with no games at all makes `effectiveTotal` zero; the
            // unguarded division rendered `aria-valuenow="NaN"` and a NaN width.
            value={pending ? 100 : downloadProgressPercent(downloadedGames, effectiveTotal)}
            // Mantine puts `role="progressbar"` on the inner section and forwards
            // `aria-label` to it, so the bar is named rather than anonymous.
            aria-label={t("Home.Accounts.GamesProgress", {
              downloaded: downloadedGames,
              total: effectiveTotal,
            })}
            size="sm"
            striped={pending}
            animated={pending}
          />
          <Group justify="space-between" mt={4}>
            <Text size="xs" c="dimmed" miw={0} className="wrap-anywhere">
              {t("Home.Accounts.LastUpdate", {
                date: new Date(updatedAt).toLocaleDateString(i18n.language),
                interpolation: { escapeValue: false },
              })}
            </Text>
            {currentProgress !== null && (
              <Text size="xs" c="dimmed">
                {currentProgress.toFixed(0)}%
              </Text>
            )}
          </Group>
        </Stack>
      </Card.Section>
    </Card>
  );
}
