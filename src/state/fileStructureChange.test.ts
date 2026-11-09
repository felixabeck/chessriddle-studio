import { expect, test, vi } from "vitest";
import i18n, { initializeI18n } from "@/i18n";
import {
    afterFileStructureChange,
    beginFileOpen,
    beginFileStructureChange,
    hasFileOpenInFlight,
} from "./fileStructureChange";

test("opens refuse an active structure change and are admitted after it ends", async () => {
    await initializeI18n();
    const endChange = beginFileStructureChange("file-a");
    try {
        expect(() => beginFileOpen("file-a")).toThrow(i18n.t("Files.LineSection.Stale"));
        expect(hasFileOpenInFlight("file-a")).toBe(false);
        const endOther = beginFileOpen("file-b");
        expect(hasFileOpenInFlight("file-b")).toBe(true);
        endOther();
        expect(hasFileOpenInFlight("file-b")).toBe(false);
    } finally {
        endChange();
    }
    const endOpen = beginFileOpen("file-a");
    expect(hasFileOpenInFlight("file-a")).toBe(true);
    endOpen();
    expect(hasFileOpenInFlight("file-a")).toBe(false);
});

test("open releases are idempotent and retain the file until every open ends", () => {
    const endFirst = beginFileOpen("file-a");
    const endSecond = beginFileOpen("file-a");
    try {
        endFirst();
        endFirst();
        expect(hasFileOpenInFlight("file-a")).toBe(true);
    } finally {
        endFirst();
        endSecond();
    }
    expect(hasFileOpenInFlight("file-a")).toBe(false);
    const endNext = beginFileOpen("file-a");
    try {
        endSecond();
        expect(hasFileOpenInFlight("file-a")).toBe(true);
    } finally {
        endNext();
    }
    expect(hasFileOpenInFlight("file-a")).toBe(false);
});

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
