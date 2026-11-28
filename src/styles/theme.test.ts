import { DEFAULT_THEME, getPrimaryShade, mergeMantineTheme } from "@mantine/core";
import { describe, expect, test } from "vitest";
import { ANNOTATION_INFO } from "@/utils/annotation";
import {
    ANNOTATION_FILLS,
    ANNOTATION_HUES,
    appCssVariablesResolver,
    chessRiddleTokens,
    type ChessRiddleScheme,
    createAppTheme,
    dimCssVariableOverrides,
    dimThemeCss,
    scaleBreakpoint,
} from "./theme";

function resolvedScheme(theme: ReturnType<typeof mergeMantineTheme>, scheme: ChessRiddleScheme) {
    if (scheme === "dim") {
        return {
            ...appCssVariablesResolver(theme).dark,
            ...dimCssVariableOverrides(theme),
        };
    }
    return appCssVariablesResolver(theme)[scheme];
}

const fileSystemModule = "node:fs";
const readCss = await (
    import(fileSystemModule) as Promise<{
        readFileSync(path: string, encoding: "utf8"): string;
    }>
).then((fs) => (path: string) => fs.readFileSync(path, "utf8"));

function cssRuleBody(css: string, selector: string): string {
    const start = css.indexOf(selector);
    if (start < 0) {
        throw new Error(`missing selector ${selector}`);
    }
    const brace = css.indexOf("{", start);
    if (brace < 0) {
        throw new Error(`missing block for ${selector}`);
    }
    let depth = 0;
    for (let index = brace; index < css.length; index++) {
        const character = css[index];
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return css.slice(brace + 1, index);
            }
        }
    }
    throw new Error(`unclosed block for ${selector}`);
}

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
        ["dim", "hsl(30 6% 16%)", "hsl(30 6% 22%)", "hsl(30 6% 29%)", "hsl(30 6% 92%)"],
    ] as const)(
        "publishes all tokens and three surface tiers in %s",
        (scheme, background, card, inset, foreground) => {
            const resolved = resolvedScheme(theme, scheme);
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

    test("emits only dim-vs-dark variable diffs under the dim selector", () => {
        const overrides = dimCssVariableOverrides(theme);
        const darkResolved = appCssVariablesResolver(theme).dark;
        const darkVars = darkResolved as Record<string, string>;
        expect(
            Object.entries(overrides)
                .filter(([name]) => name in darkVars)
                .every(([name, value]) => value !== darkVars[name]),
        ).toBe(true);
        expect(overrides["--cf-background"]).toBe("hsl(30 6% 16%)");
        expect(overrides["--cf-bar-hover"]).toBe("hsl(30 6% 45%)");
        expect(overrides["--mantine-color-dark-6"]).toBe("hsl(30 6% 22%)");
        expect(overrides["--mantine-color-dark-7"]).toBe("hsl(30 6% 16%)");
        const css = dimThemeCss(theme);
        expect(
            css.startsWith(
                ':root[data-mantine-color-scheme="dark"][data-cf-theme-variant="dim"] {',
            ),
        ).toBe(true);
        expect(css).toContain("--cf-background: hsl(30 6% 16%);");
        expect(css).not.toContain("--cf-primary:");
    });

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

describe("notation mark colours", () => {
    const theme = mergeMantineTheme(
        DEFAULT_THEME,
        createAppTheme({ spellCheck: false, fontSize: 100 }),
    );
    type Rgb = readonly [number, number, number];
    const hex = (value: string): Rgb => {
        // Mantine's black and white are the short forms #000 and #fff.
        const full = /^#[\da-f]{3}$/i.test(value)
            ? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}`
            : value;
        if (!/^#[\da-f]{6}$/i.test(full)) throw new Error(`unparsed ${value}`);
        return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
    };
    const hsl = (value: string): Rgb => {
        const match = value.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/);
        if (!match) throw new Error(`unparsed ${value}`);
        const [h, s, l] = [+match[1], +match[2] / 100, +match[3] / 100];
        const k = (n: number) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
        return [f(0), f(8), f(4)];
    };
    const mix = (top: Rgb, below: Rgb, share: number): Rgb =>
        top.map((value, i) => value * share + below[i] * (1 - share)) as unknown as Rgb;
    const luminance = (rgb: Rgb) => {
        const [r, g, b] = rgb.map((value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: Rgb, b: Rgb) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
    };
    /** Resolves a palette shade, or one mixed with black or white. */
    const resolve = (value: string): Rgb => {
        const shade = value.match(/var\(--mantine-color-(\w+)-(\d)\)/);
        if (!shade) throw new Error(`unparsed ${value}`);
        const color = hex(theme.colors[shade[1]][+shade[2]]);
        const mixed = value.match(
            /^color-mix\(in srgb, var\(--mantine-color-\w+-\d\) (\d+)%, (black|white)\)$/,
        );
        if (mixed) {
            return mix(color, mixed[2] === "black" ? [0, 0, 0] : [255, 255, 255], +mixed[1] / 100);
        }
        if (value === shade[0]) return color;
        throw new Error(`unparsed ${value}`);
    };

    test.each(["light", "dark", "dim"] as const)(
        "every mark hue reaches 4.5:1 on the card, inset blocks and the current-move fill in %s",
        (scheme) => {
            const tokens = chessRiddleTokens[scheme];
            const card = hsl(tokens.card);
            const inset = hsl(tokens["surface-inset"]);
            const primary = hsl(tokens.primary);
            // The notation's current move: --cf-primary at 10% (MoveCell.module.css).
            const backgrounds = {
                card,
                inset,
                currentOnCard: mix(primary, card, 0.1),
                currentOnInset: mix(primary, inset, 0.1),
            };
            const resolved = resolvedScheme(theme, scheme);
            const below: string[] = [];
            for (const hue of ANNOTATION_HUES) {
                const text = resolve(resolved[`--cf-annotation-${hue}-text`]);
                for (const [name, background] of Object.entries(backgrounds)) {
                    const ratio = contrast(text, background);
                    if (ratio < 4.5) below.push(`${hue} on ${name}: ${ratio.toFixed(2)}`);
                }
            }
            expect(below).toEqual([]);
        },
    );

    test.each(["light", "dark", "dim"] as const)(
        "the open-variation mark reads as text on the card, the page and inset blocks in %s",
        (scheme) => {
            const tokens = chessRiddleTokens[scheme];
            const value = resolvedScheme(theme, scheme)["--cf-open-variation"];
            const mixed = value.match(
                /^color-mix\(in srgb, (hsl\([^)]+\)) (\d+)%, (black|white)\)$/,
            );
            if (!mixed) throw new Error(`unparsed ${value}`);
            // The info hue: no move-quality mark uses it.
            expect(mixed[1]).toBe(tokens["chart-6"]);
            const mark = mix(
                hsl(mixed[1]),
                mixed[3] === "black" ? [0, 0, 0] : [255, 255, 255],
                +mixed[2] / 100,
            );
            const card = hsl(tokens.card);
            const inset = hsl(tokens["surface-inset"]);
            const primary = hsl(tokens.primary);
            // The count is text on the card and the page; the frame sits on inset blocks.
            const text = { card, page: hsl(tokens.background), inset };
            // A framed move can be the current one: the frame is a graphic there, at 3:1.
            const graphic = {
                currentOnCard: mix(primary, card, 0.1),
                currentOnInset: mix(primary, inset, 0.1),
            };
            const below: string[] = [];
            for (const [minimum, backgrounds] of [
                [4.5, text],
                [3, graphic],
            ] as const) {
                for (const [name, background] of Object.entries(backgrounds)) {
                    const ratio = contrast(mark, background);
                    if (ratio < minimum) below.push(`${name}: ${ratio.toFixed(2)}`);
                }
            }
            expect(below).toEqual([]);
        },
    );

    const blackOrWhite = (value: string): Rgb => {
        if (value === "var(--mantine-color-black)") return hex(theme.black);
        if (value === "var(--mantine-color-white)") return hex(theme.white);
        throw new Error(`unparsed ${value}`);
    };

    test.each(["light", "dark", "dim"] as const)(
        "the glyph on every mark's fill reaches 4.5:1 at rest and on hover in %s",
        (scheme) => {
            const card = hsl(chessRiddleTokens[scheme].card);
            const resolved = resolvedScheme(theme, scheme);
            const below: string[] = [];
            for (const fill of ANNOTATION_FILLS) {
                const filled = hex(
                    theme.colors[fill][
                        getPrimaryShade(theme, scheme === "light" ? "light" : "dark")
                    ],
                );
                const glyph = blackOrWhite(resolved[`--cf-annotation-${fill}-on-fill`]);
                const surfaces: Record<string, Rgb> = { filled };
                // The active Annotate button's hover: the fill at 90% over the panel card.
                if (fill !== "gray") surfaces.hover = mix(filled, card, 0.9);
                for (const [name, background] of Object.entries(surfaces)) {
                    const ratio = contrast(glyph, background);
                    if (ratio < 4.5) below.push(`${fill} ${name}: ${ratio.toFixed(2)}`);
                }
            }
            expect(below).toEqual([]);
        },
    );

    test.each(ANNOTATION_HUES)(
        "an active Annotate button in %s draws its label in the on-fill colour",
        (hue) => {
            const variant = theme.variantColorResolver({ color: hue, variant: "filled", theme });
            expect(variant.color).toBe(`var(--cf-annotation-${hue}-on-fill)`);
            expect(variant.hover).toBe(
                `color-mix(in srgb, var(--mantine-color-${hue}-filled) 90%, transparent)`,
            );
        },
    );

    test.each(["light", "dark", "dim"] as const)(
        "selected 10% gold-pill labels reach 4.5:1 on card, popover, interactive and inset in %s",
        (scheme) => {
            const tokens = chessRiddleTokens[scheme];
            // Accordion / Combobox / Menu sit on card or popover; TrainingSettings chips on
            // interactive; Tabs on inset. All keep --cf-foreground on --cf-primary at 10%.
            const text = hsl(tokens.foreground);
            const primary = hsl(tokens.primary);
            const surfaces = {
                card: tokens.card,
                popover: tokens.popover,
                interactive: tokens.interactive,
                inset: tokens["surface-inset"],
            };
            const below: string[] = [];
            for (const [name, surface] of Object.entries(surfaces)) {
                const ratio = contrast(text, mix(primary, hsl(surface), 0.1));
                if (ratio < 4.5) below.push(`${name}: ${ratio.toFixed(2)}`);
            }
            expect(below).toEqual([]);
        },
    );

    test.each([
        ["src/styles/Accordion.module.css", ".control[data-active]"],
        ["src/styles/Combobox.module.css", ".option[data-combobox-active]"],
        ["src/styles/Menu.module.css", '.item[aria-selected="true"]'],
        ["src/components/chessriddle/TrainingSettings.module.css", "&[data-checked]"],
    ] as const)("selected pill in %s sets color to --cf-foreground", (file, selector) => {
        const body = cssRuleBody(readCss(file), selector);
        expect(body).toMatch(/^\s*color:\s*var\(--cf-foreground\);/m);
        expect(body).not.toMatch(/^\s*color:\s*var\(--cf-primary\);/m);
    });

    test.each(["light", "dark", "dim"] as const)(
        "board clock digits reach 4.5:1 on their papers in %s",
        (scheme) => {
            const tokens = chessRiddleTokens[scheme];
            const light = hsl(tokens["eval-bar-light"]);
            const darkPaper = hsl(tokens["eval-bar-dark"]);
            expect(contrast(darkPaper, light)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(light, darkPaper)).toBeGreaterThanOrEqual(4.5);
        },
    );

    test.each(["light", "dark"] as const)(
        "Overview result-bar labels reach 4.5:1 on success and gray fills in %s",
        (scheme) => {
            const success = hsl(theme.colors.success[getPrimaryShade(theme, scheme)]);
            const gray = hex(DEFAULT_THEME.colors.gray[scheme === "light" ? 8 : 4]);
            const black = hex(theme.black);
            const white = hex(theme.white);
            expect(contrast(black, success)).toBeGreaterThanOrEqual(4.5);
            const draw = scheme === "light" ? white : black;
            expect(contrast(draw, gray)).toBeGreaterThanOrEqual(4.5);
        },
    );

    test.each(["light", "dark", "dim"] as const)(
        "opening-tree draw labels reach 4.5:1 on chart-4 in %s",
        (scheme) => {
            expect(
                contrast(hex(theme.black), hsl(chessRiddleTokens[scheme]["chart-4"])),
            ).toBeGreaterThanOrEqual(4.5);
        },
    );

    test("dimmed secondary text reaches 4.5:1 on the dim card, page, inset and current-move fill", () => {
        const tokens = chessRiddleTokens.dim;
        const value = resolvedScheme(theme, "dim")["--mantine-color-dimmed"];
        const mixed = value.match(/^color-mix\(in srgb, (hsl\([^)]+\)) (\d+)%, (hsl\([^)]+\))\)$/);
        if (!mixed) throw new Error(`unparsed ${value}`);
        expect(mixed[1]).toBe(tokens["muted-foreground"]);
        expect(mixed[3]).toBe(tokens.foreground);
        const text = mix(hsl(mixed[1]), hsl(mixed[3]), +mixed[2] / 100);
        const card = hsl(tokens.card);
        const inset = hsl(tokens["surface-inset"]);
        const primary = hsl(tokens.primary);
        const backgrounds = {
            card,
            page: hsl(tokens.background),
            inset,
            currentOnCard: mix(primary, card, 0.1),
            currentOnInset: mix(primary, inset, 0.1),
        };
        const below: string[] = [];
        for (const [name, background] of Object.entries(backgrounds)) {
            const ratio = contrast(text, background);
            if (ratio < 4.5) below.push(`${name}: ${ratio.toFixed(2)}`);
        }
        expect(below).toEqual([]);
    });

    test("every hue a mark carries has a published text colour", () => {
        const hues = new Set(
            Object.values(ANNOTATION_INFO)
                .map(({ color }) => color)
                .filter((color) => color !== undefined && color !== "gray"),
        );
        expect([...hues].sort()).toEqual([...ANNOTATION_HUES].sort());
    });
});
