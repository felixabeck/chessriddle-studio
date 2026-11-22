import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError } from "@/bindings";

/** One sentence per native Coach error, for every place that reports one. */
export function useCoachErrorMessages(): Record<CoachError, string> {
    const { t } = useTranslation();
    return useMemo(
        () => ({
            unavailable: t("Coach.Error.Unavailable"),
            notFound: t("Coach.Error.NotFound"),
            invalidInput: t("Coach.Error.InvalidInput"),
            invalidAddressFormat: t("Coach.Error.InvalidAddressFormat"),
            invalidAddressCredentials: t("Coach.Error.InvalidAddressCredentials"),
            invalidAddressScheme: t("Coach.Error.InvalidAddressScheme"),
            keyRequired: t("Coach.Error.KeyRequired"),
            tooManyConnections: t("Coach.Error.TooManyConnections"),
            needsRepair: t("Coach.Error.NeedsRepair"),
            keyRejected: t("Coach.Error.KeyRejected"),
            storage: t("Coach.Error.Storage"),
            network: t("Coach.Error.Network"),
            rateLimited: t("Coach.Error.RateLimited"),
            providerFailure: t("Coach.Error.ProviderFailure"),
            busy: t("Coach.Error.Busy"),
            engineFailed: t("Coach.Error.EngineFailed"),
            modelUnavailable: t("Coach.Error.ModelUnavailable"),
            noFunctionCalling: t("Coach.Error.NoFunctionCalling"),
            effortRejected: t("Coach.Error.EffortRejected"),
            answerCutOff: t("Coach.Error.AnswerCutOff"),
            contentFiltered: t("Coach.Error.ContentFiltered"),
            limitExceeded: t("Coach.Error.LimitExceeded"),
            cancelled: t("Coach.Error.Cancelled"),
        }),
        [t],
    );
}
