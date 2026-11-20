export function createTabStorageQuotaError(cause: unknown): Error {
    return new Error(
        "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
        { cause },
    );
}

export function persistStorageWriteError(cause: unknown): Error {
    if (
        typeof cause === "object" &&
        cause !== null &&
        "name" in cause &&
        String((cause as { name: unknown }).name) === "QuotaExceededError"
    ) {
        return createTabStorageQuotaError(cause);
    }
    // jsdom's DOMException is not an Error; the browser one is, so the first arm covers WebKit.
    if (cause instanceof Error || cause instanceof DOMException) return cause;
    return new Error("Could not save this game. Session storage rejected the write.", { cause });
}
