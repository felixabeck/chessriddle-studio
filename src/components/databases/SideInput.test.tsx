import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SupportedLocale } from "@/i18n";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { Sides } from "@/utils/db";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { side: string }) => (options ? `${key}: ${options.side}` : key),
  }),
}));

vi.mock("@mantine/core", () => ({
  Tooltip: ({ children, label }: { children: React.ReactNode; label: React.ReactNode }) => (
    <>
      {children}
      <div role="tooltip">{label}</div>
    </>
  ),
  Menu: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    Item: ({
      children,
      leftSection,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { leftSection?: React.ReactNode }) => (
      <button {...props}>
        {leftSection}
        {children}
      </button>
    ),
    Target: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Dropdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  UnstyledButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

import { SideInput } from "./SideInput";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test.each([
  ["player", "WhiteBlack", "Fen.White", "white"],
  ["opponent", "WhiteBlack", "Fen.Black", "black"],
  ["player", "BlackWhite", "Fen.Black", "black"],
  ["opponent", "BlackWhite", "Fen.White", "white"],
  ["player", "Any", "Board.Database.Local.Result.Any", "any"],
  ["opponent", "Any", "Board.Database.Local.Result.Any", "any"],
] as const)(
  "%s with %s has a labelled, accessible chip and shared menu swatches",
  async (role, sides, label, side) => {
    const setSides = vi.fn();
    await act(async () => {
      root.render(<SideInput role={role} sides={sides} setSides={setSides} />);
    });
    expect(setSides).not.toHaveBeenCalled();
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe(label);
    const accessibleLabel = `Board.Database.Local.${role === "player" ? "PlayerColour" : "OpponentColour"}: ${label}`;
    expect(trigger.getAttribute("aria-label")).toBe(accessibleLabel);
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe(accessibleLabel);
    expect(trigger.querySelector("[data-side]")?.getAttribute("data-side")).toBe(side);
    const swatches = [...container.querySelectorAll("[data-side]")];
    expect(swatches).toHaveLength(4);
    expect(new Set(swatches.map((swatch) => swatch.className)).size).toBe(1);
    expect(swatches.every((swatch) => swatch.getAttribute("aria-hidden") === "true")).toBe(true);
  },
);

test.each([
  ["player", ["WhiteBlack", "BlackWhite", "Any"]],
  ["opponent", ["BlackWhite", "WhiteBlack", "Any"]],
] as const)("%s menu preserves the side mapping", async (role, expected) => {
  const setSides = vi.fn();
  await act(async () => root.render(<SideInput role={role} sides="Any" setSides={setSides} />));
  const items = [...container.querySelectorAll("button")].slice(1);
  for (const [index, item] of items.entries()) {
    await act(async () => item.click());
    expect(setSides).toHaveBeenLastCalledWith(expected[index] as Sides);
  }
});

test.each(shippedCatalogues())(
  "$locale contains every colour-filter message without fallback",
  async ({ locale }) => {
    const i18n = await catalogueI18n(locale as SupportedLocale);
    for (const key of [
      "Board.Database.Local.Player",
      "Board.Database.Local.Opponent",
      "Board.Database.Local.PlayerColour",
      "Board.Database.Local.OpponentColour",
      "Fen.White",
      "Fen.Black",
      "Board.Database.Local.Result.Any",
    ]) {
      expect(i18n.exists(key)).toBe(true);
      const value = i18n.t(key, { side: i18n.t("Fen.Black") });
      expect(value).not.toBe(key);
      expect(value).not.toContain("{{side}}");
    }
  },
);
