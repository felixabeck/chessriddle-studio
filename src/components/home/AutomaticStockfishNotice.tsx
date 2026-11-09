import { Alert, getDefaultZIndex } from "@mantine/core";
import { useAtomValue, useStore } from "jotai";
import { Suspense, useEffect } from "react";
import { StockfishInstallProgress } from "@/components/engines/InstallStockfishButton";
import { useDownloadJob } from "@/hooks/downloadJobs";
import { automaticStockfishJobAtom, startFirstLaunchStockfish } from "@/state/firstLaunchStockfish";
import { usePlatform } from "@/utils/files";

const ignoreProgressState = () => {};

export function AutomaticStockfishNotice() {
  const { os } = usePlatform();
  const store = useStore();
  const job = useAtomValue(automaticStockfishJobAtom);
  const running = useDownloadJob(job?.progressId ?? "");
  useEffect(() => startFirstLaunchStockfish(os, store), [os, store]);
  if (!job || !running) return null;
  return (
    <Suspense fallback={null}>
      <Alert
        variant="outline"
        bg="var(--mantine-color-body)"
        title={`${job.engine.name} ${job.engine.version}`}
        role="status"
        pos="fixed"
        bottom="var(--mantine-spacing-xs)"
        right="var(--mantine-spacing-xs)"
        w="36rem"
        style={{
          zIndex: getDefaultZIndex("modal") - 1,
          maxWidth: "calc(100vw - 2rem)",
          maxHeight: "calc(100dvh - 2rem)",
          overflowY: "auto",
          overflowWrap: "anywhere",
        }}
      >
        <StockfishInstallProgress
          id={job.progressId}
          initInstalled={false}
          onClick={ignoreProgressState}
          inProgress={running}
          setInProgress={ignoreProgressState}
        />
      </Alert>
    </Suspense>
  );
}
