import {
    type ActionIcon,
    type Accordion,
    type Autocomplete,
    type Badge,
    type Button,
    type Card,
    type Checkbox,
    type Combobox,
    type CSSVariablesResolver,
    createTheme,
    DEFAULT_THEME,
    defaultVariantColorsResolver,
    getPrimaryShade,
    getThemeColor,
    isLightColor,
    type Input,
    type Menu,
    type Modal,
    type Notification,
    type NumberInput,
    type Paper,
    type PasswordInput,
    type Popover,
    type Progress,
    type RangeSlider,
    type SegmentedControl,
    type Select,
    type Slider,
    type Switch,
    type Tabs,
    type Textarea,
    type TextInput,
    type Tooltip,
    type MantineColorsTuple,
    type MantineTheme,
} from "@mantine/core";
import "./fonts.css";
import buttonClasses from "./Button.module.css";
import actionIconClasses from "./ActionIcon.module.css";
import paperClasses from "./Paper.module.css";
import tabsClasses from "./Tabs.module.css";
import segmentedControlClasses from "./SegmentedControl.module.css";
import inputClasses from "./Input.module.css";
import comboboxClasses from "./Combobox.module.css";
import menuClasses from "./Menu.module.css";
import popoverClasses from "./Popover.module.css";
import checkboxClasses from "./Checkbox.module.css";
import switchClasses from "./Switch.module.css";
import badgeClasses from "./Badge.module.css";
import tooltipClasses from "./Tooltip.module.css";
import sliderClasses from "./Slider.module.css";
import progressClasses from "./Progress.module.css";
import accordionClasses from "./Accordion.module.css";
import modalClasses from "./Modal.module.css";
import notificationClasses from "./Notification.module.css";

/** Copied from ChessRiddle's executable globals.css. Keep values here, not at call sites. */
const light = {
    background: "hsl(48 29% 97.1%)",
    foreground: "hsl(0 0% 16.5%)",
    card: "hsl(0 0% 100%)",
    "card-foreground": "hsl(0 0% 16.5%)",
    popover: "hsl(0 0% 100%)",
    "popover-foreground": "hsl(0 0% 16.5%)",
    "surface-inset": "hsl(40 25% 91%)",
    primary: "hsl(45 76% 24%)",
    "primary-foreground": "hsl(0 0% 100%)",
    secondary: "hsl(40 20% 95.3%)",
    "secondary-foreground": "hsl(30 18% 25%)",
    muted: "hsl(40 22% 93%)",
    "muted-foreground": "hsl(0 0% 53.3%)",
    accent: "hsl(40 20% 95.3%)",
    "accent-foreground": "hsl(30 18% 25%)",
    destructive: "hsl(0 55% 50%)",
    "destructive-foreground": "hsl(0 0% 100%)",
    border: "hsl(42 22.2% 90.6%)",
    "border-strong": "hsl(42 18% 79%)",
    input: "hsl(42 25% 88.2%)",
    ring: "hsl(45 76% 24%)",
    radius: "0.75rem",
    "chart-1": "hsl(42 60% 45%)",
    "chart-2": "hsl(135 45% 40%)",
    "move-correct": "hsl(161 94% 30%)",
    "move-incorrect": "hsl(0 72% 51%)",
    "chart-3": "hsl(0 55% 50%)",
    "chart-4": "hsl(30 25.2% 50.2%)",
    "chart-5": "hsl(43 76.5% 30.8%)",
    "chart-6": "hsl(210 50% 50%)",
    "chart-7": "hsl(280 55% 45%)",
    "chart-8": "hsl(175 55% 35%)",
    "shadow-elevated": "0 8px 24px hsl(0 0% 0% / 0.08)",
    "resize-handle": "hsl(0 0% 0% / 0.5)",
    warning: "hsl(30 80% 55%)",
    "warning-foreground": "hsl(0 0% 100%)",
    "tier-expert": "hsl(199 89% 48%)",
    "tier-skilled": "hsl(45 93% 47%)",
    "tier-apprentice": "hsl(215 14% 58%)",
    "tier-novice": "hsl(26 70% 42%)",
    "eval-bar-dark": "hsl(37 5% 23%)",
    "eval-bar-light": "hsl(37 10% 68%)",
    "eval-bar-center": "hsl(48 91% 44%)",
    interactive: "hsl(40 20% 96%)",
    "interactive-hover": "hsl(40 22% 93%)",
    "bar-hover": "hsl(40 20% 80%)",
    inset: "hsl(40 25% 50% / 0.08)",
    "square-highlight-correct": "hsl(120 50% 60% / 0.6)",
    "square-highlight-wrong": "hsl(0 80% 70% / 0.6)",
    "square-highlight-ring": "hsl(0 0% 100% / 0.8)",
    "shadow-card": "0 2px 8px rgba(0, 0, 0, 0.04)",
    "shadow-card-dark": "0 2px 8px rgba(0, 0, 0, 0.2)",
    "shadow-gold": "0 4px 12px rgba(201, 165, 78, 0.25)",
    "radius-xs": "4px",
    "radius-sm": "8px",
    "radius-md": "12px",
    "radius-lg": "16px",
    "radius-pill": "20px",
    "radius-full": "9999px",
} as const;

