import { Button, Group, Stack, Text } from "@mantine/core";
import { useAtom, useSetAtom, useStore as useJotaiStore } from "jotai";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { activeTabAtom, currentTabAtom, tabsAtom, updateTabById } from "@/state/atoms";
import { normalizeError } from "@/platform/errors";
import type { TreeStore } from "@/state/store/tree";
import { sameTabOwner, saveToFile, type Tab, type UpdateTab } from "@/utils/tabs";
import { getFileFreshness, saveFileConflictVersion, useFileFreshness } from "@/state/fileFreshness";
import { TreeStateContext } from "../common/TreeStateContext";
import AppModal from "../common/AppModal";

function ConfirmChangesModal({
  pendingClose,
  tab,
  updateTab,
  onCancel,
  onDiscard,
  onSaved,
  opened,
  toggle,
  closeTab,
  preserveChanges = false,
}: {
  pendingClose?: { tabId: string; store: TreeStore } | null;
  tab?: Tab;
  updateTab?: UpdateTab;
  onCancel?: () => void;
  onDiscard?: () => void;
  onSaved?: () => void;
  /** Compatibility for save-before-navigation flows; tab close uses pendingClose. */
  opened?: boolean;
  toggle?: () => void;
  closeTab?: () => void;
  /** Continue the current operation after saving, without closing or replacing the tab. */
  preserveChanges?: boolean;
}) {
  const { t } = useTranslation();
  const [currentTab] = useAtom(currentTabAtom);
  const [, setActiveTab] = useAtom(activeTabAtom);
  const setTabs = useSetAtom(tabsAtom);
  const jotaiStore = useJotaiStore();
  const contextStore = useContext(TreeStateContext);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const targetTab = tab ?? currentTab;
  const targetStore = pendingClose?.store ?? contextStore;
  const modalOpen = pendingClose !== undefined ? pendingClose !== null : (opened ?? false);
  const freshness = useFileFreshness(targetTab?.value ?? "");

  const cancel = () => {
    if (pendingClose !== undefined) onCancel?.();
    else toggle?.();
  };

  const discard = () => {
    if (preserveChanges) {
      cancel();
      return;
    }
    if (pendingClose !== undefined) onDiscard?.();
    else {
      closeTab?.();
      toggle?.();
    }
  };

  async function save() {
    if (!targetTab || !targetStore) return;
    if (savePending) return;
    setSavePending(true);
    setSaveMessage(null);
    if (freshness.state === "unavailable") {
      try {
        const saved = await saveFileConflictVersion(targetTab.value);
        const current = jotaiStore
          .get(tabsAtom)
          .find((candidate) => candidate.value === targetTab.value);
        const currentOwner = sameTabOwner(current, targetTab);
        const dirty = targetStore.getState().dirty;
        if (saved && currentOwner && !dirty) {
          if (pendingClose !== undefined) onSaved?.();
          else {
            closeTab?.();
            toggle?.();
          }
        } else {
          setSaveMessage(
            t(
              currentOwner && dirty && getFileFreshness(targetTab.value).state === "verified"
                ? "Tab.SaveSuperseded"
                : "FileFreshness.SaveAsNewGameFailed",
            ),
          );
        }
      } catch (error) {
        setSaveMessage(normalizeError(error).message);
      } finally {
        setSavePending(false);
      }
      return;
    }
    const result = await saveToFile({
      updateTab:
        updateTab ??
        ((tabId, update, onAdmitted) => updateTabById(setTabs, tabId, update, onAdmitted)),
      getTab: (tabId) => jotaiStore.get(tabsAtom).find((candidate) => candidate.value === tabId),
      tab: targetTab,
      store: targetStore,
      isUserSave: true,
    });
    if (result === "saved") {
      setSavePending(false);
      if (preserveChanges) {
        onSaved?.();
        toggle?.();
      } else if (pendingClose !== undefined) onSaved?.();
      else {
        closeTab?.();
        toggle?.();
      }
      return;
    }
    if (result === "conflict") {
      setSavePending(false);
      if (pendingClose !== undefined) {
        setActiveTab(targetTab.value);
        onCancel?.();
      } else {
        toggle?.();
      }
      return;
    }
    if (result === "superseded") {
      setSaveMessage(t("Tab.SaveSuperseded"));
      setSavePending(false);
      return;
    }
    if (typeof result === "object" && result.status === "failed") {
      setSaveMessage(result.error.message);
    }
    setSavePending(false);
  }

  return (
    <AppModal withCloseButton={false} opened={modalOpen} onClose={cancel} pending={savePending}>
      <Stack>
        <div>
          <Text fz="lg" fw="bold" mb={10}>
            {t("Tab.UnsavedChanges")}
          </Text>
          <Text>{t("Tab.UnsavedChangesConfirm")}</Text>
          {saveMessage && <Text c="danger">{saveMessage}</Text>}
        </div>

        <Group justify="right">
          <Button variant="default" onClick={discard} disabled={savePending}>
            {preserveChanges ? t("Common.Cancel") : t("Tab.CloseWithoutSaving")}
          </Button>
          <Button onClick={() => void save()} disabled={savePending}>
            {preserveChanges ? t("Tab.SaveAndAddGame") : t("Tab.SaveAndClose")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export default ConfirmChangesModal;
