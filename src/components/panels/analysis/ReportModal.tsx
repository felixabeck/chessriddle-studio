import { Alert, Button, Checkbox, Group, Select, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue, useStore as useJotaiStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { memo, useContext, useEffect, useMemo, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { useStore } from "zustand";
import type { GameAnalysis, GoMode } from "@/bindings";
import GoModeInput from "@/components/common/GoModeInput";
import { normalizeError } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import AppModal from "../../common/AppModal";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";
import { currentCollectionDatabase, useCollectionCurrency } from "@/state/linkedCollections";
import { createZodStorage } from "@/state/utils";
import {
  captureReportOwner,
  isReportOwnerCurrent,
  type ReportRequest,
  waitForReportOwner,
} from "@/state/store/tree";
import { getMainLine, reportRootFingerprint } from "@/utils/chess";
import { boundedGoModeSchema, type LocalEngine } from "@/utils/engines";
import { capabilityKey } from "@/utils/pathCapabilities";
import { normalizeEngineOptions } from "@/components/engines/engineOptions";
import { z } from "zod";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { reportEngineFailure } from "./engineFailure";

type ReportGoMode = Extract<GoMode, { t: "Depth" | "Time" | "Nodes" }>;

function isReportGoMode(mode: GoMode): mode is ReportGoMode {
  return mode.t === "Depth" || mode.t === "Time" || mode.t === "Nodes";
}

type ReportSettings = {
  novelty: boolean;
  marks: boolean;
  variations: boolean;
  goMode: ReportGoMode;
  engine: string;
};

const defaultReportSettings: ReportSettings = {
  novelty: true,
  marks: true,
  variations: true,
  goMode: { t: "Time", c: 500 },
  engine: "",
};

const reportSettingsSchema: z.ZodType<ReportSettings, z.ZodTypeDef, unknown> = z.object({
  novelty: z.boolean().catch(defaultReportSettings.novelty),
  marks: z.boolean().catch(defaultReportSettings.marks),
  variations: z.boolean().catch(defaultReportSettings.variations),
  goMode: boundedGoModeSchema.catch(defaultReportSettings.goMode),
  engine: z.string().catch(defaultReportSettings.engine),
});

/** One notice for a report that finished with gaps, or none. */
function notifyReportGaps(
  t: (key: string, options?: Record<string, unknown>) => string,
  result: GameAnalysis,
) {
  const missing = result.positions.filter(
    (position) => position.best.length === 0 && position.terminal === null,
  ).length;
  const parts = [
    missing > 0 ? t("Board.Analysis.Report.MissingEvaluations", { positions: missing }) : null,
    result.novelty.kind === "unavailable" ? t("Board.Analysis.Report.NoveltyUnavailable") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return;
  notifications.show({
    color: "warning",
    title: t("Board.Analysis.Report.Incomplete"),
    message: parts.join(" "),
  });
}

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
}: {
  tab: string;
  initialFen: string;
  moves: string[];
  reportingMode: boolean;
  closeReportingMode: () => void;
  setInProgress: (value: boolean) => void;
  registerOperation: (id: string) => void;
}) {
  const { t } = useTranslation();

  const referenceDb = useAtomValue(referenceDbAtom);
  const atomStore = useJotaiStore();
  const currency = useCollectionCurrency(referenceDb);
  const referenceUnavailable =
    !!referenceDb && currentCollectionDatabase(referenceDb, currency) === null;
  // The novelty needs a reference whose index is ready; otherwise the option is off.
  const referenceReady = !!referenceDb && !referenceUnavailable;
  const engines = useAtomValue(enginesAtom);
  const localEngines = useMemo(
    () => (engines ?? []).filter((e): e is LocalEngine => e.type === "local"),
    [engines],
  );
  const store = useContext(TreeStateContext)!;
  const inProgress = useStore(store, (s) => s.report.inProgress);
  const prepareGeneration = useRef(0);
  const pendingPreparation = useRef<AbortController | null>(null);
  const referenceCallbacks = useRef({ t });
  referenceCallbacks.current = { t };
  useEffect(() => {
    if (currency.error)
      notifyUnlessCancelled(referenceCallbacks.current.t("Common.Error"), currency.error);
  }, [currency.error]);
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
      // A stored id that is no longer installed is no choice: say so instead of a silent click.
      engine: (value) =>
        !value || !localEngines.some((engine) => engine.id === value)
          ? t("Board.Analysis.EngineRequired")
          : undefined,
    },
  });

  const formRef = useRef(form);
  formRef.current = form;
  // Stored settings replace the form only when they change: storage hydration,
  // another window, or this dialog's own save in analyze().
  useEffect(() => {
    formRef.current.setValues(reportSettings);
  }, [reportSettings]);
  // Fall back only once the engine list has loaded and the selected engine is
  // not installed; prefer the stored engine, and keep the user's other edits.
  useEffect(() => {
    if (engines == null) return;
    const current = formRef.current.getValues().engine;
    if (localEngines.some((engine) => engine.id === current)) return;
    const nextEngine = localEngines.some((engine) => engine.id === reportSettings.engine)
      ? reportSettings.engine
      : (localEngines[0]?.id ?? defaultReportSettings.engine);
    if (current !== nextEngine) formRef.current.setFieldValue("engine", nextEngine);
  }, [engines, localEngines, reportSettings]);

  async function analyze() {
    // A tab runs one report at a time; the dialog cannot start a second one.
    if (store.getState().report.inProgress) return;
    pendingPreparation.current?.abort();
    const preparation = new AbortController();
    pendingPreparation.current = preparation;
    const generation = ++prepareGeneration.current;
    const ownerEpoch = captureReportOwner(tab);
    setReportSettings(form.values);
    const rootFingerprint = reportRootFingerprint(initialFen, moves);
    const settings = form.values;
    // The stored preference survives an unavailable reference; the run uses the effective value.
    const annotateNovelties = settings.novelty && referenceReady;
    const engine = localEngines.find((e) => e.id === settings.engine);
    if (!engine) return;
    const preparationCurrent = () =>
      generation === prepareGeneration.current &&
      isReportOwnerCurrent(tab, ownerEpoch) &&
      currentRootFingerprint.current === rootFingerprint;
    let operationId: string;
    try {
      operationId = await tauri.prepareAnalysis(tab, { signal: preparation.signal });
    } catch (error) {
      if (preparationCurrent())
        notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      return;
    } finally {
      if (pendingPreparation.current === preparation) pendingPreparation.current = null;
    }
    if (!preparationCurrent()) {
      // A later submission or a changed game superseded this one before it was claimed.
      try {
        await tauri.cancelAnalysis(operationId);
      } catch (error) {
        if (preparationCurrent())
          notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
      }
      return;
    }
    registerOperation(operationId);
    setInProgress(true);
    closeReportingMode();
    const engineSettings = normalizeEngineOptions(engine?.settings ?? []);

    const operationCurrent = () =>
      isReportOwnerCurrent(tab, ownerEpoch) && store.getState().report.operationId === operationId;
    const gameUnchanged = () => {
      const { root } = store.getState();
      return reportRootFingerprint(root.fen, getMainLine(root)) === rootFingerprint;
    };

    // An edit to the root or the mainline cancels the run at once, also while the panel is
    // unmounted: this subscription belongs to the run, not to the component.
    let gameChanged = false;
    const unsubscribe = store.subscribe((state, previous) => {
      if (gameChanged || state.root === previous.root || gameUnchanged()) return;
      if (!operationCurrent()) return;
      gameChanged = true;
      // Outside the store's own write: a cancel failure cannot break the edit that caused it.
      Promise.resolve()
        .then(() => tauri.cancelAnalysis(operationId))
        .catch((error) => {
          if (operationCurrent())
            notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
        });
    });

    // The reference only decides whether a novelty outcome can be trusted. It never blocks or
    // cancels the run, and a failing check never gates feedback.
    const referenceKey = referenceDb ? capabilityKey(referenceDb) : null;
    const capturedCollection = currency.collection;
    const referenceStillCurrent = async () => {
      const selected = atomStore.get(referenceDbAtom);
      if ((selected ? capabilityKey(selected) : null) !== referenceKey) return false;
      if (!referenceDb) return true;
      try {
        const current = await tauri.collectionForDatabase(referenceDb);
        const reselected = atomStore.get(referenceDbAtom);
        if ((reselected ? capabilityKey(reselected) : null) !== referenceKey) return false;
        return capturedCollection
          ? !!current &&
              current.id === capturedCollection.id &&
              current.status === "ready" &&
              current.generation === capturedCollection.generation &&
              !!current.database &&
              !!capturedCollection.database &&
              capabilityKey(current.database) === capabilityKey(capturedCollection.database)
          : current === null;
      } catch {
        return false;
      }
    };
    const request: ReportRequest = {
      operationId,
      fingerprint: rootFingerprint,
      engine: engine.name,
      goMode: settings.goMode,
      marks: settings.marks,
      lines: settings.variations,
      createdAt: Date.now(),
    };

    try {
      const result = await tauri.analyzeGame(
        operationId,
        tab,
        engine.handle,
        engine.id,
        settings.goMode,
        {
          annotateNovelties,
          fen: initialFen,
          referenceDb: currency.collection?.database ?? referenceDb,
          moves,
        },
        engineSettings,
      );
      if (!(await waitForReportOwner(tab, ownerEpoch)) || !operationCurrent()) return;
      const noveltyKnown = result.novelty.kind === "found" || result.novelty.kind === "notFound";
      const trusted =
        noveltyKnown && !(await referenceStillCurrent())
          ? { ...result, novelty: { kind: "unavailable" as const } }
          : result;
      if (!operationCurrent()) return;
      if (!gameUnchanged()) {
        gameChanged = true;
        return;
      }
      if (store.getState().applyReport(trusted, { ...request, createdAt: Date.now() }))
        notifyReportGaps(t, trusted);
    } catch (error) {
      if (!(await waitForReportOwner(tab, ownerEpoch)) || !operationCurrent()) return;
      if (gameChanged || !gameUnchanged()) {
        gameChanged = true;
        return;
      }
      // Every native cancel of a report comes from a cancel the renderer asked for (Cancel, a
      // replacement, an edit, a tab close); "Analysis cancelled" can still arrive before the
      // Cancel acknowledgement clears the operation, and R4 shows no notice for it.
      if (normalizeError(error).category === "cancelled") return;
      notifyUnlessCancelled(t("Common.Error"), reportEngineFailure(t, error));
    } finally {
      unsubscribe();
      if ((await waitForReportOwner(tab, ownerEpoch)) && operationCurrent()) {
        setInProgress(false);
        if (gameChanged)
          notifications.show({
            color: "warning",
            message: t("Board.Analysis.Report.GameChanged"),
          });
      }
    }
  }

  return (
    <AppModal
      opened={reportingMode}
      onClose={closeReportingMode}
      title={t("Board.Analysis.GenerateReport")}
    >
      <form onSubmit={form.onSubmit(() => analyze())}>
        <Stack>
          {engines != null && localEngines.length === 0 && (
            <Alert color="warning">
              <Trans
                i18nKey="Engines.Selection.None"
                components={{
                  addEngineLink: <Link to="/engines" onClick={closeReportingMode} />,
                }}
              />
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
            label={t("Board.Analysis.MarkMoves")}
            description={t("Board.Analysis.MarkMoves.Desc")}
            {...form.getInputProps("marks", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.ShowVariations")}
            description={t("Board.Analysis.ShowVariations.Desc")}
            {...form.getInputProps("variations", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.AnnotateNovelties")}
            description={
              referenceReady ? (
                t("Board.Analysis.AnnotateNovelties.Desc")
              ) : referenceDb ? (
                t("Collections.Unavailable")
              ) : (
                <Trans
                  i18nKey="Board.Analysis.AnnotateNovelties.NoReference"
                  components={{
                    libraryLink: <Link to="/library" onClick={closeReportingMode} />,
                  }}
                />
              )
            }
            disabled={!referenceReady}
            {...form.getInputProps("novelty", { type: "checkbox" })}
            checked={form.values.novelty && referenceReady}
          />

          <Group justify="right">
            <Button
              type="submit"
              disabled={inProgress || engines == null || localEngines.length === 0}
            >
              {t("Board.Analysis.Analyze")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}

export default memo(ReportModal);
