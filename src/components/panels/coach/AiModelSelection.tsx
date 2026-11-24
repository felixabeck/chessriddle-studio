import { Anchor, Button, Group, Select, Stack, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError, ConnectionSummary, ModelInfo } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import {
  COACH_EFFORT_LEVELS,
  coachConnectionsAtom,
  coachEffortLevels,
  coachModelsAtom,
  coachSelectionAtom,
  effectiveCoachConnection,
  effectiveCoachSelection,
  openCoachUsage,
  type CoachConnectionsState,
  type CoachModelsState,
  type CoachSelection,
  type EffectiveCoachSelection,
} from "@/state/coach";
import classes from "./CoachPanel.module.css";

/** The effort selector's entry for "send no effort level". */
const PROVIDER_DEFAULT = "provider-default";

export type AiModelSelectionState = {
  connectionsState: CoachConnectionsState;
  reloadConnections: () => Promise<void>;
  connections: ConnectionSummary[];
  connection: string | null;
  modelsState: CoachModelsState;
  models: ModelInfo[] | null;
  chosen: EffectiveCoachSelection;
  selection: CoachSelection;
  setSelection: (next: CoachSelection) => void;
};

/**
 * Shared connection, model and effort selection for the Coach and the Assistant.
 * Both panels read and write the same persisted `coachSelectionAtom`.
 */
export function useAiModelSelection(): AiModelSelectionState {
  const [connectionsState, reloadConnections] = useAtom(coachConnectionsAtom);
  const [modelsState, loadModels] = useAtom(coachModelsAtom);
  const [selection, setSelection] = useAtom(coachSelectionAtom);

  const connections =
    connectionsState.status === "ready"
      ? connectionsState.connections.filter((connection) => connection.status === "ready")
      : [];
  // A sole connection counts as chosen without a click, so the model list is matched to the
  // effective connection, not only to the stored one.
  const connection = effectiveCoachConnection(selection.connection, connections)?.handle ?? null;
  const models =
    modelsState.status === "ready" && modelsState.connection === connection
      ? modelsState.models
      : null;
  const chosen = effectiveCoachSelection(selection, connections, models);

  // The model list belongs to the chosen connection; it is read when that changes.
  useEffect(() => {
    void loadModels(connection);
  }, [connection, loadModels]);

  return {
    connectionsState,
    reloadConnections,
    connections,
    connection,
    modelsState,
    models,
    chosen,
    selection,
    setSelection,
  };
}

/**
 * Handles the connection-availability gates shared by the Coach and the Assistant:
 * loading, failed list, keyring unavailable, and no ready connection.
 */
export function AiConnectionGate({
  connectionsState,
  readyConnections,
  errors,
  noConnectionText,
  onReload,
  onOpenSettings,
  children,
}: {
  connectionsState: CoachConnectionsState;
  readyConnections: readonly ConnectionSummary[];
  errors: Record<CoachError, string>;
  noConnectionText: string;
  onReload: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  if (connectionsState.status === "loading") return null;
  if (connectionsState.status === "failed") {
    return (
      <Text className={classes.empty} c="danger" role="alert">
        {errors[connectionsState.error]}
      </Text>
    );
  }
  if (
    readyConnections.length === 0 &&
    connectionsState.connections.some((connection) => connection.status === "storageUnavailable")
  ) {
    // There are connections, but the keyring did not answer: that is not "no connection".
    return (
      <Stack className={classes.empty} align="flex-start" gap="sm">
        <Text c="danger" role="alert">
          {errors.storage}
        </Text>
        <Button variant="default" onClick={onReload}>
          {t("Common.Retry")}
        </Button>
      </Stack>
    );
  }
  if (readyConnections.length === 0) {
    return (
      <Stack className={classes.empty} align="flex-start" gap="sm">
        <Text>{noConnectionText}</Text>
        <Button variant="default" onClick={onOpenSettings}>
          {t("Coach.OpenSettings")}
        </Button>
      </Stack>
    );
  }

  return <>{children}</>;
}

/**
 * Connection, model and effort selectors with "New conversation" and the ChatGPT plan notice.
 */
export function AiModelHeader({
  state,
  errors,
  newConversationDisabled,
  onNewConversation,
}: {
  state: AiModelSelectionState;
  errors: Record<CoachError, string>;
  newConversationDisabled: boolean;
  onNewConversation: () => void;
}) {
  const { t } = useTranslation();
  const { connections, connection, modelsState, models, chosen, selection, setSelection } = state;

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
        onChange={(model) => setSelection({ connection, model, effort: null })}
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
        disabled={newConversationDisabled}
        onClick={onNewConversation}
      >
        <MessageSquarePlus size="1rem" />
      </IconAction>
      {chosen.connection?.kind === "chatGpt" && (
        <Group className={classes.plan} gap="xs">
          <Text size="xs" c="dimmed">
            {t("Coach.Plan.Using")}
          </Text>
          <Anchor component="button" type="button" size="xs" onClick={openCoachUsage}>
            {t("Coach.Plan.ManageUsage")}
          </Anchor>
        </Group>
      )}
    </Group>
  );
}
