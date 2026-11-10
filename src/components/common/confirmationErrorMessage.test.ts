import { expect, test } from "vitest";
import type { SupportedLocale } from "@/i18n";
import type { AppErrorCategory } from "@/platform/errors";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { confirmationErrorMessage } from "./ConfirmModal";

// Lookup data, never literal t calls: tests must not seed the extractor for production.
const messageKeys = {
    cancelled: "Common.ConfirmationError.unexpected",
    network: "Common.ConfirmationError.unexpected",
    "not-found": "Common.ConfirmationError.unexpected",
    "applied-despite-error": "Common.ConfirmationError.applied-despite-error",
    permission: "Common.ConfirmationError.unexpected",
    validation: "Common.ConfirmationError.unexpected",
    unexpected: "Common.ConfirmationError.unexpected",
} satisfies Record<AppErrorCategory, string>;

test("all confirmation outcomes use their own shipped translations without fallback", async () => {
    const catalogues = shippedCatalogues();
    const english = catalogues.find(({ locale }) => locale === "en-US")!.translation;
    for (const { locale, translation } of catalogues) {
        const instance = await catalogueI18n(locale as SupportedLocale);
        for (const [category, key] of Object.entries(messageKeys)) {
            const expected = translation[key];
            expect(expected).toBeTypeOf("string");
            expect(expected.trim()).not.toBe("");
            const message = confirmationErrorMessage(
                { category, message: "private native diagnostic at /private/file.pgn" },
                instance.t.bind(instance),
            );
            expect(message).toBe(expected);
            expect(message).not.toContain("private");
        }
        expect(translation[messageKeys["applied-despite-error"]]).not.toBe(
            translation[messageKeys.unexpected],
        );
    }
    for (const { translation } of catalogues.filter(({ locale }) => !locale.startsWith("en-"))) {
        for (const key of Object.values(messageKeys)) {
            expect(translation[key]).not.toBe(english[key]);
        }
    }
});

test("an unknown native failure uses the localized generic message", async () => {
    const instance = await catalogueI18n("de-DE");
    expect(
        confirmationErrorMessage(
            new Error("opaque diagnostic /private/file.pgn"),
            instance.t.bind(instance),
        ),
    ).toBe("Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.");
});

test.each(shippedCatalogues())(
    "$locale uses its durability sentence only for the normalized backend category",
    async ({ locale, translation }) => {
        const instance = await catalogueI18n(locale as SupportedLocale);
        const message = confirmationErrorMessage(
            { tag: "backend-error", category: "durability", message: "private native diagnostic" },
            instance.t.bind(instance),
        );
        expect(message).toBe(translation["Common.DurabilityUncertain"]);
        expect(message).toBeTruthy();
        expect(message).not.toContain("private native diagnostic");
        const english = (await catalogueI18n("en-US")).t("Common.DurabilityUncertain");
        expect(message === english).toBe(locale.startsWith("en-"));
        for (const cause of [
            { category: "applied-despite-error", message: "private diagnostic" },
            { tag: "backend-error", category: "partial-removal", message: "private diagnostic" },
            new Error("Committed but durability uncertain: private diagnostic"),
        ]) {
            expect(confirmationErrorMessage(cause, instance.t.bind(instance))).toBe(
                translation["Common.ConfirmationError.applied-despite-error"],
            );
        }
    },
);

test.each(shippedCatalogues())(
    "$locale reports a name collision only when the backend marks the name as taken",
    async ({ locale, translation }) => {
        const instance = await catalogueI18n(locale as SupportedLocale);
        expect(
            confirmationErrorMessage(
                {
                    tag: "backend-error",
                    category: "conflict",
                    message: "private native diagnostic",
                    nameTaken: true,
                },
                instance.t.bind(instance),
            ),
        ).toBe(translation["Common.NameAlreadyUsed"]);
        expect(
            confirmationErrorMessage(
                {
                    tag: "backend-error",
                    category: "conflict",
                    message: "private native diagnostic",
                },
                instance.t.bind(instance),
            ),
        ).toBe(translation[messageKeys.unexpected]);
    },
);

test("every shipped catalogue has localized file-child unreadable sentences", () => {
    const catalogues = shippedCatalogues();
    const english = catalogues.find(({ locale }) => locale === "en-US")!.translation;
    const keys = [
        "Files.ChildUnreadable.Permission",
        "Files.ChildUnreadable.Invalid",
        "Files.ChildUnreadable.TooLarge",
        "Files.ChildUnreadable.Title",
    ];
    for (const { translation } of catalogues) {
        for (const key of keys) {
            const value = translation[key];
            expect(value).toBeTypeOf("string");
            expect(value.trim()).not.toBe("");
        }
    }
    for (const { translation } of catalogues.filter(({ locale }) => !locale.startsWith("en-"))) {
        for (const key of keys) {
            expect(translation[key]).not.toBe(english[key]);
        }
    }
});
