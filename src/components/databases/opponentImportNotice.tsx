import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { opponentProviderName } from "@/state/opponentLinks";
import type { OpponentImportResult } from "./opponentImport";

export function reportOpponentLeftover(t: TFunction): void {
  notifications.show({
    color: "warning",
    message: t("Databases.Opponent.LeftOver", {
      defaultValue:
        "An older copy of the online games could not be deleted. You can delete it in the Library.",
    }),
  });
}

function announce(t: TFunction, result: OpponentImportResult): void {
  if (result.kind === "cancelled") return;
  if (result.kind === "failed") {
    notifyUnlessCancelled(t("Common.Error"), result.error, "database");
    return;
  }
  if (result.kind === "imported") {
    notifications.show({
      color: "success",
      message: t("Databases.Opponent.Downloaded", {
        defaultValue: "Downloaded {{count}} online games.",
        count: result.games,
      }),
    });
    return;
  }
  if (result.kind === "noGames") {
    notifications.show({
      color: "warning",
      message: t("Databases.Opponent.NoMatch", {
        defaultValue: "No game matches the period and time controls.",
      }),
    });
    return;
  }
  const site = opponentProviderName(result.account.provider);
  const { username } = result.account;
  notifications.show({
    color: "danger",
    title: t("Common.Error"),
    message:
      result.reason === "notFound"
        ? t("Databases.Opponent.Failure.NotFound", {
            defaultValue: "{{site}} has no account named {{username}}.",
            site,
            username,
          })
        : result.reason === "rateLimited"
          ? t("Databases.Opponent.Failure.RateLimited", {
              defaultValue: "{{site}} is limiting requests. Try again in a minute.",
              site,
            })
          : result.reason === "signIn"
            ? t("Databases.Opponent.Failure.SignIn", {
                defaultValue: "Lichess rejected your sign-in. Sign in again on the Accounts page.",
              })
            : t("Databases.Opponent.Failure.Other", {
                defaultValue: "The games of {{username}} on {{site}} could not be downloaded.",
                site,
                username,
              }),
  });
}

/** Reports an opponent import outcome and any older copy that could not be deleted. */
export function reportOpponentImport(t: TFunction, result: OpponentImportResult): void {
  announce(t, result);
  // A copy that could not be deleted is named whatever the run's ending.
  if (result.leftovers > 0) reportOpponentLeftover(t);
}
