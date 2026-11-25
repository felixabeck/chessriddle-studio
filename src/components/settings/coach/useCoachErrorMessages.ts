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
            signInAgain: t("Coach.Error.SignInAgain"),
            signInFailed: t("Coach.Error.SignInFailed"),
            subscriptionNotEligible: t("Coach.Error.SubscriptionNotEligible"),
            usageLimitReached: t("Coach.Error.UsageLimitReached"),
            creditsExhausted: t("Coach.Error.CreditsExhausted"),
            photoUnreadable: t("Coach.Error.PhotoUnreadable"),
            clipboardEmpty: t("Coach.Error.ClipboardEmpty"),
        }),
        [t],
    );
}

/**
 * One sentence per native error code for the Assistant. Codes whose Coach wording names the Coach,
 * the engine or the connection form get Assistant-specific wording; the others are shared.
 */
export function useAssistantErrorMessages(): Record<CoachError, string> {
    const { t } = useTranslation();
    const coach = useCoachErrorMessages();
    return useMemo(
        () => ({
            ...coach,
            busy: t("Assistant.Error.Busy"),
            limitExceeded: t("Assistant.Error.LimitExceeded"),
            unavailable: t("Assistant.Error.Unavailable"),
            invalidInput: t("Assistant.Error.InvalidInput"),
            noFunctionCalling: t("Assistant.Error.NoFunctionCalling"),
            engineFailed: t("Assistant.Error.EngineFailed"),
        }),
        [coach, t],
    );
}

/**
 * One sentence per native error code for scoresheet photo import. Reused codes whose Coach wording
 * does not fit photo reading get scoresheet-specific wording; the rest inherit from the Coach.
 */
export function useScoresheetErrorMessages(): Record<CoachError, string> {
    const { t } = useTranslation();
    const coach = useCoachErrorMessages();
    return useMemo(
        () => ({
            ...coach,
            busy: t("Scoresheet.Error.Busy"),
            limitExceeded: t("Scoresheet.Error.LimitExceeded"),
            unavailable: t("Scoresheet.Error.Unavailable"),
            invalidInput: t("Scoresheet.Error.InvalidInput"),
        }),
        [coach, t],
    );
}
