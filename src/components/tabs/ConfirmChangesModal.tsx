import { Button, Group, Stack, Text } from "@mantine/core";
import { useAtom, useSetAtom, useStore as useJotaiStore } from "jotai";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentTabAtom, tabsAtom, updateTabById } from "@/state/atoms";
import { normalizeError } from "@/platform/errors";
import type { TreeStore } from "@/state/store/tree";
import {
  isDraftGameOrigin,
  isRepertoireTab,
  sameTabOwner,
  saveToFile,
  type Tab,
  type UpdateTab,
} from "@/utils/tabs";
import { getFileFreshness, saveFileConflictVersion, useFileFreshness } from "@/state/fileFreshness";
import { TreeStateContext } from "../common/TreeStateContext";
import AppModal from "../common/AppModal";
import { GameNameFields } from "../boards/GameNameModal";
import { useTabCommands, type RetireIntent } from "./TabCommands";
import {
  applyGameNames,
  initialGameNames,
  withGameNames,
  type GameNames,
} from "../boards/gameNames";

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
  /** `intent` "newAnalysis": the tab is replaced by an empty analysis board instead of closing. */
  pendingClose?: { tabId: string; store: TreeStore; intent?: RetireIntent } | null;
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
  const { showTab } = useTabCommands();
  const [currentTab] = useAtom(currentTabAtom);
  const setTabs = useSetAtom(tabsAtom);
  const jotaiStore = useJotaiStore();
  const contextStore = useContext(TreeStateContext);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const targetTab = tab ?? currentTab;
  const targetStore = pendingClose?.store ?? contextStore;
  const modalOpen = pendingClose !== undefined ? pendingClose !== null : (opened ?? false);
  // The dialog keeps its wording while it fades out after pendingClose has been cleared.
  const [shownIntent, setShownIntent] = useState<RetireIntent | undefined>(undefined);
  if (pendingClose && pendingClose.intent !== shownIntent) setShownIntent(pendingClose.intent);
  const startsNewAnalysis = (pendingClose ? pendingClose.intent : shownIntent) === "newAnalysis";
  const freshness = useFileFreshness(targetTab?.value ?? "");
  // A new game is named before its first save here too, with the fields of the Save dialog.
  const naming = !!targetTab && isDraftGameOrigin(targetTab.gameOrigin) && !!targetStore;
  const [names, setNames] = useState<GameNames | null>(null);
  if (modalOpen && naming && names === null)
    setNames(initialGameNames(targetStore!.getState().headers));
  if (!modalOpen && names !== null) setNames(null);
  // Admission needs the workspace's committed tab and its callback, as BoardAnalysis passes them.
  const updateTabs: UpdateTab =
    updateTab ?? ((tabId, update, onAdmitted) => updateTabById(setTabs, tabId, update, onAdmitted));

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
        if (saved === "unregistered") {
          showTab(targetTab.value);
          if (pendingClose !== undefined) onCancel?.();
          else toggle?.();
          return;
        }
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
    if (naming && names)
      applyGameNames({
        store: targetStore,
        tab: targetTab,
        updateTab: updateTabs,
        next: withGameNames(targetStore.getState().headers, names),
      });
    const result = await saveToFile({
      updateTab: updateTabs,
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
        showTab(targetTab.value);
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
    <AppModal
      opened={modalOpen}
      onClose={cancel}
      pending={savePending}
      title={t("Tab.UnsavedChanges")}
    >
      <Stack>
        <div>
          <Text>
            {startsNewAnalysis
              ? t("Tab.UnsavedChangesConfirmNewAnalysis")
              : t("Tab.UnsavedChangesConfirm")}
          </Text>
          {saveMessage && <Text c="danger">{saveMessage}</Text>}
        </div>
        {naming && names && (
          <GameNameFields
            names={names}
            onChange={setNames}
            repertoire={isRepertoireTab(targetTab)}
          />
        )}

        <Group justify="right">
          <Button variant="default" onClick={discard} disabled={savePending}>
            {preserveChanges
              ? t("Common.Cancel")
              : startsNewAnalysis
                ? t("Tab.StartNewWithoutSaving")
                : t("Tab.CloseWithoutSaving")}
          </Button>
          <Button onClick={() => void save()} disabled={savePending}>
            {preserveChanges
              ? t("Tab.SaveAndAddGame")
              : startsNewAnalysis
                ? t("Tab.SaveAndStartNew")
                : t("Tab.SaveAndClose")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export default ConfirmChangesModal;
