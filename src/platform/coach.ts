import type { CoachError } from "@/bindings";

const coachErrors: Record<CoachError, true> = {
    unavailable: true,
    notFound: true,
    invalidInput: true,
    invalidAddressFormat: true,
    invalidAddressCredentials: true,
    invalidAddressScheme: true,
    keyRequired: true,
    tooManyConnections: true,
    needsRepair: true,
    keyRejected: true,
    storage: true,
    network: true,
    rateLimited: true,
    providerFailure: true,
};

/** Only the Coach's closed native error vocabulary crosses this boundary. */
export class CoachCommandError extends Error {
    readonly code: CoachError;

    constructor(cause: unknown) {
        const value = cause instanceof Error ? cause.message : cause;
        const code =
            typeof value === "string" && Object.hasOwn(coachErrors, value)
                ? (value as CoachError)
                : "providerFailure";
        super(code);
        this.name = "CoachCommandError";
        this.code = code;
    }
}

/** The code of any failure of a Coach command, including one that never reached the native side. */
export function coachErrorCode(cause: unknown): CoachError {
    return cause instanceof CoachCommandError ? cause.code : new CoachCommandError(cause).code;
}
