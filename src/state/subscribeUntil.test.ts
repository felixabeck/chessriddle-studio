import { describe, expect, test, vi } from "vitest";
import { abortError, subscribeUntil } from "./subscribeUntil";

describe("subscribeUntil", () => {
    test("rejects immediately without subscribing when signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const subscribe = vi.fn(() => () => {});
        const read = vi.fn(() => "ready");

        await expect(subscribeUntil(controller.signal, subscribe, read)).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(subscribe).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    test("resolves immediately and unsubscribes when read() is already defined", async () => {
        const controller = new AbortController();
        const unsub = vi.fn();
        const subscribe = vi.fn(() => unsub);

        const value = await subscribeUntil(controller.signal, subscribe, () => 42);
        expect(value).toBe(42);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(unsub).toHaveBeenCalledTimes(1);
    });

    test("waits for a notification and cleans up on resolve or abort", async () => {
        const controller = new AbortController();
        let current: string | undefined;
        let listener: (() => void) | null = null;
        const unsub = vi.fn(() => {
            listener = null;
        });

        const promise = subscribeUntil(
            controller.signal,
            (check) => {
                listener = check;
                return unsub;
            },
            () => current,
        );

        current = "settled";
        listener!();
        await expect(promise).resolves.toBe("settled");
        expect(unsub).toHaveBeenCalledTimes(1);

        // Abort while waiting cleans up subscription.
        const controller2 = new AbortController();
        const unsub2 = vi.fn();
        const pending = subscribeUntil(
            controller2.signal,
            () => unsub2,
            () => undefined,
        );
        controller2.abort(abortError());
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(unsub2).toHaveBeenCalledTimes(1);
    });

    test("calls teardown when subscribe(check) emits synchronously with a defined value", async () => {
        const controller = new AbortController();
        const unsub = vi.fn();

        const value = await subscribeUntil(
            controller.signal,
            (check) => {
                check();
                return unsub;
            },
            () => "immediate",
        );

        expect(value).toBe("immediate");
        expect(unsub).toHaveBeenCalledTimes(1);
    });
});
