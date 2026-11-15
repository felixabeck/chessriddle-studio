import { Button, Group, Stack, Text } from "@mantine/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeError } from "@/platform/errors";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { BlockingTab, QuitSaveOutcome } from "@/state/quitGate";
import { tabLabelWithFile } from "@/utils/tabs";
import AppModal from "../common/AppModal";

function QuitConfirmModal({
  opened,
  failClosed,
  tabs,
  onCancel,
  onQuitWithoutSaving,
  onSaveAndQuit,
}: {
  opened: boolean;
  failClosed: boolean;
  tabs: BlockingTab[];
  onCancel: () => void;
  onQuitWithoutSaving: () => void;
  /** Omitted where the host cannot save; the dialog then offers only cancel and discard. */
  onSaveAndQuit?: () => Promise<QuitSaveOutcome>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveTab = useSetAtom(activeTabAtom);
  const workspaceTabs = useAtomValue(tabsAtom);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);

  const label = (tab: BlockingTab) =>
    tabLabelWithFile(
      workspaceTabs.find((candidate) => candidate.value === tab.value),
      t(tab.name, { defaultValue: tab.name }),
    );
  // An unreadable tab has nothing to save; an emptied list means every save already landed.
  const canSave =
    !!onSaveAndQuit && !failClosed && (tabs.length === 0 || tabs.some((tab) => !tab.uninspectable));

  const cancel = () => {
    const first = tabs[0];
    setSaveMessage(null);
    onCancel();
    if (!failClosed && first) {
      void navigate({ to: "/" });
      setActiveTab(first.value);
    }
  };

  async function saveAndQuit() {
    if (!onSaveAndQuit || savePending) return;
    setSavePending(true);
    setSaveMessage(null);
    try {
      const outcome = await onSaveAndQuit();
      if (outcome.kind !== "blocked") return;
      const name = label(outcome.tab);
      if (outcome.reason === "attention") setSaveMessage(t("Tab.QuitSaveNeedsAttention", { name }));
      else
        setSaveMessage(
          t("Tab.QuitSaveFailed", {
            name,
            message: outcome.reason === "superseded" ? t("Tab.SaveSuperseded") : outcome.message,
          }),
        );
    } catch (error) {
      setSaveMessage(normalizeError(error).message);
    } finally {
      setSavePending(false);
    }
  }

  return (
    <AppModal withCloseButton={false} opened={opened} onClose={cancel} pending={savePending}>
      <Stack>
        <div>
          <Text fz="lg" fw="bold" mb={10}>
            {t("Tab.UnsavedChanges")}
          </Text>
          <Text>
            {t(failClosed ? "Tab.UnsavedChangesQuitFailClosed" : "Tab.UnsavedChangesQuit")}
          </Text>
          {!failClosed && (
            <ul>
              {tabs.map((tab) => (
                <li key={tab.value}>
                  {tab.uninspectable
                    ? t("Tab.QuitUninspectable", { name: label(tab) })
                    : label(tab)}
                </li>
              ))}
            </ul>
          )}
          {saveMessage && <Text c="danger">{saveMessage}</Text>}
        </div>

        <Group justify="right">
          <Button variant="default" autoFocus onClick={cancel} disabled={savePending}>
            {t("Common.Cancel")}
          </Button>
          <Button
            variant={canSave ? "outline" : "filled"}
            color="danger"
            onClick={onQuitWithoutSaving}
            disabled={savePending}
          >
            {t("Tab.QuitWithoutSaving")}
          </Button>
          {canSave && (
            <Button onClick={() => void saveAndQuit()} loading={savePending}>
              {t("Tab.SaveAndQuit")}
            </Button>
          )}
        </Group>
      </Stack>
    </AppModal>
  );
}

export default QuitConfirmModal;