const dark = {
    background: "hsl(20 11.1% 5.8%)",
    foreground: "hsl(40 20.7% 88.6%)",
    card: "hsl(30 8.5% 13.5%)",
    "card-foreground": "hsl(40 20.7% 88.6%)",
    popover: "hsl(30 8.5% 13.5%)",
    "popover-foreground": "hsl(40 20.7% 88.6%)",
    "surface-inset": "hsl(30 10% 22%)",
    primary: "hsl(42 53.2% 54.7%)",
    "primary-foreground": "hsl(0 0% 4%)",
    secondary: "hsl(30 8.5% 13.5%)",
    "secondary-foreground": "hsl(40 20.7% 88.6%)",
    muted: "hsl(30 10% 17%)",
    "muted-foreground": "hsl(0 0% 53.3%)",
    accent: "hsl(30 8.5% 13.5%)",
    "accent-foreground": "hsl(42 53.2% 54.7%)",
    destructive: "hsl(0 46.8% 56.5%)",
    "destructive-foreground": "hsl(40 20.7% 88.6%)",
    border: "hsl(30 10.5% 24%)",
    "border-strong": "hsl(30 10% 34%)",
    input: "hsl(30 10.5% 24%)",
    ring: "hsl(42 53.2% 54.7%)",
    radius: "0.75rem",
    "chart-1": "hsl(42 53.2% 54.7%)",
    "chart-2": "hsl(135 26.8% 48.2%)",
    "move-correct": "hsl(158 64% 52%)",
    "move-incorrect": "hsl(0 91% 71%)",
    "chart-3": "hsl(0 46.8% 56.5%)",
    "chart-4": "hsl(30 25.2% 50.2%)",
    "chart-5": "hsl(41 49.2% 36.3%)",
    "chart-6": "hsl(210 40% 55%)",
    "chart-7": "hsl(280 60% 65%)",
    "chart-8": "hsl(175 50% 52%)",
    "shadow-elevated": "0 8px 24px hsl(0 0% 0% / 0.3)",
    "resize-handle": "hsl(0 0% 0% / 0.5)",
    warning: "hsl(30 70% 50%)",
    "warning-foreground": "hsl(0 0% 100%)",
    "tier-expert": "hsl(199 89% 58%)",
    "tier-skilled": "hsl(30 90% 55%)",
    "tier-apprentice": "hsl(215 14% 68%)",
    "tier-novice": "hsl(15 50% 45%)",
    "eval-bar-dark": "hsl(37 5% 23%)",
    "eval-bar-light": "hsl(37 10% 68%)",
    "eval-bar-center": "hsl(48 91% 44%)",
    interactive: "hsl(30 10% 17.5%)",
    "interactive-hover": "hsl(30 12% 24%)",
    "bar-hover": "hsl(30 10% 38%)",
    inset: "hsl(40 20.7% 88.6% / 0.08)",
    "square-highlight-correct": "hsl(120 50% 60% / 0.6)",
    "square-highlight-wrong": "hsl(0 80% 70% / 0.6)",
    "square-highlight-ring": "hsl(0 0% 100% / 0.8)",
    "shadow-card": "0 2px 8px rgba(0, 0, 0, 0.04)",
    "shadow-card-dark": "0 2px 8px rgba(0, 0, 0, 0.2)",
    "shadow-gold": "0 4px 12px rgba(201, 165, 78, 0.25)",
    "radius-xs": "4px",
    "radius-sm": "8px",
    "radius-md": "12px",
    "radius-lg": "16px",
    "radius-pill": "20px",
    "radius-full": "9999px",
} as const;

