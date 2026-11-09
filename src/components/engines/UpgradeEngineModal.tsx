import { Alert, Center, Loader, ScrollArea, SimpleGrid } from "@mantine/core";
import { AlertCircle } from "lucide-react";
import { useStore } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { cancelDownloadJob, runDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import { completeCatalogEngine, usePendingEngineCompletion } from "@/state/catalogEngineCompletion";
import {
  EngineCapabilityQueryError,
  EngineCatalogVerificationError,
  useDefaultEngines,
  type DefaultEngine,
  type LocalEngine,
} from "@/utils/engines";
import { usePlatform } from "@/utils/files";
import CatalogEngineCard from "./CatalogEngineCard";

export default function UpgradeEngineModal({
  engine,
  opened,
  setOpened,
}: {
  engine: LocalEngine;
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const { t } = useTranslation();
  const { os } = usePlatform();
  const { defaultEngines, error, isLoading } = useDefaultEngines(os, opened);
  const store = useStore();
  const pending = usePendingEngineCompletion(null, engine.id);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [upgradedLink, setUpgradedLink] = useState<string | null>(null);
  const active = useRef<string | null>(null);

  async function cancel() {
    if (pending?.completion.outcome.state === "succeeded") return;
    if (active.current) return cancelDownloadJob(active.current, t("Common.Error"));
  }

  async function upgrade(catalog: DefaultEngine, progressId: string) {
    if (active.current) return;
    active.current = progressId;
    setActiveId(progressId);
    try {
      await runDownloadJob(progressId, (ticket) =>
        completeCatalogEngine(catalog, progressId, ticket, engine, store),
      );
      setUpgradedLink(catalog.downloadLink ?? null);
    } catch (cause) {
      notifyUnlessCancelled(t("Common.Error"), cause, "engine");
    } finally {
      active.current = null;
      setActiveId(null);
    }
  }

  return (
    <AppModal
      opened={opened}
      onClose={() => {
        void cancel()?.catch(() => undefined);
        setOpened(false);
      }}
      title={t("Engines.Upgrade.Title")}
      size="80%"
    >
      {isLoading && (
        <Center>
          <Loader />
        </Center>
      )}
      {error ? (
        <Alert icon={<AlertCircle size="1rem" />} title={t("Common.Error")} color="danger">
          {t(
            error instanceof EngineCatalogVerificationError
              ? "Engines.Upgrade.ErrorCatalog"
              : error instanceof EngineCapabilityQueryError
                ? "Engines.Upgrade.ErrorCapabilities"
                : "Engines.Upgrade.ErrorLoad",
          )}
        </Alert>
      ) : (
        <ScrollArea.Autosize mah={720} offsetScrollbars>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {defaultEngines?.map((catalog) => {
              if (!catalog.downloadLink) return null;
              const id = `engine-upgrade:${engine.id}:${catalog.downloadLink}`;
              return (
                <UpgradeCard
                  key={id}
                  catalog={catalog}
                  id={id}
                  current={catalog.downloadLink === (upgradedLink ?? engine.downloadLink)}
                  busy={
                    activeId !== null ||
                    Boolean(pending && pending.completion.request.progressId !== id)
                  }
                  active={activeId === id}
                  committing={
                    pending?.completion.outcome.state === "succeeded" &&
                    pending.completion.request.progressId === id
                  }
                  recovery={
                    pending?.completion.outcome.state === "succeeded" &&
                    pending.completion.request.progressId === id
                      ? {
                          busy: pending.applying || activeId !== null,
                          retry: () => void upgrade(catalog, id),
                        }
                      : undefined
                  }
                  upgrade={() => {
                    void upgrade(catalog, id);
                  }}
                  cancel={cancel}
                />
              );
            })}
          </SimpleGrid>
        </ScrollArea.Autosize>
      )}
    </AppModal>
  );
}

function UpgradeCard({
  catalog,
  id,
  current,
  busy,
  active,
  committing,
  upgrade,
  cancel,
  recovery,
}: {
  catalog: DefaultEngine;
  id: string;
  current: boolean;
  busy: boolean;
  active: boolean;
  committing: boolean;
  upgrade: () => void;
  cancel: () => Promise<void | { clearedGeneration: bigint | null }>;
  recovery?: { busy: boolean; retry: () => void };
}) {
  const { t } = useTranslation();
  const hasJob = useDownloadJob(id);
  return (
    <CatalogEngineCard
      engine={catalog}
      layout="upgrade"
      progressId={id}
      initInstalled={current && !committing}
      recovery={recovery}
      labels={{
        completed: t("Engines.Upgrade.Current"),
        action: t("Common.Install"),
        inProgress: t(committing ? "Common.Extracting" : "Common.Downloading"),
        finalizing: t("Common.Extracting"),
      }}
      onClick={upgrade}
      onCancel={
        committing
          ? undefined
          : active || hasJob
            ? cancel
            : () => cancelDownloadJob(id, t("Common.Error"))
      }
      inProgress={active || hasJob}
      setInProgress={() => undefined}
      disabled={busy}
    />
  );
}
