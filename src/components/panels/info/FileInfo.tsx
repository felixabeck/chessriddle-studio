import { useOwnerTab } from "@/state/tabScope";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { Divider, Group, Text, Tooltip } from "@mantine/core";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import { formatNumber } from "@/utils/format";
import { getTabFile } from "@/utils/tabs";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { tauri } from "@/platform/tauri";
import type { GameSelectorRow } from "./GameSelector";

function FileInfo({
  setGames,
}: {
  setGames: React.Dispatch<React.SetStateAction<Map<number, GameSelectorRow>>>;
}) {
  const { t } = useTranslation();
  const [tab, setCurrentTab] = useOwnerTab();
  const tabFile = getTabFile(tab);
  const tabId = tab?.value;
  const fileKey = tabFile ? fileWorkspaceKey(tabFile.handle) : null;
  const identity = `${tabId}:${fileKey}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const tabAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      tabAbortRef.current?.abort();
      tabAbortRef.current = null;
    };
  }, [tabId, fileKey]);

  if (!tab || !tabFile) return null;
  const activeTab = tab;
  const activeFile = tabFile;
  const activeIdentity = identity;
  const activeFileKey = fileKey;

  async function reload() {
    tabAbortRef.current?.abort();
    const controller = new AbortController();
    tabAbortRef.current = controller;
    const currentTabId = activeTab.value;
    const handle = activeFile.handle;
    try {
      const numGames = await tauri.countPgnGames(handle, { signal: controller.signal });
      if (controller.signal.aborted || identityRef.current !== activeIdentity) return;
      let matched = false;
      const saved = setCurrentTab((prev) => {
        if (prev.value !== currentTabId) return prev;
        if (prev.gameOrigin.kind !== "file" && prev.gameOrigin.kind !== "temp_file") {
          return prev;
        }
        if (fileWorkspaceKey(prev.gameOrigin.file.handle) !== activeFileKey) return prev;
        matched = true;
        return {
          ...prev,
          gameOrigin: {
            ...prev.gameOrigin,
            file: {
              ...prev.gameOrigin.file,
              numGames,
            },
          },
        };
      });
      if (saved && matched) setGames(new Map());
    } catch (cause) {
      if (identityRef.current !== activeIdentity || controller.signal.aborted) return;
      notifyUnlessCancelled(t("Common.Error"), cause);
    }
  }

  return (
    <>
      <Group justify="space-between" py="sm" px="md">
        <Text>
          {t("Files.GameCountSuffix", {
            count: tabFile.numGames ?? 0,
            number: formatNumber(tabFile.numGames ?? 0),
          })}
        </Text>
        <Group wrap="nowrap" miw={0}>
          <Tooltip label={tabFile.name}>
            <Text size="sm" c="dimmed" truncate>
              {tabFile.name}
            </Text>
          </Tooltip>

          <IconAction
            label={t("Files.Reload")}
            variant="outline"
            size="sm"
            onClick={() => void reload()}
          >
            <RotateCcw size="1rem" />
          </IconAction>
        </Group>
      </Group>
      <Divider />
    </>
  );
}

export default FileInfo;
