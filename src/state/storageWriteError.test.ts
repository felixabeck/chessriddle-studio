import { expect, test } from "vitest";
import { persistStorageWriteError } from "./storageWriteError";

test.each([42, null, undefined])(
    "wraps a non-Error storage failure with its original cause: %s",
    (cause) => {
        const reported = persistStorageWriteError(cause);

        expect(reported.message).toBe(
            "Could not save this game. Session storage rejected the write.",
        );
        expect(reported.cause).toBe(cause);
    },
);

test("recognizes a plain quota-shaped failure and retains its cause", () => {
    const cause = { name: "QuotaExceededError" };

    expect(persistStorageWriteError(cause)).toMatchObject({
        message:
            "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
        cause,
    });
});

test("returns a non-quota Error as-is", () => {
    const cause = new Error("disk went away");
    expect(persistStorageWriteError(cause)).toBe(cause);
});
