import { Button, Group } from "@mantine/core";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { tabStorage } from "@/state/store/tabStorage";
import { discardTreeStoreStorage, retryTreeStoreStorage } from "@/state/store/tree";
import { writeClipboardText } from "@/utils/clipboard";
import classes from "./TreeRecoveryGate.module.css";

type Props = {
  tabId: string;
  treeKey?: string;
  children: React.ReactNode;
};

export default function TreeRecoveryGate({ tabId, treeKey = tabId, children }: Props) {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (listener: () => void) => tabStorage.subscribeStatus(treeKey, listener),
    [treeKey],
  );
  const getSnapshot = useCallback(() => tabStorage.getStatus(treeKey), [treeKey]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [pending, setPending] = useState<"copy" | "discard" | "retry" | null>(null);
  const [actionError, setActionError] = useState<"copy" | "discard" | "retry" | null>(null);
  const [copied, setCopied] = useState(false);

  const runAction = async (action: NonNullable<typeof pending>) => {
    setPending(action);
    setActionError(null);
    try {
      if (action === "copy") {
        setCopied(false);
        const rawValue = tabStorage.readRawValueForRecovery(treeKey);
        await writeClipboardText(rawValue);
        setCopied(true);
      } else if (action === "discard") {
        if (!discardTreeStoreStorage(tabId, treeKey))
          throw new Error("The saved value was not discarded.");
        setCopied(false);
      } else {
        const recovered = await retryTreeStoreStorage(tabId);
        if (!recovered || recovered.kind === "not-read" || recovered.kind === "unavailable") {
          setActionError("retry");
        }
      }
    } catch {
      setActionError(action);
    } finally {
      setPending(null);
    }
  };

  if ((status.kind === "available" || status.kind === "absent") && pending !== "retry")
    return <>{children}</>;

  const unreadable = status.kind === "unreadable";
  const errorMessage =
    actionError === "copy"
      ? t("TreeRecovery.CopyFailed")
      : actionError === "discard"
        ? t("TreeRecovery.DiscardFailed")
        : actionError === "retry"
          ? t("TreeRecovery.RetryFailed")
          : null;

  return (
    <section
      className={classes.panel}
      data-tree-recovery={unreadable ? "unreadable" : "unavailable"}
      aria-labelledby="tree-recovery-title"
      aria-live="polite"
      role="alert"
    >
      <h2 id="tree-recovery-title">
        {unreadable ? t("TreeRecovery.UnreadableTitle") : t("TreeRecovery.UnavailableTitle")}
      </h2>
      <p>
        {unreadable ? t("TreeRecovery.UnreadableMessage") : t("TreeRecovery.UnavailableMessage")}
      </p>
      {errorMessage && <p className={classes.error}>{errorMessage}</p>}
      {copied && <p>{t("TreeRecovery.Copied")}</p>}
      <Group justify="center" gap="sm">
        {unreadable ? (
          <>
            <Button
              variant="default"
              onClick={() => void runAction("copy")}
              disabled={pending !== null}
            >
              {t("TreeRecovery.CopyValue")}
            </Button>
            <Button
              className={classes.discardButton}
              variant="default"
              onClick={() => void runAction("discard")}
              disabled={pending !== null}
            >
              {t("TreeRecovery.DiscardValue")}
            </Button>
          </>
        ) : (
          <Button onClick={() => void runAction("retry")} disabled={pending !== null}>
            {pending === "retry" ? t("TreeRecovery.Retrying") : t("TreeRecovery.Retry")}
          </Button>
        )}
      </Group>
    </section>
  );
}
