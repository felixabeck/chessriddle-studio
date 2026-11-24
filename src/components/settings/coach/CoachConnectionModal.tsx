import { Alert, Button, Group, PasswordInput, Select, Stack, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError, ConnectionSaved, ConnectionSummary } from "@/bindings";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { coachErrorCode } from "@/platform/coach";
import { tauri } from "@/platform/tauri";
import AppModal from "../../common/AppModal";
import { COACH_PRESETS, coachPreset, type CoachPresetId } from "./presets";
import { useCoachErrorMessages } from "./useCoachErrorMessages";

/** The native bounds of a connection's fields (`connections.rs` and `address.rs` in the Coach). */
const MAX_LABEL_CHARS = 64;
const MAX_ADDRESS_CHARS = 512;
const MAX_KEY_CHARS = 512;

type Draft = { preset: CoachPresetId; label: string; address: string; key: string };

function initialDraft(connection: ConnectionSummary | null): Draft {
  if (connection) {
    // Only the address is stored; a connection still at a preset's address is that service.
    const matched = COACH_PRESETS.find(
      (entry) => entry.id !== "custom" && entry.address === connection.address,
    );
    return {
      preset: matched?.id ?? "custom",
      label: connection.label,
      address: connection.address ?? "",
      key: "",
    };
  }
  const preset = COACH_PRESETS[0];
  return { preset: preset.id, label: preset.name ?? "", address: preset.address, key: "" };
}

/**
 * Adds an API connection, or edits the one passed in. The key only ever travels to the native
 * side: an edit never receives the stored key back, it can only replace it.
 */
export function CoachConnectionModal({
  connection,
  onClose,
  onSaved,
}: {
  /** The connection to edit; `null` adds a new one. */
  connection: ConnectionSummary | null;
  onClose: () => void;
  onSaved: (saved: ConnectionSaved) => void;
}) {
  const { t } = useTranslation();
  const messages = useCoachErrorMessages();
  const { pending, run, isMounted } = useSingleFlight();
  const [draft, setDraft] = useState(() => initialDraft(connection));
  const [error, setError] = useState<CoachError | null>(null);
  const preset = coachPreset(draft.preset);

  const choosePreset = (id: string | null) => {
    const next = coachPreset(id);
    setDraft((current) => ({
      ...current,
      preset: next.id,
      label: next.name ?? "",
      address: next.address,
    }));
    setError(null);
  };

  const save = () =>
    run(async () => {
      setError(null);
      try {
        const saved = await tauri.coachSaveApiConnection({
          handle: connection?.handle,
          label: draft.label,
          address: draft.address,
          key: draft.key === "" ? undefined : draft.key,
        });
        if (!isMounted()) return;
        onSaved(saved);
        onClose();
      } catch (cause) {
        if (isMounted()) setError(coachErrorCode(cause));
      }
    });

  const keyDescription = connection?.hasKey
    ? t("Settings.Coach.Form.Key.Keep")
    : preset.local
      ? t("Settings.Coach.Form.Key.Optional")
      : draft.preset === "gemini"
        ? t("Settings.Coach.Form.Key.Gemini")
        : undefined;

  return (
    <AppModal
      opened
      onClose={onClose}
      pending={pending}
      title={connection ? t("Settings.Coach.Form.EditTitle") : t("Settings.Coach.Connections.Add")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {!connection && (
            <Select
              label={t("Settings.Coach.Form.Service")}
              data={COACH_PRESETS.map((entry) => ({
                value: entry.id,
                label: entry.name ?? t("Settings.Coach.Form.Service.Custom"),
              }))}
              value={draft.preset}
              onChange={choosePreset}
              allowDeselect={false}
              disabled={pending}
            />
          )}
          <TextInput
            label={t("Common.Name")}
            value={draft.label}
            maxLength={MAX_LABEL_CHARS}
            required
            disabled={pending}
            onChange={(event) => {
              const label = event.currentTarget.value;
              setDraft((current) => ({ ...current, label }));
            }}
          />
          <TextInput
            label={t("Settings.Coach.Form.Address")}
            description={
              draft.preset === "qwen"
                ? t("Settings.Coach.Form.Address.Workspace")
                : draft.preset === "custom"
                  ? t("Settings.Coach.Form.Address.Desc")
                  : t("Settings.Coach.Form.Address.Preset")
            }
            value={draft.address}
            maxLength={MAX_ADDRESS_CHARS}
            required
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={pending}
            onChange={(event) => {
              const address = event.currentTarget.value;
              setDraft((current) => ({ ...current, address }));
            }}
          />
          <PasswordInput
            label={t("Settings.Coach.Form.Key")}
            description={keyDescription}
            value={draft.key}
            maxLength={MAX_KEY_CHARS}
            autoComplete="off"
            visibilityToggleButtonProps={{ "aria-label": t("Settings.Coach.Form.Key.Show") }}
            disabled={pending}
            onChange={(event) => {
              const key = event.currentTarget.value;
              setDraft((current) => ({ ...current, key }));
            }}
          />
          {error && (
            <Alert color="danger" px="xs" role="alert">
              {messages[error]}
            </Alert>
          )}
          <Group justify="right">
            <Button variant="default" disabled={pending} onClick={onClose}>
              {t("Common.Cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {t("Common.Save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
