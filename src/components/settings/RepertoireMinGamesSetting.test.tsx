import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
vi.mock("@mantine/core", () => ({
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
  // Mantine 8 passes a number for a complete numeric entry and the raw string
  // for an empty, leading-zero or over-long (14+ digit) draft.
  NumberInput: ({ value, onChange, onBlur, "aria-label": ariaLabel }: any) => (
    <input
      data-testid="custom"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => {
        const text = event.target.value;
        onChange(/^(0|[1-9]\d{0,12})$/.test(text) ? Number(text) : text);
      }}
      onBlur={onBlur}
    />
  ),
}));

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

function labels() {
  return [...host.querySelectorAll("option")].map((option) => option.textContent);
}

test("labels every preset with its game count and selects the matching preset", async () => {
  minGames.current = 200;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  expect(labels()).toEqual(["Essential (200)", "Standard (50)", "Deep (20)", "Custom"]);
  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("essential");
  // A preset value must never open the free-entry field.
  expect(host.querySelector("[data-testid=custom]")).toBeNull();
});

test("renders the same preset counts under a different locale", async () => {
  // None of the three preset counts reaches a grouping boundary, so every
  // supported locale renders them identically. This pins that fact rather than
  // pretending it proves locale-aware formatting; VolumeSlider covers that claim
  // with values that genuinely differ.
  language.current = "de-DE";
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  expect(labels()).toEqual(["Essential (200)", "Standard (50)", "Deep (20)", "Custom"]);
});

test("treats a value that matches no preset as custom and exposes the free-entry field", async () => {
  minGames.current = 137;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("custom");
  expect(host.querySelector<HTMLInputElement>("[data-testid=custom]")?.value).toBe("137");
});

test("writes the preset's game count when a preset is chosen", async () => {
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  const select = host.querySelector<HTMLSelectElement>("[data-testid=preset]")!;
  await act(async () => {
    select.value = "deep";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(minGames.set).toHaveBeenCalledWith(20);
});

test("gives the preset select the SettingRow title as its accessible name", async () => {
  await act(async () =>
    root.render(
      <SettingRow title="Minimum games" description="d">
        <RepertoireMinGamesSetting />
      </SettingRow>,
    ),
  );

  expect(host.querySelector("[data-testid=preset]")?.getAttribute("aria-label")).toBe(
    "Minimum games",
  );
});

test("gives the custom min-games input the SettingRow title as its accessible name", async () => {
  minGames.current = 37;
  await act(async () =>
    root.render(
      <SettingRow title="Minimum games" description="d">
        <RepertoireMinGamesSetting />
      </SettingRow>,
    ),
  );

  expect(host.querySelector("[data-testid=custom]")?.getAttribute("aria-label")).toBe(
    "Minimum games",
  );
});

test("keeps the stored value when switching to custom", async () => {
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  const select = host.querySelector<HTMLSelectElement>("[data-testid=preset]")!;
  await act(async () => {
    select.value = "custom";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(minGames.set).not.toHaveBeenCalled();
  expect(host.querySelector("[data-testid=custom]")).not.toBeNull();
});

async function typeCustom(value: string) {
  const input = host.querySelector<HTMLInputElement>("[data-testid=custom]");
  if (!input) throw new Error(`custom field is gone before typing ${JSON.stringify(value)}`);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("stays on custom while typing through a preset's value", async () => {
  minGames.current = 7;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  for (const keystrokes of ["5", "50", "500"]) await typeCustom(keystrokes);

  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("custom");
  expect(host.querySelector<HTMLInputElement>("[data-testid=custom]")?.value).toBe("500");
  expect(minGames.set).toHaveBeenLastCalledWith(500);
});

test("leaves the stored minimum alone while the custom field is empty", async () => {
  minGames.current = 7;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  await typeCustom("");

  expect(minGames.set).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value).toBe("custom");
  expect(host.querySelector("[data-testid=custom]")).not.toBeNull();
});

test("does not store zero, a leading-zero draft or an unsafe integer", async () => {
  minGames.current = 7;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  for (const draft of ["0", "05", "90071992547409920"]) await typeCustom(draft);

  expect(minGames.set).not.toHaveBeenCalled();
});

test("shows the stored minimum again when a rejected draft loses focus", async () => {
  minGames.current = 7;
  await act(async () => root.render(<RepertoireMinGamesSetting />));

  await typeCustom("");
  expect(host.querySelector<HTMLInputElement>("[data-testid=custom]")?.value).toBe("");

  const input = host.querySelector<HTMLInputElement>("[data-testid=custom]")!;
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  expect(host.querySelector<HTMLInputElement>("[data-testid=custom]")?.value).toBe("7");
});

test("follows an outside change of the minimum while a preset is selected", async () => {
  await act(async () => root.render(<RepertoireMinGamesSetting />));
  const select = () => host.querySelector<HTMLSelectElement>("[data-testid=preset]")?.value;
  expect(select()).toBe("standard");

  await act(async () => minGames.external!(20));
  expect(select()).toBe("deep");

  await act(async () => minGames.external!(137));
  expect(select()).toBe("custom");
  expect(host.querySelector<HTMLInputElement>("[data-testid=custom]")?.value).toBe("137");
});
