import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { createAppTheme } from "@/styles/theme";
import ThemeButton from "./ThemeButton";

const scheme = vi.hoisted(() => ({
  current: "auto" as "auto" | "light" | "dark",
  set: vi.fn<(value: string) => void>(),
}));
const variant = vi.hoisted(() => ({
  current: "default" as "default" | "dim",
  set: vi.fn<(value: "default" | "dim") => void>(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("jotai", () => ({
  useAtom: () => [variant.current, variant.set],
}));
vi.mock("@/state/atoms", () => ({
  themeVariantAtom: {},
  isDimActive: (colorScheme: string, variant: string) =>
    colorScheme === "dark" && variant === "dim",
}));
vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  return {
    ...actual,
    useMantineColorScheme: () => ({ colorScheme: scheme.current, setColorScheme: scheme.set }),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  scheme.current = "auto";
  variant.current = "default";
  scheme.set.mockClear();
  variant.set.mockClear();
});

async function renderThemeButton() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MantineProvider theme={theme}>
        <ThemeButton />
      </MantineProvider>,
    ),
  );
  return host;
}

test("offers Auto, Light, Dark and Dim in that order and selects the chosen one", async () => {
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(options.map((option) => option.value)).toEqual(["auto", "light", "dark", "dim"]);
  expect(options.find((option) => option.checked)?.value).toBe("auto");
});

test("selecting dim sets the colour scheme to dark and the variant to dim", async () => {
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  await act(async () => options[3]!.click());
  expect(scheme.set).toHaveBeenLastCalledWith("dark");
  expect(variant.set).toHaveBeenLastCalledWith("dim");
});

test("selecting dark sets the colour scheme to dark and resets the variant", async () => {
  variant.current = "dim";
  scheme.current = "dark";
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  await act(async () => options[2]!.click());
  expect(scheme.set).toHaveBeenLastCalledWith("dark");
  expect(variant.set).toHaveBeenLastCalledWith("default");
});

test("the checked option under dark and dim is dim", async () => {
  scheme.current = "dark";
  variant.current = "dim";
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(options.find((option) => option.checked)?.value).toBe("dim");
});

test("stored dim with scheme auto is checked auto", async () => {
  scheme.current = "auto";
  variant.current = "dim";
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(options.find((option) => option.checked)?.value).toBe("auto");
});

test("stored dim with scheme light is checked light", async () => {
  scheme.current = "light";
  variant.current = "dim";
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(options.find((option) => option.checked)?.value).toBe("light");
});

test("selecting light changes only the colour scheme", async () => {
  const page = await renderThemeButton();
  const options = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  await act(async () => options[1]!.click());
  expect(scheme.set).toHaveBeenLastCalledWith("light");
  expect(variant.set).not.toHaveBeenCalled();
});

// At a large font scale the toggle is wider than a compact Settings card (f-20260829-02): it has
// to stay whole and scroll, centred by auto margins so an overflow never runs off the left edge.
test("keeps the toggle whole in its own horizontal scroller", async () => {
  const page = await renderThemeButton();
  const control = page.querySelector<HTMLElement>(".mantine-SegmentedControl-root")!;
  const scroller = control.parentElement!;
  expect(scroller.style.overflowX).toBe("auto");
  expect(scroller.style.maxWidth).toBe("100%");
  expect(control.style.width).toBe("max-content");
  expect(control.style.marginInline).toBe("auto");
});
