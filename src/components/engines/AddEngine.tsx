import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Tabs,
  Text,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { AlertCircle } from "lucide-react";
import { useAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { cancelDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import { enginesAtom } from "@/state/atoms";
import AppModal from "../common/AppModal";
import {
  type LocalEngine,
  type DefaultEngine,
  type RemoteEngine,
  EngineCatalogVerificationError,
  manifestEngineInstallCard,
  useDefaultEngines,
} from "@/utils/engines";
import { usePlatform } from "@/utils/files";
import CatalogEngineCard from "./CatalogEngineCard";
import EngineForm from "./EngineForm";
import { createEngineFormValidation } from "./engineFormValidation";
import { installCatalogEngineJob, usePendingEngineCompletion } from "@/state/catalogEngineCompletion";

function AddEngine({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const { t } = useTranslation();

  const [allEngines, setEngines] = useAtom(enginesAtom);
  const engines = (allEngines ?? []).filter((e): e is LocalEngine => e.type === "local");

  const { os } = usePlatform();

  const { defaultEngines, error, isLoading } = useDefaultEngines(os, opened);

  const form = useForm<LocalEngine>({
    initialValues: {
      type: "local",
      id: crypto.randomUUID(),
      version: "",
      name: "",
      handle: undefined as unknown as LocalEngine["handle"],
      filename: "",
      imageHandle: undefined,
      elo: undefined,
    },

    validate: createEngineFormValidation(engines, t),
  });

  return (
    <AppModal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Engines.Add.Title")}
      size="80%"
    >
      <Tabs defaultValue="download">
        <Tabs.List>
          <Tabs.Tab value="download">{t("Common.Download")}</Tabs.Tab>
          <Tabs.Tab value="cloud">{t("Engines.Add.Cloud")}</Tabs.Tab>
          <Tabs.Tab value="local">{t("Common.Local")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="download" pt="xs">
          {isLoading && (
            <Center>
              <Loader />
            </Center>
          )}
          <ScrollArea.Autosize mah={720} offsetScrollbars>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              {defaultEngines?.map((engine) => {
                const card = manifestEngineInstallCard(engines, engine);
                return (
                  <EngineCard
                    engine={engine}
                    key={card.progressId ?? engine.path}
                    progressId={card.progressId}
                    initInstalled={card.initInstalled}
                  />
                );
              })}
              {error && (
                <Alert icon={<AlertCircle size="1rem" />} title={t("Common.Error")} color="danger">
                  {t(
                    error instanceof EngineCatalogVerificationError
                      ? "Engines.Add.ErrorCatalog"
                      : "Engines.Add.ErrorFetch",
                  )}
                </Alert>
              )}
            </SimpleGrid>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="cloud" pt="xs">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "ChessDB",
                type: "chessdb",
                url: "https://chessdb.cn",
              }}
            />
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "Lichess Cloud",
                type: "lichess",
                url: "https://lichess.org",
              }}
            />
          </SimpleGrid>
        </Tabs.Panel>
        <Tabs.Panel value="local" pt="xs">
          <EngineForm
            submitLabel={t("Common.Add")}
            form={form}
            onSubmit={async (values: LocalEngine) => {
              const receipt = await setEngines((prev) => [
                ...prev,
                {
                  ...values,
                  id: crypto.randomUUID(),
                },
              ]);
              return receipt;
            }}
            onSaved={() => {
              form.setFieldValue("id", crypto.randomUUID());
              setOpened(false);
            }}
          />
        </Tabs.Panel>
      </Tabs>
    </AppModal>
  );
}

function CloudCard({ engine }: { engine: RemoteEngine }) {
  const { t } = useTranslation();

  const [engines, setEngines] = useAtom(enginesAtom);
  const admission = useRef(false);
  const alive = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Paper withBorder radius="md" p={0} key={engine.name}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="sm" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("Common.Engine")}
          </Text>
          <Text fw="bold" size="sm">
            {engine.name}
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            {engine.url}
          </Text>
          <Button
            disabled={pending || (engines ?? []).find((e) => e.type === engine.type) !== undefined}
            fullWidth
            size="xs"
            onClick={() => {
              if (admission.current) return;
              admission.current = true;
              setPending(true);
              const added: RemoteEngine = {
                ...engine,
                id: crypto.randomUUID(),
                type: engine.type,
                loaded: true,
                settings: [
                  {
                    type: "string",
                    name: "MultiPV",
                    value: "1",
                  },
                ],
              };
              void (async () => {
                try {
                  await setEngines((current) =>
                    current.some((item) => item.type === added.type)
                      ? current
                      : [...current, added],
                  );
                } catch (error) {
                  notifyUnlessCancelled(t("Common.Error"), error);
                } finally {
                  admission.current = false;
                  if (alive.current) setPending(false);
                }
              })();
            }}
          >
            {t("Common.Add")}
          </Button>
        </Box>
      </Group>
    </Paper>
  );
}

function EngineCard({
  engine,
  progressId,
  initInstalled,
}: {
  engine: DefaultEngine;
  progressId: string | null;
  initInstalled: boolean;
}) {
  const { t } = useTranslation();

  const [inProgress, setInProgress] = useState<boolean>(false);
  const hasJob = useDownloadJob(progressId ?? "");
  const [installedThisSession, setInstalledThisSession] = useState(false);
  const store = useStore();
  const pending = usePendingEngineCompletion(progressId);
  const downloadEngine = useCallback(async () => {
    if (!progressId) return;
    setInProgress(true);
    try {
      if (await installCatalogEngineJob(engine, progressId, undefined, store)) {
        setInstalledThisSession(true);
      }
    } finally {
      setInProgress(false);
    }
  }, [engine, progressId, store]);

  return (
    <CatalogEngineCard
      engine={engine}
      layout="add"
      progressId={progressId}
      initInstalled={initInstalled || installedThisSession}
      recovery={
        pending?.completion.outcome.state === "succeeded"
          ? { busy: pending.applying || inProgress, retry: () => void downloadEngine() }
          : undefined
      }
      labels={{
        completed: t("Common.Installed"),
        action: t("Common.Install"),
        inProgress: t("Common.Downloading"),
        finalizing: t("Common.Extracting"),
      }}
      onClick={() => {
        void downloadEngine();
      }}
      onCancel={progressId ? () => cancelDownloadJob(progressId, t("Common.Error")) : undefined}
      inProgress={inProgress || hasJob}
      setInProgress={setInProgress}
    />
  );
}

export default AddEngine;
