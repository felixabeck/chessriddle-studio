import {
  Anchor,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { FeedbackOutcome, FeedbackType } from "@/bindings";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import { normalizeError } from "@/platform/errors";
import { tauri } from "@/platform/tauri";

const FEEDBACK_MIN_MESSAGE = 10;
const FEEDBACK_MAX_MESSAGE = 5000;
const FEEDBACK_MIN_EMAIL = 3;
const FEEDBACK_MAX_EMAIL = 254;
const PRIVACY_URL = "https://chessriddle.com/privacy";

function payloadFingerprint(type: FeedbackType, message: string, email: string): string {
  return JSON.stringify({
    type,
    message: message.trim(),
    email: email.trim() || null,
  });
}

function isPlausibleEmail(email: string): boolean {
  if (email.length < FEEDBACK_MIN_EMAIL || email.length > FEEDBACK_MAX_EMAIL || email.includes(" "))
    return false;
  const at = email.indexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

function outcomeMessage(
  outcome: Exclude<FeedbackOutcome, "sent">,
  t: (key: string) => string,
): string {
  switch (outcome) {
    case "inProgress":
      return t("Feedback.Error.InProgress");
    case "keyMismatch":
      return t("Feedback.Error.KeyMismatch");
    case "invalidInput":
      return t("Feedback.Error.InvalidInput");
    case "invalidImage":
      return t("Feedback.Error.InvalidImage");
    case "rateLimited":
      return t("Feedback.Error.RateLimited");
    case "deliveryFailed":
      return t("Feedback.Error.DeliveryFailed");
    case "serviceUnavailable":
      return t("Feedback.Error.ServiceUnavailable");
  }
}

function transportMessage(error: unknown, t: (key: string) => string): string {
  const normalized = normalizeError(error);
  if (normalized.category === "cancelled") return "";
  if (normalized.category === "validation") return t("Feedback.Error.InvalidInput");
  if (normalized.category === "network") return t("Feedback.Error.Network");
  return t("Feedback.Error.DeliveryFailed");
}

export default function FeedbackModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [feedbackType, setFeedbackType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef<string | null>(null);
  const lastPayloadRef = useRef<string | null>(null);
  const submitGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submitGeneration.current += 1;
    };
  }, []);

  const trimmedMessage = message.trim();
  const trimmedEmail = email.trim();
  const messageLength = [...trimmedMessage].length;
  const emailError =
    trimmedEmail.length > 0 && !isPlausibleEmail(trimmedEmail) ? t("Feedback.EmailInvalid") : "";
  const canSubmit =
    messageLength >= FEEDBACK_MIN_MESSAGE &&
    messageLength <= FEEDBACK_MAX_MESSAGE &&
    emailError === "";

  function resetForm() {
    keyRef.current = null;
    lastPayloadRef.current = null;
    setFeedbackType("bug");
    setMessage("");
    setEmail("");
    setPending(false);
    setError("");
  }

  function handleClose() {
    if (pending) return;
    resetForm();
    onClose();
  }

  function idempotencyKeyFor(fingerprint: string): string {
    if (lastPayloadRef.current !== fingerprint || keyRef.current === null) {
      keyRef.current = crypto.randomUUID();
      lastPayloadRef.current = fingerprint;
    }
    return keyRef.current;
  }

  async function submit() {
    if (pending || !canSubmit) return;
    const fingerprint = payloadFingerprint(feedbackType, message, email);
    const idempotencyKey = idempotencyKeyFor(fingerprint);
    const generation = ++submitGeneration.current;
    setPending(true);
    setError("");
    try {
      const outcome = await tauri.submitFeedback(
        feedbackType,
        trimmedMessage,
        trimmedEmail.length > 0 ? trimmedEmail : null,
        idempotencyKey,
        null,
      );
      if (!mounted.current || generation !== submitGeneration.current) return;
      if (outcome === "sent") {
        notifications.show({ color: "success", message: t("Feedback.Success") });
        resetForm();
        onClose();
        return;
      }
      if (outcome === "keyMismatch") {
        keyRef.current = null;
      }
      setError(outcomeMessage(outcome, t));
    } catch (cause) {
      if (!mounted.current || generation !== submitGeneration.current) return;
      const mapped = transportMessage(cause, t);
      if (mapped) setError(mapped);
    } finally {
      if (mounted.current && generation === submitGeneration.current) setPending(false);
    }
  }

  return (
    <AppModal opened={opened} onClose={handleClose} pending={pending} title={t("Feedback.Title")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack>
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Feedback.Type")}
            </Text>
            <SegmentedControl
              fullWidth
              value={feedbackType}
              onChange={(value) => setFeedbackType(value as FeedbackType)}
              data={[
                { value: "bug", label: t("Feedback.Type.Bug") },
                { value: "suggestion", label: t("Feedback.Type.Suggestion") },
                { value: "praise", label: t("Feedback.Type.Praise") },
                { value: "other", label: t("Feedback.Type.Other") },
              ]}
              disabled={pending}
            />
          </div>
          <Textarea
            label={t("Feedback.Message")}
            description={t("Feedback.MessageHint", {
              length: messageLength,
              max: FEEDBACK_MAX_MESSAGE,
              min: FEEDBACK_MIN_MESSAGE,
            })}
            autosize
            minRows={4}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            disabled={pending}
            data-autofocus
          />
          <TextInput
            label={t("Feedback.Email")}
            description={t("Feedback.EmailNote")}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            error={emailError || undefined}
            disabled={pending}
            autoComplete="email"
            inputMode="email"
          />
          <Text size="sm" c="dimmed">
            {t("Feedback.MetadataNote")}
          </Text>
          <Text size="sm">
            <Trans
              i18nKey="Feedback.Privacy"
              components={{
                privacy: <Anchor href={PRIVACY_URL} target="_blank" rel="noreferrer" />,
              }}
            />
          </Text>
          {error && (
            <Text c="danger" role="alert">
              {error}
            </Text>
          )}
          <Group justify="right">
            <Button type="submit" loading={pending} disabled={!canSubmit} styles={wrappingButton}>
              {t("Feedback.Submit")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
