import { expect, test } from "vitest";
import { catalogueI18n } from "@/tests/catalogues";
import { supportedLocales } from "@/i18n";
import { lineTitleOf } from "./lineTitle";

test.each([
    [
        { white: " Dragon System ", black: " 6...Dc7 ", event: "fertig" },
        { name: "Dragon System", idea: "6...Dc7" },
    ],
    [
        { white: "Dragon", black: "?", event: "fertig" },
        { name: "Dragon", idea: undefined },
    ],
    [
        { white: "?", black: "plan", event: " Legacy title " },
        { name: "Legacy title", idea: "plan" },
    ],
    [
        { white: " \t", black: " \n", event: "Fallback" },
        { name: "Fallback", idea: undefined },
    ],
    [
        { white: "", black: "", event: "" },
        { name: undefined, idea: undefined },
    ],
    [
        { white: " ? ", black: " ? ", event: " ? " },
        { name: undefined, idea: undefined },
    ],
    [{}, { name: undefined, idea: undefined }],
])("derives a normalized line title from %j", (headers, expected) => {
    expect(lineTitleOf(headers)).toEqual(expected);
});

test.each(supportedLocales)(
    "line fields have real translations in %s without fallback",
    async (locale) => {
        const i18n = await catalogueI18n(locale);
        for (const key of [
            "GameInfo.LineName",
            "GameInfo.EnterLineName",
            "GameInfo.Idea",
            "GameInfo.EnterIdea",
            "GameInfo.UntitledLine",
        ]) {
            expect(i18n.t(key).trim()).not.toBe("");
            expect(i18n.t(key)).not.toBe(key);
        }
    },
);
