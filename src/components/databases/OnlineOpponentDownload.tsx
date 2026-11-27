import { Button, Group, Stack, Text } from "@mantine/core";
import { useAtomValue, useStore } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { opponentImportsAtom, opponentLinksAtom } from "@/state/atoms";
import AppModal from "../common/AppModal";
import { ImportProgress } from "./OpponentAccounts";
import { cancelOpponentImport } from "./opponentImport";
import {
  closeOnlineOpponentModal,
  onlineOpponentDownloadAtom,
  registerShownEntryModal,
} from "./onlineOpponent";

/**
 * Progress modal for an opponent download started or joined from the Library entry. Closing the
 * modal keeps the download running in the background.
 */
function OnlineOpponentDownload() {
  const { t } = useTranslation();
  const store = useStore();
  const linkId = useAtomValue(onlineOpponentDownloadAtom);
  const links = useAtomValue(opponentLinksAtom);
  const imports = useAtomValue(opponentImportsAtom);

  useEffect(() => {
    if (!linkId) return;
    return registerShownEntryModal(linkId);
  }, [linkId]);

  const link = linkId ? links.find((other) => other.id === linkId) : undefined;
  const ticket = linkId ? (imports.get(linkId) ?? null) : null;
  const downloading = t("Databases.Opponent.Downloading", {
    defaultValue: "Downloading online games",
  });

  function close() {
    if (linkId) closeOnlineOpponentModal(store, linkId);
  }

  return (
    <AppModal
      opened={linkId !== null}
      onClose={close}
      title={
        link
          ? t("Databases.Opponent.DownloadingTitle", {
              defaultValue: "Downloading {{name}}",
              name: link.playerName,
            })
          : downloading
      }
    >
      <Stack>
        <Text size="sm" className="wrap-anywhere">
          {t("Databases.Opponent.DownloadingBackground", {
            defaultValue:
              "Downloading online games. Closing this dialog keeps the download running.",
          })}
        </Text>
        {ticket !== null && <ImportProgress ticket={ticket} />}
        <Group justify="right">
          <Button variant="default" className="wrap-button" onClick={close}>
            {t("Databases.Opponent.CloseDownload", { defaultValue: "Close" })}
          </Button>
          <Button
            variant="default"
            className="wrap-button"
            disabled={ticket === null}
            onClick={() => {
              if (!linkId) return;
              void cancelOpponentImport(store, linkId).catch((error) =>
                notifyUnlessCancelled(
                  t("Common.Error", { defaultValue: "Error" }),
                  error,
                  "database",
                ),
              );
            }}
          >
            {t("Common.Cancel", { defaultValue: "Cancel" })}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export default OnlineOpponentDownload;
