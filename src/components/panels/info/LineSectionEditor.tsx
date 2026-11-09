import { Button, Menu, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import AppModal from "@/components/common/AppModal";
import { LINE_SECTION_MAX_LENGTH, withLineSection } from "@/components/files/lineSection";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryButtonProps } from "@/components/library/presentation";
import { normalizeError } from "@/platform/errors";
import { tabsAtom } from "@/state/atoms";
import { scanBlockingTabs } from "@/state/quitGate";
import { readFileGame, writeFileGame } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { isFileBackedTab } from "@/utils/tabs";

export type LineSectionTarget = {
  index: number;
  section: string | undefined;
  stamp: string;
  x: number;
  y: number;
};

type Mode = "menu" | "name" | "removing";

export default function LineSectionEditor({
  file,
  target,
  onClose,
  onSaved,
  onStale,
}: {
  file: FileWorkspaceHandle;
  target: LineSectionTarget;
  onClose: () => void;
  onSaved: (index: number, section: string | undefined, written: WriteStamp) => void;
  onStale: () => void;
}) {
  const { t } = useTranslation();
  const tabs = useAtomValue(tabsAtom);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(target.section ?? "");
  const [pending, setPending] = useState(false);

  async function save(section: string | null) {
    const fileKey = fileWorkspaceKey(file);
    const lineTabs = tabs.filter(
      (tab) =>
        isFileBackedTab(tab) &&
        tab.gameOrigin.gameNumber === target.index &&
        fileWorkspaceKey(tab.gameOrigin.file.handle) === fileKey,
    );
    if (scanBlockingTabs(lineTabs).length > 0) {
      notifications.show({
        color: "danger",
        title: t("Common.Error"),
        message: t("Files.LineSection.UnsavedTab", {
          defaultValue:
            "This game has unsaved changes in an open tab. Save or close that tab first.",
        }),
      });
      onClose();
      return;
    }

    setPending(true);
    try {
      const game = await readFileGame(file, target.index);
      if (!game.present || game.omission || game.stamp !== target.stamp) {
        showStale();
        return;
      }
      const written = await writeFileGame(file, target.index, withLineSection(game.pgn, section), {
        kind: "game",
        stamp: game.stamp,
      });
      onSaved(target.index, section ?? undefined, written);
    } catch (error) {
      if (normalizeError(error).backendCategory === "stale-game") showStale();
      else notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      setPending(false);
      onClose();
    }
  }

  function showStale() {
    notifications.show({
      color: "danger",
      title: t("Common.Error"),
      message: t("Files.LineSection.Stale", {
        defaultValue:
          "The file changed, so the section was not saved. Check the list and try again.",
      }),
    });
    onStale();
  }

  if (mode === "menu") {
    return (
      <Menu
        opened
        onChange={(opened) => {
          if (!opened) onClose();
        }}
        shadow="md"
        width={200}
        position="bottom-start"
        offset={0}
        floatingStrategy="fixed"
        hideDetached={false}
        returnFocus={false}
        closeOnItemClick={false}
      >
        <Menu.Target>
          <span
            aria-hidden
            style={{
              position: "fixed",
              left: target.x,
              top: target.y,
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          {target.section === undefined ? (
            <Menu.Item onClick={() => setMode("name")}>
              {t("Files.LineSection.Start", { defaultValue: "Start section here" })}
            </Menu.Item>
          ) : (
            <>
              <Menu.Item onClick={() => setMode("name")}>
                {t("Files.LineSection.Rename", { defaultValue: "Rename section" })}
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  setMode("removing");
                  void save(null);
                }}
              >
                {t("Files.LineSection.Remove", { defaultValue: "Remove section" })}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    );
  }
  if (mode === "removing") return null;

  return (
    <AppModal
      opened
      pending={pending}
      onClose={onClose}
      title={t("Files.LineSection.Title", { defaultValue: "Section" })}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(name);
        }}
      >
        <Stack miw={0}>
          <TextInput
            miw={0}
            autoFocus
            data-autofocus
            label={t("Common.Name", { defaultValue: "Name" })}
            description={t("Files.LineSection.NameHint", {
              defaultValue: "Leave empty for a gap without a heading.",
            })}
            maxLength={LINE_SECTION_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button miw={0} {...libraryButtonProps} type="submit" disabled={pending}>
            {t("Common.Save", { defaultValue: "Save" })}
          </Button>
        </Stack>
      </form>
    </AppModal>
  );
}
