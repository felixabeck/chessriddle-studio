import { notifications } from "@mantine/notifications";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import { createTreeStore } from "@/state/store/tree";
import enUSCatalogue from "@/translation/en-US.json";
import { getPGN } from "@/utils/chess";
import { writeClipboardText } from "./clipboard";

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeAll(async () => {
    await i18n.init({
        lng: "en-US",
        resources: { "en-US": { translation: enUSCatalogue.translation } },
    });
});

beforeEach(() => {
    vi.mocked(notifications.show).mockClear();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
});

function pgnFixture(action: "copyPgn" | "copyVariationPgn") {
    const store = createTreeStore();
    store.getState().makeMoves({ payload: ["e4", "e5"] });
    store.getState().goToStart();
    store.getState().makeMove({ payload: "d4" });
    store.getState().setComment("Variation commentary");
    store.getState().setAnnotation("!");
    store.getState().setShapes([{ orig: "d2", dest: "d4", brush: "green" }]);
    store.getState().save();
    const before = store.getState();
    return {
        store,
        before,
        copy: () => before[action]([1]),
        expected: getPGN(before.root, {
            headers: action === "copyPgn" ? before.headers : null,
            comments: action === "copyPgn",
            extraMarkups: action === "copyPgn",
            glyphs: true,
            variations: action === "copyPgn",
            ...(action === "copyVariationPgn" ? { path: [1] } : {}),
        }),
    };
}

test.each(
    (["copyPgn", "copyVariationPgn"] as const).flatMap((action) =>
        ["rejected", "missing API", "missing writeText", "synchronous throw"].map((outcome) => ({
            action,
            outcome,
        })),
    ),
)(
    "$action handles clipboard $outcome and preserves the captured PGN and tree",
    async ({ action, outcome }) => {
        const { store, before, copy } = pgnFixture(action);
        const error = new DOMException("Clipboard permission denied", "NotAllowedError");
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value:
                outcome === "missing API"
                    ? undefined
                    : outcome === "missing writeText"
                      ? {}
                      : { writeText },
        });
        if (outcome === "rejected") writeText.mockRejectedValue(error);
        if (outcome === "synchronous throw")
            writeText.mockImplementation(() => {
                throw error;
            });
        await expect(copy()).resolves.toBe(false);
        expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
            message: "The PGN could not be copied to the clipboard.",
            color: "danger",
        });
        expect(store.getState()).toBe(before);
        store.dispose();
    },
);

test.each(["copyPgn", "copyVariationPgn"] as const)(
    "%s awaits acceptance, copies the exact captured PGN and leaves state unchanged",
    async (action) => {
        const { store, before, copy, expected } = pgnFixture(action);
        let accept!: () => void;
        writeText.mockReset().mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    accept = resolve;
                }),
        );
        const pending = copy();
        expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
        expect(store.getState()).toBe(before);
        // Changing the document while the platform write is pending cannot change its text.
        store.getState().setFen(before.root.fen);
        const replaced = store.getState();
        accept();
        await expect(pending).resolves.toBe(true);
        expect(notifications.show).not.toHaveBeenCalled();
        expect(store.getState()).toBe(replaced);
        store.dispose();
    },
);

test("clipboard helper rejects unavailable access with the recovery error", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await expect(writeClipboardText("saved bytes")).rejects.toThrow(
        "Clipboard access is unavailable.",
    );
});
