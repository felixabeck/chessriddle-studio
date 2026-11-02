import { expect, test, vi } from "vitest";
import { createNativeListenerLifecycle } from "./listenerLifecycle";

test("unlistens if stopped before the subscribe promise settles", async () => {
    const unlisten = vi.fn();
    let resolve!: (value: () => void) => void;
    const pending = new Promise<() => void>((done) => {
        resolve = done;
    });
    const onFailure = vi.fn();
    const lifecycle = createNativeListenerLifecycle({ onFailure });
    lifecycle.listen(() => pending);
    lifecycle.stop();
    resolve(unlisten);
    await pending;
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
});

test("reports a subscribe failure once", async () => {
    const onFailure = vi.fn();
    const lifecycle = createNativeListenerLifecycle({ onFailure });
    lifecycle.listen(async () => {
        throw new Error("native refused");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ message: "native refused" }),
    );
    lifecycle.fail(new Error("second failure"));
    expect(onFailure).toHaveBeenCalledOnce();
});

test("does not report a subscribe failure after stop", async () => {
    const onFailure = vi.fn();
    let reject!: (error: Error) => void;
    const pending = new Promise<() => void>((_, done) => {
        reject = done;
    });
    const lifecycle = createNativeListenerLifecycle({ onFailure });
    lifecycle.listen(() => pending);
    lifecycle.stop();
    reject(new Error("native refused"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();
});
