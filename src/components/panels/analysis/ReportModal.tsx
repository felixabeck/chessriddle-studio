import { Alert, Button, Checkbox, Group, Select, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useAtom, useAtomValue, useStore as useJotaiStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { memo, useContext, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { GoMode } from "@/bindings";
import GoModeInput from "@/components/common/GoModeInput";
import { tauri } from "@/platform/tauri";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import AppModal from "../../common/AppModal";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";
import { useCollectionCurrency } from "@/state/linkedCollections";
import { createZodStorage } from "@/state/utils";
import { captureReportOwner, isReportOwnerCurrent, waitForReportOwner } from "@/state/store/tree";
import { boundedGoModeSchema, type LocalEngine } from "@/utils/engines";
import { capabilityKey } from "@/utils/pathCapabilities";
import { normalizeEngineOptions } from "@/components/engines/engineOptions";
import { z } from "zod";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { reportEngineFailure } from "./useDisplayedEngineLines";

type ReportGoMode = Extract<GoMode, { t: "Depth" | "Time" | "Nodes" }>;

function isReportGoMode(mode: GoMode): mode is ReportGoMode {
  return mode.t === "Depth" || mode.t === "Time" || mode.t === "Nodes";
}

export function reportRootFingerprint(fen: string, moves: string[]): string {
  return `${fen}\u0000${moves.join("\u0000")}`;
}

type ReportSettings = {
  novelty: boolean;
  reversed: boolean;
  variations: boolean;
  goMode: ReportGoMode;
  engine: string;
};

const defaultReportSettings: ReportSettings = {
  novelty: true,
  reversed: true,
  variations: true,
  goMode: { t: "Time", c: 500 },
  engine: "",
};

const reportSettingsSchema: z.ZodType<ReportSettings, z.ZodTypeDef, unknown> = z.object({
  novelty: z.boolean().catch(defaultReportSettings.novelty),
  reversed: z.boolean().catch(defaultReportSettings.reversed),
  variations: z.boolean().catch(defaultReportSettings.variations),
  goMode: boundedGoModeSchema.catch(defaultReportSettings.goMode),
  engine: z.string().catch(defaultReportSettings.engine),
});

const reportSettingsAtom = atomWithStorage(
  "report-settings",
  defaultReportSettings,
  createZodStorage(reportSettingsSchema, localStorage),
);

function ReportModal({
  tab,
  initialFen,
  moves,
  reportingMode,
  closeReportingMode,
  setInProgress,
  registerOperation,
  isCurrentOperation,
}: {
  tab: string;
  initialFen: string;
  moves: string[];
  reportingMode: boolean;
  closeReportingMode: () => void;
  setInProgress: (value: boolean) => void;
  registerOperation: (id: string) => void;
  isCurrentOperation: (id: string, fingerprint: string) => boolean;
}) {
  const { t } = useTranslation();

  const referenceDb = useAtomValue(referenceDbAtom);
  const atomStore = useJotaiStore();
  const currency = useCollectionCurrency(referenceDb);
  const referenceUnavailable =
    !!referenceDb &&
    (currency.pending ||
      !!currency.error ||
      (!!currency.collection &&
        (currency.collection.status !== "ready" || !currency.collection.database)));
  const activeReferenceOperation = useRef<{
    id: string;
    owner: object;
    cancelling: boolean;
  } | null>(null);
  const currentReferenceIdentity = JSON.stringify([
    referenceDb ? capabilityKey(referenceDb) : null,
    currency.pending,
    !!currency.error,
    currency.collection?.id,
    currency.collection?.status,
    currency.collection?.generation,
    currency.collection?.database ? capabilityKey(currency.collection.database) : null,
  ]);
  const referenceIdentity = useRef(currentReferenceIdentity);
  referenceIdentity.current = currentReferenceIdentity;
  const engines = useAtomValue(enginesAtom);
  const localEngines = useMemo(
    () => (engines ?? []).filter((e): e is LocalEngine => e.type === "local"),
    [engines],
  );
  const store = useContext(TreeStateContext)!;
  const addAnalysis = useStore(store, (s) => s.addAnalysis);
  const prepareGeneration = useRef(0);
  const pendingPreparation = useRef<AbortController | null>(null);
  const referenceCallbacks = useRef({ t, setInProgress });
  referenceCallbacks.current = { t, setInProgress };
  useEffect(() => {
    if (currency.error)
      notifyUnlessCancelled(referenceCallbacks.current.t("Common.Error"), currency.error);
  }, [currency.error]);
  useEffect(() => {
    pendingPreparation.current?.abort();
    prepareGeneration.current += 1;
    const operation = activeReferenceOperation.current;
    if (!operation || operation.cancelling) return;
    operation.cancelling = true;
    const { t, setInProgress } = referenceCallbacks.current;
    void tauri
      .cancelAnalysis(operation.id)
      .catch((error) => {
        if (
          isReportOwnerCurrent(tab, operation.owner) &&
          store.getState().report.operationId === operation.id
        )
          notifyUnlessCancelled(t("Common.Error"), error);
      })
      .finally(async () => {
        if (
          activeReferenceOperation.current === operation &&
          (await waitForReportOwner(tab, operation.owner)) &&
          isReportOwnerCurrent(tab, operation.owner) &&
          store.getState().report.operationId === operation.id
        ) {
          activeReferenceOperation.current = null;
          setInProgress(false);
        }
      });
  }, [currentReferenceIdentity, store, tab]);
  const currentRootFingerprint = useRef("");
  currentRootFingerprint.current = reportRootFingerprint(initialFen, moves);

  useEffect(
    () => () => {
      prepareGeneration.current += 1;
      pendingPreparation.current?.abort();
    },
    [],
  );

  const [reportSettings, setReportSettings] = useAtom(reportSettingsAtom);
  const form = useForm({
    initialValues: reportSettings,
    validate: {
      engine: (value) => {
        if (!value) return t("Board.Analysis.EngineRequired");
      },
      novelty: (value) => {
        if (value && !referenceDb) return t("Board.Analysis.RefDBRequired");
      },
    },
  });

  const formRef = useRef(form);
  formRef.current = form;
  // Stored settings replace the form only when they change: storage hydration,
  // another window, or this dialog's own save in analyze().
  useEffect(() => {
    formRef.current.setValues(reportSettings);
  }, [reportSettings]);
  // Fall back to the first local engine only when the selected engine is not
  // installed; the other fields keep the user's edits.
  useEffect(() => {
    const current = formRef.current.getValues().engine;
    if (localEngines.some((engine) => engine.id === current)) return;
    const fallback = localEngines[0]?.id ?? "";
    if (current !== fallback) formRef.current.setFieldValue("engine", fallback);
  }, [localEngines, reportSettings]);

  async function analyze() {
    if (referenceUnavailable) return;
    const capturedReferenceIdentity = referenceIdentity.current;
    pendingPreparation.current?.abort();
    const preparation = new AbortController();
    pendingPreparation.current = preparation;
    const generation = ++prepareGeneration.current;
    const ownerEpoch = captureReportOwner(tab);
    setReportSettings(form.values);
    const rootFingerprint = reportRootFingerprint(initialFen, moves);
    const variations = form.values.variations;
    const engine = localEngines.find((e) => e.id === form.values.engine);
    if (!engine) return;
    let operationId: string;
    try {
      operationId = await tauri.prepareAnalysis(tab, { signal: preparation.signal });
    } catch (error) {
      if (
        generation === prepareGeneration.current &&
        referenceIdentity.current === capturedReferenceIdentity &&
        isReportOwnerCurrent(tab, ownerEpoch) &&
        currentRootFingerprint.current === rootFingerprint
      )
        notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      return;
    } finally {
      if (pendingPreparation.current === preparation) pendingPreparation.current = null;
    }
    if (
      generation !== prepareGeneration.current ||
      referenceIdentity.current !== capturedReferenceIdentity ||
      !isReportOwnerCurrent(tab, ownerEpoch) ||
      currentRootFingerprint.current !== rootFingerprint
    ) {
      try {
        await tauri.cancelAnalysis(operationId);
      } catch (error) {
        if (
          generation === prepareGeneration.current &&
          referenceIdentity.current === capturedReferenceIdentity &&
          isReportOwnerCurrent(tab, ownerEpoch) &&
          currentRootFingerprint.current === rootFingerprint
        )
          notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      }
      return;
    }
    registerOperation(operationId);
    activeReferenceOperation.current = { id: operationId, owner: ownerEpoch, cancelling: false };
    setInProgress(true);
    closeReportingMode();
    const engineSettings = normalizeEngineOptions(engine?.settings ?? []);

    // The panel may unmount while native analysis continues. Its Jotai store
    // still owns selection, and native metadata owns linked index currency.
    const referenceKey = referenceDb ? capabilityKey(referenceDb) : null;
    const capturedCollection = currency.collection;
    const synchronousOwnersCurrent = () => {
      const selected = atomStore.get(referenceDbAtom);
      return (
        isReportOwnerCurrent(tab, ownerEpoch) &&
        isCurrentOperation(operationId, rootFingerprint) &&
        (selected ? capabilityKey(selected) : null) === referenceKey
      );
    };
    const completionOwnersCurrent = async () => {
      if (!(await waitForReportOwner(tab, ownerEpoch)) || !synchronousOwnersCurrent()) return false;
      if (!referenceDb) return true;
      try {
        const current = await tauri.collectionForDatabase(referenceDb);
        return (
          synchronousOwnersCurrent() &&
          (capturedCollection
            ? !!current &&
              current.id === capturedCollection.id &&
              current.status === "ready" &&
              current.generation === capturedCollection.generation &&
              !!current.database &&
              !!capturedCollection.database &&
              capabilityKey(current.database) === capabilityKey(capturedCollection.database)
            : current === null)
        );
      } catch {
        // Unverified reference metadata cannot authorize analysis or error feedback.
        return false;
      }
    };

    tauri
      .analyzeGame(
        operationId,
        tab,
        engine.handle,
        engine.id,
        form.values.goMode,
        {
          annotateNovelties: form.values.novelty,
          fen: initialFen,
          referenceDb: currency.collection?.database ?? referenceDb,
          reversed: form.values.reversed,
          moves,
        },
        engineSettings,
      )
      .then(async (analysis) => {
        // The immutable root fingerprint prevents a late completion from
        // applying to an edited/switched game even when a tab id is reused.
        if ((await completionOwnersCurrent()) && synchronousOwnersCurrent()) {
          addAnalysis(analysis, {
            showVariations: variations,
          });
        }
      })
      .catch(async (error) => {
        if ((await completionOwnersCurrent()) && synchronousOwnersCurrent()) {
          notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
        }
      })
      .finally(async () => {
        if (
          (await waitForReportOwner(tab, ownerEpoch)) &&
          isReportOwnerCurrent(tab, ownerEpoch) &&
          store.getState().report.operationId === operationId
        )
          setInProgress(false);
        if (activeReferenceOperation.current?.id === operationId)
          activeReferenceOperation.current = null;
      });
  }

  return (
    <AppModal
      opened={reportingMode}
      onClose={closeReportingMode}
      title={t("Board.Analysis.GenerateReport")}
    >
      <form onSubmit={form.onSubmit(() => analyze())}>
        <Stack>
          {referenceUnavailable && (
            <Alert color="warning">
              {t("Collections.Unavailable", {
                defaultValue:
                  "The search index is unavailable. Retry, or select the collection's source file again.",
              })}
            </Alert>
          )}
          <Select
            allowDeselect={false}
            withAsterisk
            label={t("Common.Engine")}
            placeholder={t("Common.PickValue")}
            data={
              localEngines.map((engine) => {
                return {
                  value: engine.id,
                  label: engine.name,
                };
              }) ?? []
            }
            {...form.getInputProps("engine")}
          />
          <GoModeInput
            gameMode
            timeDefault={defaultReportSettings.goMode.c}
            goMode={form.values.goMode}
            setGoMode={(next) => {
              if (isReportGoMode(next)) form.setFieldValue("goMode", next);
            }}
          />

          <Checkbox
            label={t("Board.Analysis.Reversed")}
            description={t("Board.Analysis.Reversed.Desc")}
            {...form.getInputProps("reversed", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.AnnotateNovelties")}
            description={t("Board.Analysis.AnnotateNovelties.Desc")}
            {...form.getInputProps("novelty", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.ShowVariations")}
            description={t("Board.Analysis.ShowVariations.Desc")}
            {...form.getInputProps("variations", { type: "checkbox" })}
          />

          <Group justify="right">
            <Button type="submit" disabled={referenceUnavailable}>
              {t("Board.Analysis.Analyze")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}

export default memo(ReportModal);