/** Dim is a variant of dark: ChessRiddle `.dark.dim` surface overrides, same accents. */
const dim = {
    ...dark,
    background: "hsl(30 6% 16%)",
    foreground: "hsl(30 6% 92%)",
    card: "hsl(30 6% 22%)",
    "card-foreground": "hsl(30 6% 92%)",
    popover: "hsl(30 6% 22%)",
    "popover-foreground": "hsl(30 6% 92%)",
    "surface-inset": "hsl(30 6% 29%)",
    secondary: "hsl(30 6% 22%)",
    "secondary-foreground": "hsl(30 6% 92%)",
    muted: "hsl(30 6% 20%)",
    "muted-foreground": "hsl(30 6% 75%)",
    accent: "hsl(30 6% 22%)",
    "destructive-foreground": "hsl(30 6% 92%)",
    border: "hsl(30 6% 33%)",
    "border-strong": "hsl(30 6% 42%)",
    input: "hsl(30 6% 33%)",
    "shadow-elevated": "0 8px 24px hsl(0 0% 0% / 0.5)",
    "eval-bar-dark": "hsl(30 5% 14%)",
    interactive: "hsl(30 6% 25%)",
    "interactive-hover": "hsl(30 6% 31%)",
    // Warm step above dim surface-inset (29%), matching dark's visible lift over inset.
    "bar-hover": "hsl(30 6% 45%)",
    inset: "hsl(30 6% 92% / 0.08)",
} as const;

export const chessRiddleTokens = { light, dark, dim } as const;
export type ChessRiddleScheme = keyof typeof chessRiddleTokens;

/** The hues of the move-quality marks (`ANNOTATION_INFO` in `src/utils/annotation.ts`). */
export const ANNOTATION_HUES = ["cyan", "teal", "lime", "yellow", "orange", "red"] as const;
export type AnnotationHue = (typeof ANNOTATION_HUES)[number];

function isAnnotationHue(color: string): color is AnnotationHue {
    return (ANNOTATION_HUES as readonly string[]).includes(color);
}

/**
 * Text in a mark's hue keeps its meaning (DESIGN.md) but must read at WCAG AA 4.5:1 on the card,
 * the surface-inset variation blocks and the 10% gold current-move fill. In light even shade 9 of
 * yellow and lime stays near 3:1 on white, so the text is shade 6 half-mixed with black; in dark
 * it is shade 3. Dim uses the dark shade except red, which falls below 4.5:1 on the 10% gold fill
 * over dim inset and is mixed toward white.
 */
function annotationTextShade(hue: AnnotationHue, scheme: ChessRiddleScheme) {
    if (scheme === "light") {
        return `color-mix(in srgb, var(--mantine-color-${hue}-6) 50%, black)`;
    }
    if (scheme === "dim" && hue === "red") {
        return "color-mix(in srgb, var(--mantine-color-red-3) 85%, white)";
    }
    return `var(--mantine-color-${hue}-3)`;
}

/** The palettes a mark's board badge or active Annotate button fills: its hue, gray without one. */
export const ANNOTATION_FILLS = [...ANNOTATION_HUES, "gray"] as const;
export type AnnotationFill = (typeof ANNOTATION_FILLS)[number];

/**
 * The glyph or label drawn on a mark's filled colour: black or white, whichever contrasts more with
 * the filled shade (`primaryShade`, light 8 and dark 4). White on these light hues measured down to
 * 1.43:1 (f-20261124-01), and no darker shade lifts yellow above 3:1 under white (d-20261124-03).
 * `isLightColor`'s default threshold is the luminance at which black and white contrast equally.
 */
