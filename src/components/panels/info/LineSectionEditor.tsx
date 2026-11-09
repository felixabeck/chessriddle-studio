import { Button, Menu, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import AppModal from "@/components/common/AppModal";
import PointerContextMenu from "@/components/common/PointerContextMenu";
import { LINE_SECTION_MAX_LENGTH, normalizeLineSection } from "@/components/files/lineSection";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryButtonProps } from "@/components/library/presentation";
import { normalizeError } from "@/platform/errors";
import { tabsAtom } from "@/state/atoms";
import { scanBlockingTabs } from "@/state/quitGate";
import { readFileGame, setFileGameSection } from "@/utils/files";
import { isTabOfFileGame } from "@/utils/tabs";

export type LineSectionTarget = {
  index: number;
  section: string | undefined;
  stamp: string;
  revision: string;
  x: number;
  y: number;
  /** Starts at the name dialog, for a gesture that already chose what to do. */
  nameFirst: boolean;
};

type Mode = "menu" | "name" | "removing";

export default function LineSectionEditor({
  file,
  target,
  onClose,
  onSaved,
  onRefresh,
}: {
  file: FileWorkspaceHandle;
  target: LineSectionTarget;
  onClose: () => void;
  onSaved: (index: number, section: string | undefined, written: WriteStamp) => void;
  /** The list no longer matches the file. */
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const tabs = useAtomValue(tabsAtom);
  const [mode, setMode] = useState<Mode>(target.nameFirst ? "name" : "menu");
  const [name, setName] = useState(target.section ?? "");
  const [pending, setPending] = useState(false);

  async function save(section: string | null) {
    const lineTabs = tabs.filter((tab) => isTabOfFileGame(tab, file, target.index));
    if (scanBlockingTabs(lineTabs).length > 0) {
      notifications.show({
        color: "danger",
        title: t("Common.Error"),
        message: t("Files.LineSection.UnsavedTab", {
          defaultValue: "Save or close this game's open tab first.",
        }),
      });
      onClose();
      return;
    }

    setPending(true);
    try {
      const game = await readFileGame(file, target.index);
      if (!game.present || game.omission) {
        showStale();
        return;
      }
      // Identical lines share a stamp, so the write also pins the revision the list was read at.
      const written = await setFileGameSection(
        file,
        target.index,
        section,
        target.stamp,
        target.revision,
      );
      onSaved(target.index, section === null ? undefined : normalizeLineSection(section), written);
    } catch (error) {
      const details = normalizeError(error);
      if (details.backendCategory === "stale-game") {
        showStale();
      } else {
        if (details.category === "applied-despite-error") onRefresh();
        notifyUnlessCancelled(t("Common.Error"), error);
      }
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
        defaultValue: "The file changed. Check the list and try again.",
      }),
    });
    onRefresh();
  }

  if (mode === "menu") {
    return (
      <PointerContextMenu point={target} onClose={onClose} closeOnItemClick={false}>
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
      </PointerContextMenu>
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
              defaultValue: "Leave empty for a gap.",
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
