import { Alert, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError, ConnectionSummary, ModelList } from "@/bindings";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { coachErrorCode } from "@/platform/coach";
import { tauri } from "@/platform/tauri";
import { coachConnectionsAtom, coachPlanNoticeSeenAtom, openCoachUsage } from "@/state/coach";
import AppModal from "../../common/AppModal";
import ConfirmModal, { durabilityUncertainMessage } from "../../common/ConfirmModal";
import { IconAction } from "../../common/IconAction";
import classes from "../SettingsPage.module.css";
import { CoachConnectionModal } from "./CoachConnectionModal";
import { useChatGptSignIn } from "./useChatGptSignIn";
import { useCoachErrorMessages } from "./useCoachErrorMessages";

type CheckResult = { models: ModelList } | { error: CoachError };

function ConnectionRow({
  connection,
  onEdit,
  onRemove,
}: {
  connection: ConnectionSummary;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const messages = useCoachErrorMessages();
  const { pending, run, isMounted } = useSingleFlight();
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const needsRepair = connection.status === "needsRepair";
  const signInAgain = connection.status === "signInAgain";
  const signedIn = connection.kind === "chatGpt";

  const check = () =>
    run(async () => {
      setChecked(null);
      let result: CheckResult;
      try {
        result = { models: await tauri.coachModels(connection.handle) };
      } catch (cause) {
        result = { error: coachErrorCode(cause) };
      }
      if (isMounted()) setChecked(result);
    });

  return (
    <Group
      justify="space-between"
      gap="md"
      className={classes.item}
      role="listitem"
      aria-label={connection.label}
    >
      <div className={classes.settingCopy}>
        <Group gap="xs">
          <Text className={classes.settingTitle}>{connection.label}</Text>
          {needsRepair && (
            <Badge color="danger">{t("Settings.Coach.Connection.NeedsRepair")}</Badge>
          )}
          {signInAgain && (
            <Badge color="warning">{t("Settings.Coach.Connection.SignInAgain")}</Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" className="wrap-anywhere">
          {needsRepair
            ? t("Coach.Error.NeedsRepair")
            : signInAgain
              ? t("Coach.Error.SignInAgain")
              : signedIn
                ? (connection.account ?? t("Coach.Plan.Using"))
                : connection.address}
        </Text>
        <div role="status" aria-live="polite">
          {checked && "models" in checked && (
            <Text size="xs">
              {checked.models.truncated
                ? t("Settings.Coach.Connection.ModelsTruncated", {
                    total: checked.models.models.length,
                  })
                : t("Settings.Coach.Connection.Models", { total: checked.models.models.length })}
            </Text>
          )}
          {checked && "error" in checked && (
            <Text size="xs" c="danger">
              {messages[checked.error]}
            </Text>
          )}
        </div>
      </div>
      <Group gap="xs" wrap="nowrap">
        {signedIn && !signInAgain && (
          <Button variant="subtle" size="xs" onClick={openCoachUsage}>
            {t("Coach.Plan.ManageUsage")}
          </Button>
        )}
        <Button
          variant="default"
          size="xs"
          disabled={needsRepair || signInAgain}
          loading={pending}
          onClick={() => void check()}
        >
          {t("Settings.Coach.Connection.Check")}
        </Button>
        {/* A sign-in has nothing to edit: it is renewed by signing in again. */}
        {!signedIn && (
          <IconAction label={t("Settings.Coach.Form.EditTitle")} variant="default" onClick={onEdit}>
            <Pencil size="1rem" />
          </IconAction>
        )}
        <IconAction
          label={t("Settings.Coach.Connection.Remove")}
          variant="default"
          onClick={onRemove}
        >
          <Trash2 size="1rem" />
        </IconAction>
      </Group>
    </Group>
  );
}

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; connection: ConnectionSummary }
  | { kind: "remove"; connection: ConnectionSummary };

/** The Coach's connections: what the native side holds, with add, edit, check and remove. */
export function CoachConnections() {
  const { t } = useTranslation();
  const messages = useCoachErrorMessages();
  const [state, reload] = useAtom(coachConnectionsAtom);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [durabilityUncertain, setDurabilityUncertain] = useState(false);
  /** The label of a removed sign-in whose provider did not confirm the sign-out. */
  const [unconfirmedSignOut, setUnconfirmedSignOut] = useState<string | null>(null);
  const [planNoticeSeen, setPlanNoticeSeen] = useAtom(coachPlanNoticeSeenAtom);
  const [planNotice, setPlanNotice] = useState(false);

  const settled = (uncertain: boolean) => {
    setDurabilityUncertain(uncertain);
    void reload();
  };
  const signIn = useChatGptSignIn((saved) => {
    settled(saved.durabilityUncertain);
    // The provider asks for this notice at the first sign-in, and only then.
    if (!planNoticeSeen) setPlanNotice(true);
  });
  const connections = state.status === "ready" ? state.connections : [];
  // One ChatGPT connection: the button stays for a first sign-in and for signing in again.
  const chatGptReady = connections.some(
    (connection) => connection.kind === "chatGpt" && connection.status === "ready",
  );

  return (
    <Stack gap={0} mb="lg">
      <Text className={classes.settingTitle}>{t("Settings.Coach.Connections")}</Text>
      <Text size="xs" c="dimmed">
        {t("Settings.Coach.Connections.Desc")}
      </Text>
      {state.status === "failed" && (
        <Alert color="danger" px="xs" mt="sm" role="alert">
          <Group justify="space-between" gap="sm">
            <Text size="sm">{messages[state.error]}</Text>
            <Button variant="default" size="xs" onClick={() => void reload()}>
              {t("Common.Retry")}
            </Button>
          </Group>
        </Alert>
      )}
      {state.status === "ready" && state.connections.length === 0 && (
        <Text size="sm" c="dimmed" className={classes.item}>
          {t("Settings.Coach.Connections.Empty")}
        </Text>
      )}
      {state.status === "ready" && state.connections.length > 0 && (
        <div role="list" aria-label={t("Settings.Coach.Connections")}>
          {state.connections.map((connection) => (
            <ConnectionRow
              key={connection.handle}
              connection={connection}
              onEdit={() => setDialog({ kind: "edit", connection })}
              onRemove={() => setDialog({ kind: "remove", connection })}
            />
          ))}
        </div>
      )}
      {durabilityUncertain && (
        <Alert color="warning" px="xs" mt="sm">
          {durabilityUncertainMessage(t)}
        </Alert>
      )}
      {unconfirmedSignOut !== null && (
        <Alert color="warning" px="xs" mt="sm" role="status">
          <Group justify="space-between" gap="sm">
            <Text size="sm">
              {t("Settings.Coach.Connection.RevocationPending", { label: unconfirmedSignOut })}
            </Text>
            <Button variant="default" size="xs" onClick={openCoachUsage}>
              {t("Coach.Plan.ManageUsage")}
            </Button>
          </Group>
        </Alert>
      )}
      {signIn.state.status === "waiting" && (
        <Alert px="xs" mt="sm" role="status">
          <Group justify="space-between" gap="sm">
            <Text size="sm">{t("Settings.Coach.SignIn.Waiting")}</Text>
            <Button variant="default" size="xs" onClick={signIn.cancel}>
              {t("Common.Cancel")}
            </Button>
          </Group>
        </Alert>
      )}
      {signIn.state.status === "failed" && (
        <Alert color="danger" px="xs" mt="sm" role="alert">
          {messages[signIn.state.error]}
        </Alert>
      )}
      <Group mt="md">
        {!chatGptReady && (
          <Button
            disabled={state.status !== "ready"}
            loading={signIn.state.status === "waiting"}
            onClick={() => void signIn.start()}
          >
            {t("Settings.Coach.SignIn.ChatGpt")}
          </Button>
        )}
        <Button
          variant="default"
          disabled={state.status !== "ready"}
          onClick={() => setDialog({ kind: "add" })}
        >
          {t("Settings.Coach.Connections.Add")}
        </Button>
      </Group>
      {planNotice && (
        <AppModal
          opened
          onClose={() => {
            setPlanNotice(false);
            setPlanNoticeSeen(true);
          }}
          title={t("Coach.Plan.Notice.Title")}
        >
          <Stack>
            <Text>{t("Coach.Plan.Notice.Body")}</Text>
            <Group justify="space-between">
              <Button variant="default" onClick={openCoachUsage}>
                {t("Coach.Plan.ManageUsage")}
              </Button>
              <Button
                onClick={() => {
                  setPlanNotice(false);
                  setPlanNoticeSeen(true);
                }}
              >
                {t("Coach.Plan.Notice.Accept")}
              </Button>
            </Group>
          </Stack>
        </AppModal>
      )}
      {(dialog?.kind === "add" || dialog?.kind === "edit") && (
        <CoachConnectionModal
          connection={dialog.kind === "edit" ? dialog.connection : null}
          onClose={() => setDialog(null)}
          onSaved={(saved) => settled(saved.durabilityUncertain)}
        />
      )}
      <ConfirmModal
        title={t("Settings.Coach.Connection.Remove")}
        description={
          dialog?.kind === "remove"
            ? t("Settings.Coach.Connection.RemoveConfirm", { label: dialog.connection.label })
            : ""
        }
        opened={dialog?.kind === "remove"}
        onClose={() => setDialog(null)}
        confirmLabel={t("Common.Remove")}
        onConfirm={async () => {
          if (dialog?.kind !== "remove") return;
          try {
            const removed = await tauri.coachRemoveConnection(dialog.connection.handle);
            setUnconfirmedSignOut(removed.revocationPending ? dialog.connection.label : null);
            settled(removed.durabilityUncertain);
          } catch (cause) {
            // The native list decides what is left, whatever the removal reported.
            void reload();
            throw cause;
          }
        }}
      />
    </Stack>
  );
}
