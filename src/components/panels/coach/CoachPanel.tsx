import { Button, Group, ScrollArea, Select, Stack, Text, Textarea } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import { MessageSquarePlus } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import AppModal from "@/components/common/AppModal";
import { IconAction } from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useCoachErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import { coachTurnFamily, enginesAtom } from "@/state/atoms";
import {
  COACH_EFFORT_LEVELS,
  coachConnectionsAtom,
  coachEffortLevels,
  coachEngineAtom,
  coachModelsAtom,
  coachNoticeAcceptedAtom,
  coachSelectionAtom,
  effectiveCoachEngine,
  effectiveCoachSelection,
  withCoachNoticeAccepted,
} from "@/state/coach";
import { sendCoachMessage, startNewCoachConversation, stopCoachTurn } from "@/state/coachTurns";
import { useOwnerTabId, useTabAtom } from "@/state/tabScope";
import { CoachTranscript } from "./CoachTranscript";
import classes from "./CoachPanel.module.css";

const MAX_QUESTION_CHARS = 4000;
/** The effort selector's entry for "send no effort level". */
const PROVIDER_DEFAULT = "provider-default";

function CoachPanel() {
  const { t } = useTranslation();
  const errors = useCoachErrorMessages();
  const navigate = useNavigate();
  const atoms = useAtomStore();
  const tab = useOwnerTabId();
  const tree = useContext(TreeStateContext)!;
  const session = useStore(tree, (state) => state.coachSession);
  const running = useAtomValue(useTabAtom(coachTurnFamily));

  const connectionsState = useAtomValue(coachConnectionsAtom);
  const [modelsState, loadModels] = useAtom(coachModelsAtom);
  const [selection, setSelection] = useAtom(coachSelectionAtom);
  const engines = useAtomValue(enginesAtom);
  const engine = effectiveCoachEngine(engines, useAtomValue(coachEngineAtom));
  const [accepted, setAccepted] = useAtom(coachNoticeAcceptedAtom);

  const connections =
    connectionsState.status === "ready"
      ? connectionsState.connections.filter((connection) => connection.status === "ready")
      : [];
  const models =
    modelsState.status === "ready" && modelsState.connection === selection.connection
      ? modelsState.models
      : null;
  const chosen = effectiveCoachSelection(selection, connections, models);
  const connection = chosen.connection?.handle ?? null;

  // The model list belongs to the chosen connection; it is read when that changes.
  useEffect(() => {
    void loadModels(connection);
  }, [connection, loadModels]);

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];
  const shownTurn = running && !running.orphaned ? running : null;
  // New content keeps the end of the conversation in view.
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [messages.length, shownTurn?.text, shownTurn?.checking]);

  if (connectionsState.status === "loading") return null;
  if (connectionsState.status === "failed") {
    return (
      <Text className={classes.empty} c="danger" role="alert">
        {errors[connectionsState.error]}
      </Text>
    );
  }
  if (connections.length === 0) {
    return (
      <Stack className={classes.empty} align="flex-start" gap="sm">
        <Text>{t("Coach.NoConnection")}</Text>
        <Button variant="default" onClick={() => void navigate({ to: "/settings" })}>
          {t("Coach.OpenSettings")}
        </Button>
      </Stack>
    );
  }
  if (engines !== undefined && !engine) {
    return (
      <Stack className={classes.empty} align="flex-start" gap="sm">
        <Text>{t("Coach.NoEngine")}</Text>
        <Button variant="default" onClick={() => void navigate({ to: "/engines" })}>
          {t("Coach.OpenEngines")}
        </Button>
      </Stack>
    );
  }

  const question = draft.trim();
  const ready = chosen.connection && chosen.model && engine;
  const send = (text: string) => {
    if (!chosen.connection || !chosen.model || !engine) return;
    setDraft("");
    void sendCoachMessage(atoms, {
      tab,
      tree,
      question: text,
      connection: chosen.connection.handle,
      model: chosen.model.id,
      effort: chosen.effort,
      engine,
    });
  };
  const submit = () => {
    if (!ready || running || question === "" || !chosen.connection) return;
    // Nothing leaves this computer for a connection before its notice was accepted.
    if (!accepted.includes(chosen.connection.handle)) setNotice(question);
    else send(question);
  };

  const reportsEffort = (chosen.model?.effortLevels.length ?? 0) > 0;
  const effortLabel = (level: string) =>
    level === "low"
      ? t("Coach.Effort.Low")
      : level === "medium"
        ? t("Coach.Effort.Medium")
        : level === "high"
          ? t("Coach.Effort.High")
          : level;
  const effortOptions = [
    ...(reportsEffort ? [] : [{ value: PROVIDER_DEFAULT, label: t("Coach.Effort.Default") }]),
    ...(chosen.model ? coachEffortLevels(chosen.model) : COACH_EFFORT_LEVELS).map((level) => ({
      value: level,
      label: effortLabel(level),
    })),
  ];

  return (
    <div className={classes.panel}>
      <Group className={classes.header} gap="xs" wrap="wrap">
        <Select
          className={classes.selector}
          size="xs"
          aria-label={t("Coach.Connection")}
          placeholder={t("Coach.Connection")}
          data={connections.map((item) => ({ value: item.handle, label: item.label }))}
          value={connection}
          allowDeselect={false}
          onChange={(handle) => setSelection({ connection: handle, model: null, effort: null })}
        />
        <Select
          className={classes.selector}
          size="xs"
          searchable
          aria-label={t("Coach.Model")}
          placeholder={
            modelsState.status === "loading" ? t("Coach.ModelsLoading") : t("Coach.ChooseModel")
          }
          data={(models ?? []).map((model) => ({ value: model.id, label: model.name }))}
          value={chosen.model?.id ?? null}
          allowDeselect={false}
          disabled={!models}
          error={
            modelsState.status === "failed" && modelsState.connection === connection
              ? errors[modelsState.error]
              : undefined
          }
          onChange={(model) => setSelection({ ...selection, model, effort: null })}
        />
        <Select
          className={classes.effort}
          size="xs"
          aria-label={t("Coach.Effort")}
          data={effortOptions}
          value={chosen.effort ?? (reportsEffort ? null : PROVIDER_DEFAULT)}
          allowDeselect={false}
          disabled={!chosen.model}
          onChange={(level) =>
            setSelection({ ...selection, effort: level === PROVIDER_DEFAULT ? null : level })
          }
        />
        <IconAction
          label={t("Coach.NewConversation")}
          variant="default"
          disabled={messages.length === 0 && !running}
          onClick={() => startNewCoachConversation(atoms, tab, tree)}
        >
          <MessageSquarePlus size="1rem" />
        </IconAction>
      </Group>
      <ScrollArea className={classes.transcript} viewportRef={viewport}>
        {messages.length === 0 && !shownTurn ? (
          <Text className={classes.empty} c="dimmed">
            {t("Coach.Empty")}
          </Text>
        ) : (
          <CoachTranscript messages={messages} running={shownTurn} />
        )}
      </ScrollArea>
      <form
        className={classes.composer}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <Textarea
            style={{ flex: 1 }}
            autosize
            minRows={1}
            maxRows={6}
            maxLength={MAX_QUESTION_CHARS}
            aria-label={t("Coach.Ask")}
            placeholder={t("Coach.Ask")}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <Button
              variant="default"
              disabled={running.stopping}
              onClick={() => stopCoachTurn(atoms, tab)}
            >
              {t("Coach.Stop")}
            </Button>
          ) : (
            <Button type="submit" disabled={!ready || question === ""}>
              {t("Coach.Send")}
            </Button>
          )}
        </Group>
      </form>
      {notice !== null && chosen.connection && (
        <AppModal opened onClose={() => setNotice(null)} title={t("Coach.Notice.Title")}>
          <Stack>
            <Text>{t("Coach.Notice.Body", { provider: chosen.connection.label })}</Text>
            <Group justify="right">
              <Button variant="default" onClick={() => setNotice(null)}>
                {t("Common.Cancel")}
              </Button>
              <Button
                onClick={() => {
                  if (!chosen.connection) return;
                  setAccepted(withCoachNoticeAccepted(accepted, chosen.connection.handle));
                  setNotice(null);
                  send(notice);
                }}
              >
                {t("Coach.Notice.Accept")}
              </Button>
            </Group>
          </Stack>
        </AppModal>
      )}
    </div>
  );
}

export default CoachPanel;
