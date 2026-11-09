import { Button } from "@mantine/core";
import { useStore } from "jotai";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import ProgressButton from "@/components/common/ProgressButton";
import { cancelDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import {
  installCatalogEngineJob,
  usePendingEngineCompletion,
} from "@/state/catalogEngineCompletion";
import {
  defaultEngineProgressId,
  selectStockfishCatalogEntry,
  useDefaultEngines,
  type DefaultEngine,
} from "@/utils/engines";
import { usePlatform } from "@/utils/files";

export function StockfishInstallProgress(
  props: Pick<
    ComponentProps<typeof ProgressButton>,
    "id" | "onClick" | "inProgress" | "setInProgress" | "initInstalled"
  >,
) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  return (
    <ProgressButton
      {...props}
      completeOnProgressSuccess={false}
      clearOnCancel={false}
      onCancel={() => cancelDownloadJob(props.id, t("Common.Error"))}
      labels={{
        completed: t("Common.Installed"),
        action: t("Engines.InstallStockfish", { defaultValue: "Install Stockfish" }),
        inProgress: t("Common.Downloading"),
        finalizing: t("Common.Extracting"),
      }}
    />
  );
}

function InstallEntry({ engine }: { engine: DefaultEngine }) {
  const { t } = useTranslation();
  const store = useStore();
  const progressId = defaultEngineProgressId(engine.downloadLink!);
  const hasJob = useDownloadJob(progressId);
  const pending = usePendingEngineCompletion(progressId);
  const [inProgress, setInProgress] = useState(false);
  const [installed, setInstalled] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const install = async () => {
    setInProgress(true);
    try {
      if (await installCatalogEngineJob(engine, progressId, undefined, store)) {
        if (alive.current) setInstalled(true);
      }
    } finally {
      if (alive.current) setInProgress(false);
    }
  };
  if (pending?.completion.outcome.state === "succeeded") {
    return (
      <Button
        className="wrap-button"
        fullWidth
        disabled={pending.applying || inProgress}
        onClick={() => void install()}
      >
        {pending.applying || inProgress ? t("Common.Extracting") : t("Engines.InstallStockfish")}
      </Button>
    );
  }
  return (
    <StockfishInstallProgress
      id={progressId}
      initInstalled={installed}
      onClick={() => void install()}
      inProgress={inProgress || hasJob}
      setInProgress={setInProgress}
    />
  );
}

export default function InstallStockfishButton() {
  const { os } = usePlatform();
  const { defaultEngines, error } = useDefaultEngines(os, true);
  const engine = selectStockfishCatalogEntry(defaultEngines);
  return !error && engine?.downloadLink ? (
    <InstallEntry key={engine.downloadLink} engine={engine} />
  ) : null;
}