function annotationFillForeground(
    theme: MantineTheme,
    fill: AnnotationFill,
    scheme: ChessRiddleScheme,
) {
    return isLightColor(
        theme.colors[fill][getPrimaryShade(theme, scheme === "light" ? "light" : "dark")],
    )
        ? "var(--mantine-color-black)"
        : "var(--mantine-color-white)";
}

function schemeVariables(theme: MantineTheme, scheme: ChessRiddleScheme) {
    const tokens = chessRiddleTokens[scheme];
    const variables: Record<string, string> = Object.fromEntries(
        Object.entries(tokens).map(([name, value]) => [`--cf-${name}`, value]),
    );
    Object.assign(variables, {
        "--mantine-color-body": tokens.background,
        "--mantine-color-text": tokens.foreground,
        // The copied muted token stays exact. Secondary text keeps the existing AA intent.
        "--mantine-color-dimmed":
            scheme === "light"
                ? "hsl(0 0% 40%)"
                : `color-mix(in srgb, ${tokens["muted-foreground"]} 65%, ${tokens.foreground})`,
        "--mantine-color-placeholder": "var(--mantine-color-dimmed)",
        "--mantine-color-default": tokens.interactive,
        "--mantine-color-default-hover": tokens["interactive-hover"],
        "--mantine-color-default-color": tokens.foreground,
        "--mantine-color-default-border": tokens.border,
        "--mantine-color-error": tokens.destructive,
        "--mantine-color-anchor": tokens.primary,
        "--mantine-color-disabled": tokens.muted,
        "--mantine-color-disabled-color": "var(--mantine-color-dimmed)",
        "--mantine-color-disabled-border": tokens.border,
    });
    for (const [palette, token] of Object.entries({
        gold: "primary",
        danger: "destructive",
        success: "chart-2",
        warning: "warning",
        info: "chart-6",
    } as const)) {
        const color = tokens[token];
        Object.assign(variables, {
            [`--mantine-color-${palette}-filled`]: color,
            [`--mantine-color-${palette}-filled-hover`]: `color-mix(in srgb, ${color} 90%, transparent)`,
            [`--mantine-color-${palette}-light`]: `color-mix(in srgb, ${color} 10%, transparent)`,
            [`--mantine-color-${palette}-light-hover`]: `color-mix(in srgb, ${color} 20%, transparent)`,
            [`--mantine-color-${palette}-light-color`]: color,
            [`--mantine-color-${palette}-outline`]: color,
            [`--mantine-color-${palette}-outline-hover`]: `color-mix(in srgb, ${color} 10%, transparent)`,
            [`--mantine-color-${palette}-text`]: color,
        });
    }
    for (const hue of ANNOTATION_HUES) {
        variables[`--cf-annotation-${hue}-text`] = annotationTextShade(hue, scheme);
    }
    // The open-variation mark and its count: the info hue, which no move-quality mark uses,
    // shaded to read as text at 4.5:1 on the card, the page and the inset variation blocks.
    // Dim inset is lighter than dark, so the mix leans further toward white.
    variables["--cf-open-variation"] =
        scheme === "light"
            ? `color-mix(in srgb, ${tokens["chart-6"]} 80%, black)`
            : scheme === "dim"
              ? `color-mix(in srgb, ${tokens["chart-6"]} 55%, white)`
              : `color-mix(in srgb, ${tokens["chart-6"]} 70%, white)`;
    for (const fill of ANNOTATION_FILLS) {
        variables[`--cf-annotation-${fill}-on-fill`] = annotationFillForeground(
            theme,
            fill,
            scheme,
        );
    }
    return variables;
}

export const appCssVariablesResolver: CSSVariablesResolver = (theme) => ({
    variables: {},
    light: schemeVariables(theme, "light"),
    dark: schemeVariables(theme, "dark"),
});

const DIM_SELECTOR = ':root[data-mantine-color-scheme="dark"][data-cf-theme-variant="dim"]';

const darkMantineScale: MantineColorsTuple = [
    dark.foreground,
    "#c8c0b4",
    dark["muted-foreground"],
    dark["border-strong"],
    dark.border,
    dark["surface-inset"],
    dark.card,
    dark.background,
    "#0d0b0a",
    "#0a0908",
];

