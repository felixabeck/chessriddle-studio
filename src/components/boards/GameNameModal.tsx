import { Button, Group, Stack, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import { lineTitleOf } from "@/utils/lineTitle";
import type { GameHeaders } from "@/utils/treeReducer";

function shown(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "?" ? "" : trimmed;
}

/** The names a game is filed under: a repertoire line's name and idea, or a game's players and
 * event. Asked before a new game's first save and when a line title is clicked. */
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
  const [white, setWhite] = useState(() =>
    repertoire ? (lineTitleOf(headers).name ?? "") : shown(headers.white),
  );
  const [black, setBlack] = useState(() => shown(headers.black));
  const [event, setEvent] = useState(() => shown(headers.event));

  const submit = () => {
    const next = { ...headers, white: white.trim(), black: black.trim() };
    onConfirm(repertoire ? next : { ...next, event: event.trim() });
  };

  return (
    <AppModal opened={opened} onClose={onClose} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          {repertoire ? (
            <>
              <TextInput
                data-autofocus
                label={t("GameInfo.LineName")}
                placeholder={t("GameInfo.EnterLineName")}
                value={white}
                onChange={(e) => setWhite(e.currentTarget.value)}
              />
              <TextInput
                label={t("GameInfo.Idea")}
                placeholder={t("GameInfo.EnterIdea")}
                value={black}
                onChange={(e) => setBlack(e.currentTarget.value)}
              />
            </>
          ) : (
            <>
              <TextInput
                data-autofocus
                label={t("Fen.White")}
                value={white}
                onChange={(e) => setWhite(e.currentTarget.value)}
              />
              <TextInput
                label={t("Fen.Black")}
                value={black}
                onChange={(e) => setBlack(e.currentTarget.value)}
              />
              <TextInput
                label={t("Databases.Game.Event")}
                value={event}
                onChange={(e) => setEvent(e.currentTarget.value)}
              />
            </>
          )}
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
