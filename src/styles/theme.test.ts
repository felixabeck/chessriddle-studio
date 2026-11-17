import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { describe, expect, test } from "vitest";
import {
    appCssVariablesResolver,
    chessRiddleTokens,
    createAppTheme,
    scaleBreakpoint,
} from "./theme";

describe("scaled theme breakpoints", () => {
    test("preserves Mantine's default breakpoints at 100%", () => {
        expect(createAppTheme({ spellCheck: false, fontSize: 100 }).breakpoints).toEqual(
            DEFAULT_THEME.breakpoints,
        );
    });

    test.each([
        [50, { xs: "18em", sm: "24em", md: "31em", lg: "37.5em", xl: "44em" }],
        [200, { xs: "72em", sm: "96em", md: "124em", lg: "150em", xl: "176em" }],
        [110, { xs: "39.6em", sm: "52.8em", md: "68.2em", lg: "82.5em", xl: "96.8em" }],
    ])(
        "scales every default breakpoint at %s%% without floating-point noise",
        (fontSize, expected) => {
            expect(createAppTheme({ spellCheck: false, fontSize }).breakpoints).toEqual(expected);
        },
    );
});

test.each([
    [48, 110, "52.8em"],
    [30, 110, "33em"],
    [50, 110, "55em"],
    [37.5, 50, "18.75em"],
])("scales %sem at %s%% to %s", (widthEm, fontSize, expected) => {
    expect(scaleBreakpoint(widthEm, fontSize)).toBe(expected);
});

describe("ChessRiddle foundation", () => {
    const theme = mergeMantineTheme(
        DEFAULT_THEME,
        createAppTheme({ spellCheck: false, fontSize: 100 }),
    );
    test("fixes gold at the exact scheme-specific primary while retaining board palettes", () => {
        expect(theme.primaryColor).toBe("gold");
        // Switches, checkboxes and radios show the pointer on track and label.
        expect(theme.cursorType).toBe("pointer");
        expect(theme.primaryShade).toEqual({ light: 8, dark: 4 });
        expect(theme.colors.gold[8]).toBe("hsl(45 76% 24%)");
        expect(theme.colors.gold[4]).toBe("hsl(42 53.2% 54.7%)");
        for (const [name, palette] of Object.entries(DEFAULT_THEME.colors).filter(
            ([name]) => name !== "dark",
        )) {
            expect(theme.colors[name]).toEqual(palette);
        }
        expect(theme.colors.danger[8]).toBe("hsl(0 55% 50%)");
        expect(theme.colors.success[8]).toBe("hsl(135 45% 40%)");
        expect(theme.colors.warning[8]).toBe("hsl(30 80% 55%)");
        expect(theme.colors.info[8]).toBe("hsl(210 50% 50%)");
    });

    test.each([
        ["light", "hsl(48 29% 97.1%)", "hsl(0 0% 100%)", "hsl(40 25% 91%)", "hsl(0 0% 16.5%)"],
        [
            "dark",
            "hsl(20 11.1% 5.8%)",
            "hsl(30 8.5% 13.5%)",
            "hsl(30 10% 22%)",
            "hsl(40 20.7% 88.6%)",
        ],
    ] as const)(
        "publishes all tokens and three surface tiers in %s",
        (scheme, background, card, inset, foreground) => {
            const resolved = appCssVariablesResolver(theme)[scheme];
            expect(resolved["--cf-background"]).toBe(background);
            expect(resolved["--cf-card"]).toBe(card);
            expect(resolved["--cf-surface-inset"]).toBe(inset);
            expect(resolved["--mantine-color-body"]).toBe(background);
            expect(resolved["--mantine-color-text"]).toBe(foreground);
            expect(resolved["--mantine-color-default-border"]).toBe(
                chessRiddleTokens[scheme].border,
            );
            for (const [name, value] of Object.entries(chessRiddleTokens[scheme])) {
                expect(resolved[`--cf-${name}`]).toBe(value);
            }
        },
    );

    test("uses the self-hosted families and dimension-based radius scale", () => {
        expect(theme.fontFamily).toContain("Inter");
        expect(theme.fontFamilyMonospace).toContain("JetBrains Mono");
        expect(theme.headings.fontFamily).toBe(theme.fontFamily);
        expect(theme.defaultRadius).toBe("lg");
        expect(theme.radius).toMatchObject({
            xs: "4px",
            sm: "8px",
            md: "12px",
            lg: "16px",
            xl: "9999px",
        });
    });
});