/** Mantine `colors.dark` rebuilt from dim surface tokens. */
const dimMantineScale: MantineColorsTuple = [
    dim.foreground,
    "hsl(30 6% 84%)",
    dim["muted-foreground"],
    dim["border-strong"],
    dim.border,
    dim["surface-inset"],
    dim.card,
    dim.background,
    "hsl(30 6% 12%)",
    "hsl(30 6% 9%)",
];

/** Variables whose dim value differs from dark, including Mantine's dark scale. */
export function dimCssVariableOverrides(theme: MantineTheme): Record<string, string> {
    const darkVariables = schemeVariables(theme, "dark");
    const dimVariables = schemeVariables(theme, "dim");
    const overrides: Record<string, string> = {};
    for (const [name, value] of Object.entries(dimVariables)) {
        if (darkVariables[name] !== value) {
            overrides[name] = value;
        }
    }
    dimMantineScale.forEach((value, index) => {
        if (value !== darkMantineScale[index]) {
            overrides[`--mantine-color-dark-${index}`] = value;
        }
    });
    return overrides;
}

export function dimThemeCss(theme: MantineTheme): string {
    const declarations = Object.entries(dimCssVariableOverrides(theme))
        .map(([name, value]) => `${name}: ${value};`)
        .join(" ");
    return `${DIM_SELECTOR} { ${declarations} }`;
}

/** Media-query em uses the initial font size, so scale it with the app's root font. */
export function scaleBreakpoint(widthEm: number, fontSize: number): string {
    return `${Number((widthEm * (fontSize / 100)).toFixed(10))}em`;
}

/** Shades 8 (light) and 4 (dark) are the exact semantic colours. Named board palettes stay default. */
function semanticPalette(light: string, dark: string): MantineColorsTuple {
    return [
        `color-mix(in srgb, ${light} 8%, white)`,
        `color-mix(in srgb, ${light} 16%, white)`,
        `color-mix(in srgb, ${light} 32%, white)`,
        `color-mix(in srgb, ${dark} 80%, white)`,
        dark,
        `color-mix(in srgb, ${dark} 90%, black)`,
        `color-mix(in srgb, ${light} 80%, white)`,
        `color-mix(in srgb, ${light} 90%, white)`,
        light,
        `color-mix(in srgb, ${light} 80%, black)`,
    ];
}

/** Sole application theme factory. Only behavioural preferences are injected here.
 * Mantine's extend is an identity function. Type-check its input directly to avoid importing
 * every control implementation at startup. Restore the calls if Mantine adds runtime work. */
