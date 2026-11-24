import { createInstance } from "i18next";
import { expect, test } from "vitest";
import english from "@/translation/en-US.json";
import german from "@/translation/de-DE.json";
import { engineFailureMessage } from "./engineFailure";

test.each(["en", "de"])(
    "P2 safe reasons and kind/status fallbacks are localized in %s",
    async (lng) => {
        const i18n = createInstance();
        await i18n.init({
            lng,
            fallbackLng: false,
            keySeparator: false,
            resources: { en: english, de: german },
        });
        const fallback = (
            kind: "disconnected" | "process-exit" | "protocol-failure",
            code: number | null = null,
            signal: number | null = null,
        ) =>
            engineFailureMessage(i18n.t, {
                kind,
                exitStatus: { code, signal },
                reason: null,
                entries: [],
            });
        expect(fallback("disconnected")).toBe(
            lng === "en" ? "Engine disconnected" : "Engine-Verbindung getrennt",
        );
        expect(fallback("process-exit")).toBe(lng === "en" ? "Engine exited" : "Engine beendet");
        expect(fallback("protocol-failure")).toBe(
            lng === "en" ? "Engine protocol failed" : "Engine-Protokoll fehlgeschlagen",
        );
        expect(fallback("process-exit", 7)).toContain("7");
        expect(fallback("process-exit", null, 9)).toContain("9");
        expect(engineFailureMessage(i18n.t)).toBe(i18n.t("Board.Analysis.EngineDisconnected"));
        expect(engineFailureMessage(i18n.t, undefined, "")).toBe(
            i18n.t("Board.Analysis.EngineDisconnected"),
        );
        expect(engineFailureMessage(i18n.t, undefined, "Safe launch failure")).toBe(
            "Safe launch failure",
        );
        expect(
            engineFailureMessage(i18n.t, {
                kind: "process-exit",
                exitStatus: null,
                reason: "Safe reason",
                entries: [],
            }),
        ).toBe("Safe reason");
    },
);
