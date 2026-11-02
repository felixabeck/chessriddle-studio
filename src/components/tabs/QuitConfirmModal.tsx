import { Button, Group, Stack, Text } from "@mantine/core";
import { useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { activeTabAtom } from "@/state/atoms";
import type { BlockingTab } from "@/state/quitGate";
import AppModal from "../common/AppModal";

function QuitConfirmModal({
  opened,
  failClosed,
  tabs,
  onCancel,
  onQuitWithoutSaving,
}: {
  opened: boolean;
  failClosed: boolean;
  tabs: BlockingTab[];
  onCancel: () => void;
  onQuitWithoutSaving: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveTab = useSetAtom(activeTabAtom);

  const cancel = () => {
    const first = tabs[0];
    onCancel();
    if (!failClosed && first) {
      void navigate({ to: "/" });
      setActiveTab(first.value);
    }
  };

  return (
    <AppModal withCloseButton={false} opened={opened} onClose={cancel}>
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
                  {tab.uninspectable ? t("Tab.QuitUninspectable", { name: tab.name }) : tab.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <Group justify="right">
          <Button variant="default" autoFocus onClick={cancel}>
            {t("Common.Cancel")}
          </Button>
          <Button color="danger" onClick={onQuitWithoutSaving}>
            {t("Tab.QuitWithoutSaving")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export default QuitConfirmModal;
