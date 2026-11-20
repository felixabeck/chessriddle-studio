import { Button, Group, Stack, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import type { GameHeaders } from "@/utils/treeReducer";
import { initialGameNames, withGameNames, type GameNames } from "./gameNames";

/** A repertoire line's name and idea, or a game's players and event. The first field takes
 * the focus when its dialog opens. */
export function GameNameFields({
  names,
  onChange,
  repertoire,
}: {
  names: GameNames;
  onChange: (names: GameNames) => void;
  repertoire: boolean;
}) {
  const { t } = useTranslation();
  const field = (key: "white" | "black" | "event") => ({
    value: names[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...names, [key]: e.currentTarget.value }),
  });
  return repertoire ? (
    <>
      <TextInput
        data-autofocus
        label={t("GameInfo.LineName")}
        placeholder={t("GameInfo.EnterLineName")}
        {...field(names.lineNameKey)}
      />
      <TextInput
        label={t("GameInfo.Idea")}
        placeholder={t("GameInfo.EnterIdea")}
        {...field("black")}
      />
    </>
  ) : (
    <>
      <TextInput data-autofocus label={t("Fen.White")} {...field("white")} />
      <TextInput label={t("Fen.Black")} {...field("black")} />
      <TextInput label={t("Databases.Game.Event")} {...field("event")} />
    </>
  );
}

/** Asks for a game's names before its first save, and renames a line from its title. */
export default function GameNameModal({
  opened,
  onClose,
  headers,
  repertoire,
  title,
  confirmLabel,
  onConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  headers: GameHeaders;
  repertoire: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: (headers: GameHeaders) => void;
}) {
  const { t } = useTranslation();
  // Mounted per opening, so the fields start from the headers at that moment.
  const [names, setNames] = useState(() => initialGameNames(headers));

  return (
    <AppModal opened={opened} onClose={onClose} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(withGameNames(headers, names));
        }}
      >
        <Stack>
          <GameNameFields names={names} onChange={setNames} repertoire={repertoire} />
          <Group justify="end">
            <Button styles={wrappingButton} variant="default" onClick={onClose}>
              {t("Common.Cancel")}
            </Button>
            <Button styles={wrappingButton} type="submit">
              {confirmLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
