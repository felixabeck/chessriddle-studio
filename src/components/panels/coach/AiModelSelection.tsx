import { Anchor, Button, Group, Select, Stack, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { ChevronDown, MessageSquarePlus } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError, ConnectionSummary, ModelInfo } from "@/bindings";
import AppPopover from "@/components/common/AppPopover";
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
  /** Set only while the chosen connection's model list failed: reads that list again. */
  retryModels: (() => void) | undefined;
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
  const modelsFailed =
    Boolean(chosen.connection) &&
    modelsState.status === "failed" &&
    modelsState.connection === connection;

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
    retryModels: modelsFailed ? () => void loadModels(connection) : undefined,
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
 * The hint under the composer while Send cannot be used: what is still to be chosen, or why the
 * model list is missing. The selectors live in a popover and in Settings, so the composer says it.
 */
export function aiSelectionHint(
  state: AiModelSelectionState,
  errors: Record<CoachError, string>,
  t: (key: string) => string,
): string | null {
  const { chosen, models, modelsState, connection } = state;
  if (!chosen.connection) return t("Coach.Hint.ChooseConnection");
  if (modelsState.status === "failed" && modelsState.connection === connection)
    return errors[modelsState.error];
  return models && !chosen.model ? t("Coach.Hint.ChooseModel") : null;
}

function useEffortLabel() {
  const { t } = useTranslation();
  return (level: string) =>
    level === "low"
      ? t("Coach.Effort.Low")
      : level === "medium"
        ? t("Coach.Effort.Medium")
        : level === "high"
          ? t("Coach.Effort.High")
          : level;
}

/**
 * Connection, model and effort selectors. Settings → AI shows them as the place where the choice
 * is made; the Coach and the Assistant show them in the popover of their model button. Both write
 * the one persisted `coachSelectionAtom`.
 */
export function AiModelFields({
  state,
  errors,
  inPopover = false,
}: {
  state: AiModelSelectionState;
  errors: Record<CoachError, string>;
  /** Keeps the option lists inside the popover, so choosing an option does not close it. */
  inPopover?: boolean;
}) {
  const { t } = useTranslation();
  const effortLabel = useEffortLabel();
  const { connections, connection, modelsState, models, chosen, selection, setSelection } = state;
  const comboboxProps = inPopover ? { withinPortal: false } : undefined;

  const reportsEffort = (chosen.model?.effortLevels.length ?? 0) > 0;
  const effortOptions = [
    ...(reportsEffort ? [] : [{ value: PROVIDER_DEFAULT, label: t("Coach.Effort.Default") }]),
    ...(chosen.model ? coachEffortLevels(chosen.model) : COACH_EFFORT_LEVELS).map((level) => ({
      value: level,
      label: effortLabel(level),
    })),
  ];

  return (
    <Stack className={classes.fields} gap="xs">
      <Select
        size="xs"
        label={t("Coach.Connection")}
        placeholder={t("Coach.Connection")}
        comboboxProps={comboboxProps}
        data={connections.map((item) => ({ value: item.handle, label: item.label }))}
        value={connection}
        allowDeselect={false}
        disabled={connections.length === 0}
        onChange={(handle) => setSelection({ connection: handle, model: null, effort: null })}
      />
      <Select
        size="xs"
        searchable
        label={t("Coach.Model")}
        comboboxProps={comboboxProps}
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
        size="xs"
        label={t("Coach.Effort")}
        comboboxProps={comboboxProps}
        data={effortOptions}
        value={chosen.effort ?? (reportsEffort ? null : PROVIDER_DEFAULT)}
        allowDeselect={false}
        disabled={!chosen.model}
        onChange={(level) =>
          setSelection({ ...selection, effort: level === PROVIDER_DEFAULT ? null : level })
        }
      />
    </Stack>
  );
}

/**
 * The shared model selector button and its popover (connection, model, effort, and ChatGPT plan
 * notice). Used by the Coach, the Assistant, and the scoresheet photo import pane.
 */
export function AiModelButton({
  state,
  errors,
  position = "top-end",
  disabled = false,
}: {
  state: AiModelSelectionState;
  errors: Record<CoachError, string>;
  position?: "top-start" | "top-end";
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const effortLabel = useEffortLabel();
  const { chosen } = state;
  const shown = chosen.model
    ? [chosen.model.name, ...(chosen.effort ? [effortLabel(chosen.effort)] : [])].join(" · ")
    : t("Coach.ChooseModel");
  const full = [chosen.connection?.label, shown].filter(Boolean).join(" · ");

  return (
    <AppPopover position={position} shadow="md" withinPortal>
      <AppPopover.Target>
        <Button
          className={classes.modelButton}
          classNames={{ label: classes.modelLabel }}
          variant="subtle"
          color="gray"
          size="compact-sm"
          disabled={disabled}
          aria-label={t("Coach.ModelSettings", { model: full })}
          rightSection={<ChevronDown size="0.875rem" aria-hidden />}
        >
          <span className={classes.modelName}>{shown}</span>
        </Button>
      </AppPopover.Target>
      <AppPopover.Dropdown className={classes.modelPopover}>
        <AiModelFields state={state} errors={errors} inPopover />
        {chosen.connection?.kind === "chatGpt" && (
          <Group gap="xs" mt="xs">
            <Text size="xs" c="dimmed">
              {t("Coach.Plan.Using")}
            </Text>
            <Anchor component="button" type="button" size="xs" onClick={openCoachUsage}>
              {t("Coach.Plan.ManageUsage")}
            </Anchor>
          </Group>
        )}
      </AppPopover.Dropdown>
    </AppPopover>
  );
}

/**
 * The composer's model button and "New conversation". The button names the model that answers
 * (its accessible name adds the connection); it opens the selectors, with the ChatGPT plan notice
 * when that connection is used.
 */
export function AiModelControls({
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

  return (
    <>
      <AiModelButton state={state} errors={errors} />
      <IconAction
        label={t("Coach.NewConversation")}
        variant="subtle"
        color="gray"
        disabled={newConversationDisabled}
        onClick={onNewConversation}
      >
        <MessageSquarePlus size="1rem" />
      </IconAction>
    </>
  );
}