export function createAppTheme({
    spellCheck,
    fontSize,
}: {
    spellCheck: boolean;
    fontSize: number;
}) {
    const light = chessRiddleTokens.light;
    const dark = chessRiddleTokens.dark;
    const inputClassNames = { input: inputClasses.input };
    return createTheme({
        primaryColor: "gold",
        // Switches, checkboxes and radios are clickable including their labels.
        cursorType: "pointer",
        primaryShade: { light: 8, dark: 4 },
        variantColorResolver: (input) => {
            const resolved = defaultVariantColorsResolver(input);
            const color = input.color ?? "gold";
            if (input.variant === "filled" && color === "gold") {
                return { ...resolved, color: "var(--cf-primary-foreground)" };
            }
            if (input.variant === "filled" && color === "danger") {
                return { ...resolved, color: "var(--cf-destructive-foreground)" };
            }
            if (input.variant === "filled" && isAnnotationHue(color)) {
                // Every filled control in a mark hue (today only the active Annotate button) takes
                // the mark's on-fill foreground. The darker default hover shade drops black under
                // 4.5:1 for cyan, teal and red in light, so the hover fades the fill toward the
                // surface the way gold's does.
                return {
                    ...resolved,
                    hover: `color-mix(in srgb, var(--mantine-color-${color}-filled) 90%, transparent)`,
                    color: `var(--cf-annotation-${color}-on-fill)`,
                };
            }
            return resolved;
        },
        fontFamily: 'Inter, "Inter Fallback", system-ui, sans-serif',
        fontFamilyMonospace: '"JetBrains Mono", "JetBrains Mono Fallback", monospace',
        fontSizes: { xs: "0.75rem", sm: "0.875rem", md: "1rem", lg: "1.125rem", xl: "1.25rem" },
        lineHeights: { xs: "1.5", sm: "1.625", md: "1.625", lg: "1.375", xl: "1.375" },
        headings: {
            fontFamily: 'Inter, "Inter Fallback", system-ui, sans-serif',
            fontWeight: "600",
            sizes: {
                h1: { fontSize: "2.25rem", fontWeight: "700", lineHeight: "1.25" },
                h2: { fontSize: "1.875rem", fontWeight: "700", lineHeight: "1.25" },
                h3: { fontSize: "1.5rem", fontWeight: "700", lineHeight: "1.25" },
                h4: { fontSize: "1.25rem", lineHeight: "1.375" },
                h5: { fontSize: "1.125rem", lineHeight: "1.375" },
                h6: { fontSize: "0.875rem", lineHeight: "1.5" },
            },
        },
        radius: {
            xs: light["radius-xs"],
            sm: light["radius-sm"],
            md: light["radius-md"],
            lg: light["radius-lg"],
            xl: light["radius-full"],
        },
        defaultRadius: "lg",
        shadows: {
            xs: "var(--cf-shadow-card)",
            sm: "var(--cf-shadow-card)",
            md: "var(--cf-shadow-elevated)",
            lg: "var(--cf-shadow-elevated)",
            xl: "var(--cf-shadow-elevated)",
        },
        breakpoints: Object.fromEntries(
            Object.entries(DEFAULT_THEME.breakpoints).map(([key, value]) => [
                key,
                scaleBreakpoint(Number.parseFloat(value), fontSize),
            ]),
        ),
        colors: {
            gold: semanticPalette(light.primary, dark.primary),
            danger: semanticPalette(light.destructive, dark.destructive),
            success: semanticPalette(light["chart-2"], dark["chart-2"]),
            warning: semanticPalette(light.warning, dark.warning),
            info: semanticPalette(light["chart-6"], dark["chart-6"]),
            dark: darkMantineScale,
        },
        components: {
            Button: {
                classNames: { root: buttonClasses.root, label: buttonClasses.label },
                styles: (_theme, props) => {
                    const color = props.color?.split(".")[0] ?? "gold";
                    const accent = color === "gold" || color === "gray";
                    const tone = accent ? "var(--cf-primary)" : getThemeColor(props.color!, _theme);
                    return {
                        root: {
                            "--cf-button-tone": tone,
                            "--cf-button-foreground":
                                color === "gold"
                                    ? "var(--cf-primary-foreground)"
                                    : color === "danger"
                                      ? "var(--cf-destructive-foreground)"
                                      : "var(--button-color)",
                            "--cf-button-secondary-color": accent ? "var(--cf-foreground)" : tone,
                            "--cf-button-ghost-color": accent
                                ? "color-mix(in srgb, var(--cf-foreground) 70%, transparent)"
                                : tone,
                            "--cf-button-focus":
                                props.variant === "filled" || !props.variant
                                    ? tone
                                    : `color-mix(in srgb, ${tone} 30%, transparent)`,
                            "--cf-button-shadow":
                                color === "gold" ? "var(--cf-shadow-gold)" : "none",
                        },
                    };
                },
            } satisfies Parameters<typeof Button.extend>[0],
            ActionIcon: {
                defaultProps: { variant: "transparent", color: "gray" },
                classNames: { root: actionIconClasses.root },
                vars: (_theme, props) =>
                    props.color === "gray"
                        ? { root: { "--ai-color": "var(--cf-foreground)" } }
                        : { root: {} },
            } satisfies Parameters<typeof ActionIcon.extend>[0],
            Card: { classNames: { root: paperClasses.root } } satisfies Parameters<
                typeof Card.extend
            >[0],
            Paper: { classNames: { root: paperClasses.root } } satisfies Parameters<
                typeof Paper.extend
            >[0],
            Tabs: { classNames: tabsClasses } satisfies Parameters<typeof Tabs.extend>[0],
            SegmentedControl: { classNames: segmentedControlClasses } satisfies Parameters<
                typeof SegmentedControl.extend
            >[0],
            Input: {
                classNames: inputClassNames,
                defaultProps: {
                    // Mantine forwards the native attribute but omits it from its generic Input type.
                    // @ts-expect-error Mantine forwards native input attributes.
                    spellCheck,
                },
            } satisfies Parameters<typeof Input.extend>[0],
            InputWrapper: {
                classNames: { label: inputClasses.label, description: inputClasses.description },
            },
            TextInput: {
                defaultProps: { spellCheck },
                classNames: inputClassNames,
            } satisfies Parameters<typeof TextInput.extend>[0],
            Textarea: {
                defaultProps: { spellCheck },
                classNames: inputClassNames,
            } satisfies Parameters<typeof Textarea.extend>[0],
            Autocomplete: {
                defaultProps: { spellCheck },
                // Its Combobox resolves classNames under the "Autocomplete" selector, so the
                // shared option styles reach it only through this entry, as for Select.
                classNames: { ...comboboxClasses, ...inputClassNames },
            } satisfies Parameters<typeof Autocomplete.extend>[0],
            NumberInput: { classNames: inputClassNames } satisfies Parameters<
                typeof NumberInput.extend
            >[0],
            PasswordInput: { classNames: inputClassNames } satisfies Parameters<
                typeof PasswordInput.extend
            >[0],
            // Style the dates package without pulling its calendar into the startup bundle.
            DateInput: { classNames: inputClassNames },
            Select: {
                classNames: { ...comboboxClasses, input: inputClasses.trigger },
            } satisfies Parameters<typeof Select.extend>[0],
            Combobox: { classNames: comboboxClasses } satisfies Parameters<
                typeof Combobox.extend
            >[0],
            Menu: { classNames: menuClasses } satisfies Parameters<typeof Menu.extend>[0],
            Popover: { classNames: popoverClasses } satisfies Parameters<typeof Popover.extend>[0],
            Checkbox: { classNames: checkboxClasses } satisfies Parameters<
                typeof Checkbox.extend
            >[0],
            Switch: { classNames: switchClasses } satisfies Parameters<typeof Switch.extend>[0],
            Badge: {
                defaultProps: { variant: "light", color: "gray" },
                classNames: badgeClasses,
                styles: (_theme, props) => {
                    const color = props.color?.split(".")[0] ?? "gold";
                    return {
                        root: {
                            "--cf-badge-tone":
                                color === "warning"
                                    ? "var(--cf-chart-4)"
                                    : color === "info"
                                      ? "var(--cf-chart-1)"
                                      : color === "gray"
                                        ? "var(--mantine-color-dimmed)"
                                        : getThemeColor(props.color ?? "gold", _theme),
                            "--cf-badge-background":
                                color === "gray"
                                    ? "var(--cf-muted)"
                                    : color === "gold"
                                      ? "color-mix(in srgb, var(--cf-primary) 10%, transparent)"
                                      : "color-mix(in srgb, var(--cf-badge-tone) 20%, transparent)",
                            "--cf-badge-border":
                                color === "gray"
                                    ? "transparent"
                                    : `color-mix(in srgb, var(--cf-badge-tone) ${color === "gold" ? 20 : 30}%, transparent)`,
                            "--cf-badge-foreground":
                                color === "gold"
                                    ? "var(--cf-primary-foreground)"
                                    : "var(--badge-color)",
                        },
                    };
                },
            } satisfies Parameters<typeof Badge.extend>[0],
            Tooltip: { classNames: tooltipClasses } satisfies Parameters<typeof Tooltip.extend>[0],
            Slider: { classNames: sliderClasses } satisfies Parameters<typeof Slider.extend>[0],
            RangeSlider: { classNames: sliderClasses } satisfies Parameters<
                typeof RangeSlider.extend
            >[0],
            Progress: { classNames: progressClasses } satisfies Parameters<
                typeof Progress.extend
            >[0],
            Accordion: { classNames: accordionClasses } satisfies Parameters<
                typeof Accordion.extend
            >[0],
            Modal: { classNames: modalClasses } satisfies Parameters<typeof Modal.extend>[0],
            Notification: { classNames: notificationClasses } satisfies Parameters<
                typeof Notification.extend
            >[0],
        },
    });
}
