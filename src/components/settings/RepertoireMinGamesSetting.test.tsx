import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import RepertoireMinGamesSetting from "./RepertoireMinGamesSetting";
import { SettingRow } from "./SettingsLayout";

const language = vi.hoisted(() => ({ current: "en-US" }));
const minGames = vi.hoisted(() => ({
  current: 50,
  set: vi.fn(),
  // Writes the atom from outside the component, as another settings surface would.
  external: null as ((next: number) => void) | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key.split(".").at(-1) ?? key,
    i18n: { language: language.current },
  }),
}));
// Backed by real component state so a write re-renders with the new value,
// the way the atom does; `minGames.set` records every write.
vi.mock("jotai", async () => {
  const { useState } = await import("react");
  return {
    useAtom: () => {
      const [value, setValue] = useState(minGames.current);
      minGames.external = setValue;
      return [
        value,
        (next: number) => {
          minGames.set(next);
          setValue(next);
        },
      ];
    },
  };
});
vi.mock("@/state/atoms", () => ({ coverageMinGamesAtom: {} }));
// The free-entry field is Mantine's real NumberInput, so its number-or-string
// onChange and its blur normalisation (clamp to `min`, trim leading zeros)
// are the ones the app ships. The preset select stays a plain <select>.
vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  return {
    MantineProvider: actual.MantineProvider,
    NumberInput: actual.NumberInput,
    Group: ({ children }: any) => <div>{children}</div>,
    Text: ({ children }: any) => <span>{children}</span>,
    Select: ({ data, value, onChange, "aria-label": ariaLabel }: any) => (
      <select
        data-testid="preset"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {data.map((option: { value: string; label: string }) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

installMatchMediaStub();
installResizeObserverStub();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  language.current = "en-US";
  minGames.current = 50;
  minGames.set = vi.fn();
  minGames.external = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(node: ReactNode = <RepertoireMinGamesSetting />) {
  await act(async () => root.render(<MantineProvider env="test">{node}</MantineProvider>));
}

function customField() {
  return host.querySelector<HTMLInputElement>(".mantine-NumberInput-input");
}

function labels() {
  return [...host.querySelectorAll("option")].map((option) => option.textContent);
}

test("labels every preset with its game count and selects the matching preset", async () => {
  minGames.current = 200;
  await mount();

  expect(labels()).toEqual(["Essential (200)", "Standard (50)", "Deep (20)", "Custom"]);
  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("essential");
  // A preset value must never open the free-entry field.
  expect(customField()).toBeNull();
});

test("renders the same preset counts under a different locale", async () => {
  // None of the three preset counts reaches a grouping boundary, so every
  // supported locale renders them identically. This pins that fact rather than
  // pretending it proves locale-aware formatting; VolumeSlider covers that claim
  // with values that genuinely differ.
  language.current = "de-DE";
  await mount();

  expect(labels()).toEqual(["Essential (200)", "Standard (50)", "Deep (20)", "Custom"]);
});

test("treats a value that matches no preset as custom and exposes the free-entry field", async () => {
  minGames.current = 137;
  await mount();

  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("custom");
  expect(customField()?.value).toBe("137");
});

test("writes the preset's game count when a preset is chosen", async () => {
  await mount();

  const select = host.querySelector<HTMLSelectElement>("[data-testid=preset]")!;
  await act(async () => {
    select.value = "deep";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(minGames.set).toHaveBeenCalledWith(20);
});

test("gives the preset select the SettingRow title as its accessible name", async () => {
  await mount(
    <SettingRow title="Minimum games" description="d">
      <RepertoireMinGamesSetting />
    </SettingRow>,
  );

  expect(host.querySelector("[data-testid=preset]")?.getAttribute("aria-label")).toBe(
    "Minimum games",
  );
});

test("gives the custom min-games input the SettingRow title as its accessible name", async () => {
  minGames.current = 37;
  await mount(
    <SettingRow title="Minimum games" description="d">
      <RepertoireMinGamesSetting />
    </SettingRow>,
  );

  expect(customField()?.getAttribute("aria-label")).toBe("Minimum games");
});

test("keeps the stored value when switching to custom", async () => {
  await mount();

  const select = host.querySelector<HTMLSelectElement>("[data-testid=preset]")!;
  await act(async () => {
    select.value = "custom";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(minGames.set).not.toHaveBeenCalled();
  expect(customField()).not.toBeNull();
});

async function typeCustom(value: string) {
  const input = customField();
  if (!input) throw new Error(`custom field is gone before typing ${JSON.stringify(value)}`);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blurCustom() {
  const input = customField()!;
  await act(async () => {
    input.focus();
    input.blur();
  });
}

function presetValue() {
  return host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value;
}

test("stays on custom while typing through a preset's value", async () => {
  minGames.current = 7;
  await mount();

  for (const keystrokes of ["5", "50", "500"]) await typeCustom(keystrokes);

  expect(presetValue()).toBe("custom");
  expect(customField()?.value).toBe("500");
  expect(minGames.set).toHaveBeenLastCalledWith(500);
});

test("leaves the stored minimum alone while the custom field is empty or zero", async () => {
  minGames.current = 7;
  await mount();

  for (const draft of ["", "0", "00"]) await typeCustom(draft);

  expect(minGames.set).not.toHaveBeenCalled();
  expect(presetValue()).toBe("custom");
  expect(customField()).not.toBeNull();
});

test("does not store a number beyond the safe integer range", async () => {
  minGames.current = 7;
  await mount();

  await typeCustom("90071992547409920");
  await blurCustom();

  expect(minGames.set).not.toHaveBeenCalled();
});

test("shows the stored minimum again when an emptied field loses focus", async () => {
  minGames.current = 7;
  await mount();

  await typeCustom("");
  expect(customField()?.value).toBe("");
  await blurCustom();

  expect(customField()?.value).toBe("7");
  expect(minGames.set).not.toHaveBeenCalled();
});

test("stores the field's own normalisation of a zero or leading-zero draft on blur", async () => {
  minGames.current = 7;
  await mount();

  await typeCustom("0");
  await blurCustom();
  expect(minGames.set).toHaveBeenLastCalledWith(1);
  expect(customField()?.value).toBe("1");

  await typeCustom("05");
  await blurCustom();
  expect(minGames.set).toHaveBeenLastCalledWith(5);
  expect(customField()?.value).toBe("5");
});

test("drops an unfinished custom draft when a preset is chosen", async () => {
  minGames.current = 7;
  await mount();
  await typeCustom("");

  const select = host.querySelector<HTMLSelectElement>("[data-testid=preset]")!;
  for (const preset of ["deep", "custom"]) {
    await act(async () => {
      select.value = preset;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  expect(customField()?.value).toBe("20");
});

test("follows an outside change of the minimum while a preset is selected", async () => {
  await mount();
  expect(presetValue()).toBe("standard");

  await act(async () => minGames.external!(20));
  expect(presetValue()).toBe("deep");

  await act(async () => minGames.external!(137));
  expect(presetValue()).toBe("custom");
  expect(customField()?.value).toBe("137");
});
