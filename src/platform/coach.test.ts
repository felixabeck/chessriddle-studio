import { expect, test } from "vitest";
import { CoachCommandError, coachErrorCode } from "./coach";

test("only the Coach's own error codes survive; anything else becomes providerFailure", () => {
    expect(new CoachCommandError("keyRejected").code).toBe("keyRejected");
    expect(new CoachCommandError(new Error("rateLimited")).code).toBe("rateLimited");
    for (const foreign of ["server", "toString", "", 7, null, undefined, { code: "network" }]) {
        const error = new CoachCommandError(foreign);
        expect(error.code).toBe("providerFailure");
        expect(error.message).toBe("providerFailure");
    }
    expect(new CoachCommandError(new Error("Bearer sk-secret")).message).toBe("providerFailure");
});

test("coachErrorCode reads the code of a Coach error and reduces every other cause", () => {
    expect(coachErrorCode(new CoachCommandError("storage"))).toBe("storage");
    expect(coachErrorCode(new CoachCommandError("photoStorage"))).toBe("photoStorage");
    expect(coachErrorCode("network")).toBe("network");
    expect(coachErrorCode(new TypeError("fetch failed"))).toBe("providerFailure");
});
