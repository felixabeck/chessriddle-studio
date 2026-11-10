import { Button, Group, Stack, Text } from "@mantine/core";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeError } from "@/platform/errors";
import AppModal from "./AppModal";

export function durabilityUncertainMessage(
  t: (key: string, options?: { defaultValue: string }) => string,
) {
  return t("Common.DurabilityUncertain", {
    defaultValue: "The change was saved, but the save could not be fully confirmed. Do not retry.",
  });
}

export function confirmationErrorMessage(
  cause: unknown,
  t: (key: string, options?: { defaultValue: string }) => string,
) {
  const { category, backendCategory, nameTaken } = normalizeError(cause);
  if (backendCategory === "durability") return durabilityUncertainMessage(t);
  if (category === "applied-despite-error") {
    return t("Common.ConfirmationError.applied-despite-error", {
      defaultValue: "Part of the operation was completed, and what is shown may no longer match.",
    });
  }
  if (nameTaken === true) return t("Common.NameAlreadyUsed");
  return t("Common.ConfirmationError.unexpected", {
    defaultValue: "The action could not be completed. Please try again.",
  });
}

function ConfirmModal({
  title,
  description,
  opened,
  onClose,
  onConfirm,
  confirmLabel,
}: {
  title: string;
  description: string;
  opened: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  confirmLabel?: string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const confirmInFlight = useRef(false);
  async function confirm() {
    if (confirmInFlight.current) return;
    confirmInFlight.current = true;
    setPending(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(confirmationErrorMessage(cause, t));
    } finally {
      confirmInFlight.current = false;
      setPending(false);
    }
  }

  return (
    <AppModal
      withCloseButton={false}
      opened={opened}
      onClose={onClose}
      title={title}
      pending={pending}
    >
      <Stack>
        <div>
          <Text>{description}</Text>
          <Text>{t("Common.CannotUndo")}</Text>
          {error && (
            <Text c="danger" role="alert">
              {error}
            </Text>
          )}
        </div>

        <Group justify="right">
          <Button variant="default" disabled={pending} onClick={() => onClose()}>
            {t("Common.Cancel")}
          </Button>
          <Button color="danger" loading={pending} onClick={confirm}>
            {confirmLabel || t("Common.Delete")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export default ConfirmModal;
