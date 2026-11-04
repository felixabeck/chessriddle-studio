import { expect, test, vi } from "vitest";
import { afterFileStructureChange, beginFileStructureChange } from "./fileStructureChange";

test("waits for every active delete of the file and leaves other files available", async () => {
    const endFirst = beginFileStructureChange("file-a");
    const endSecond = beginFileStructureChange("file-a");
    const call = vi.fn().mockResolvedValue("ready");
    const waiting = afterFileStructureChange("file-a", call);
    try {
        await expect(afterFileStructureChange("file-b", async () => "other")).resolves.toBe(
            "other",
        );
        expect(call).not.toHaveBeenCalled();
        endFirst();
        endFirst();
        await Promise.resolve();
        expect(call).not.toHaveBeenCalled();
    } finally {
        endFirst();
        endSecond();
    }
    await expect(waiting).resolves.toBe("ready");
    expect(call).toHaveBeenCalledOnce();
    await expect(afterFileStructureChange("file-a", async () => "released")).resolves.toBe(
        "released",
    );
});

test("checks for a new delete that starts before a waiter resumes", async () => {
    const endFirst = beginFileStructureChange("file-a");
    const call = vi.fn().mockResolvedValue(null);
    const waiting = afterFileStructureChange("file-a", call);
    endFirst();
    const endSecond = beginFileStructureChange("file-a");
    try {
        await Promise.resolve();
        expect(call).not.toHaveBeenCalled();
    } finally {
        endSecond();
    }
    await waiting;
    expect(call).toHaveBeenCalledOnce();
});

test("propagates native errors after release and permits later calls", async () => {
    const end = beginFileStructureChange("file-a");
    const failure = new Error("native failure");
    const waiting = afterFileStructureChange("file-a", () => {
        throw failure;
    });
    end();
    await expect(waiting).rejects.toBe(failure);
    await expect(afterFileStructureChange("file-a", async () => "ready")).resolves.toBe("ready");
});
