import type { TFunction } from "i18next";
import type { RootFailure } from "@/bindings";
import i18n from "@/i18n";
import { errorUnlessCancelled } from "@/platform/errors";

export type ListingFailure =
    | "silent"
    | "retry"
    | "changed"
    | "missing"
    | "unusable"
    | "permission"
    | "tooLarge";

export type RootFailureDomain = "database" | "puzzle" | "engine" | "files";

/** A missing domain label leaves the caller's existing error presentation intact. */
export function rootFailureMessage(
    domain: RootFailureDomain,
    error: unknown,
    t: TFunction = i18n.t,
): string | undefined {
    if (error == null) return undefined;
    const label = errorUnlessCancelled(error)?.rootFailure;
    if (!label) return undefined;
    let messages: Partial<Record<RootFailure, string>>;
    switch (domain) {
        case "database":
            messages = {
                changed: t("Databases.LoadError.Changed", {
                    defaultValue: "This database folder changed. Choose another.",
                }),
                missing: t("Databases.LoadError.RootMissing", {
                    defaultValue: "This database folder is no longer available. Choose another.",
                }),
                unusable: t("Databases.LoadError.Unusable", {
                    defaultValue: "This database folder cannot be opened. Choose another.",
                }),
                permission: t("Databases.LoadError.RootPermission", {
                    defaultValue:
                        "ChessRiddle Studio is not allowed to read this database folder. Choose another.",
                }),
                "too-large": t("Databases.LoadError.TooLarge", {
                    defaultValue: "This database folder is too large to list. Choose another.",
                }),
            };
            break;
        case "puzzle":
            messages = {
                changed: t("Puzzle.LoadError.Changed", {
                    defaultValue: "This puzzle folder changed. Choose another in Settings.",
                }),
                missing: t("Puzzle.LoadError.RootMissing", {
                    defaultValue:
                        "This puzzle folder is no longer available. Choose another in Settings.",
                }),
                unusable: t("Puzzle.LoadError.Unusable", {
                    defaultValue:
                        "This puzzle folder cannot be opened. Choose another in Settings.",
                }),
                permission: t("Puzzle.LoadError.RootPermission", {
                    defaultValue:
                        "ChessRiddle Studio is not allowed to read this puzzle folder. Choose another in Settings.",
                }),
            };
            break;
        case "engine":
            messages = {
                changed: t("Engines.LoadError.Changed", {
                    defaultValue: "This engine folder changed. Choose another in Settings.",
                }),
                missing: t("Engines.LoadError.RootMissing", {
                    defaultValue:
                        "This engine folder is no longer available. Choose another in Settings.",
                }),
                unusable: t("Engines.LoadError.Unusable", {
                    defaultValue:
                        "This engine folder cannot be opened. Choose another in Settings.",
                }),
                permission: t("Engines.LoadError.RootPermission", {
                    defaultValue:
                        "ChessRiddle Studio is not allowed to read this engine folder. Choose another in Settings.",
                }),
            };
            break;
        case "files":
            messages = {
                changed: t("Files.LoadFailed.Changed", {
                    defaultValue: "This collection changed. Choose another.",
                }),
                missing: t("Files.LoadFailed.Missing", {
                    defaultValue: "This collection is no longer available. Choose another.",
                }),
                unusable: t("Files.LoadFailed.Unusable", {
                    defaultValue: "This collection cannot be opened. Choose another.",
                }),
                permission: t("Files.LoadFailed.Permission", {
                    defaultValue:
                        "ChessRiddle Studio is not allowed to read this collection. Choose another.",
                }),
                "too-large": t("Files.LoadFailed.TooLarge", {
                    defaultValue: "This collection is too large to list. Choose another.",
                }),
            };
    }
    return messages[label];
}

/** Only the backend root label establishes that a listing needs another root. */
export function listingFailure(error: unknown): ListingFailure {
    if (error == null) return "silent";
    const visible = errorUnlessCancelled(error);
    if (!visible) return "silent";
    return visible.rootFailure === "too-large" ? "tooLarge" : (visible.rootFailure ?? "retry");
}
