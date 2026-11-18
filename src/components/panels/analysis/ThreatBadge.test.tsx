import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { ThreatBadge } from "./ThreatBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = undefined;
});

async function renderBadge(locale: "en-US" | "de-DE", compact: boolean) {
  installMatchMediaStub();
  const i18n = await catalogueI18n(locale);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MantineProvider env="test">
        <I18nextProvider i18n={i18n}>
          <ThreatBadge compact={compact} />
        </I18nextProvider>
      </MantineProvider>,
    ),
  );
  return host.querySelector('[data-testid="threat-badge"]')!;
}

async function hoverTooltip(badge: Element) {
  await act(async () => {
    badge.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    badge.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  let text = "";
  await vi.waitFor(() => {
    text = [...document.querySelectorAll('[role="tooltip"]')]
      .map((node) => node.textContent)
      .join(" ");
    expect(text).not.toBe("");
  });
  return text;
}

test.each([
  ["en-US", "Threat", "not the evaluation of the position"],
  ["de-DE", "Drohung", "nicht die Bewertung der Stellung"],
] as const)(
  "%s badge names the mode and explains its evaluations on hover",
  async (locale, label, hint) => {
    const badge = await renderBadge(locale, false);
    expect(badge.textContent).toBe(label);
    expect(await hoverTooltip(badge)).toContain(hint);
  },
);

test("compact badge is an icon named by the mode with the same explanation", async () => {
  const badge = await renderBadge("en-US", true);
  expect(badge.getAttribute("role")).toBe("img");
  expect(badge.getAttribute("aria-label")).toBe("Threat");
  expect(badge.textContent).toBe("");
  expect(await hoverTooltip(badge)).toContain("not the evaluation of the position");
});

test("every shipped catalogue translates both threat-mode strings", () => {
  const missing = shippedCatalogues().flatMap(({ locale, translation }) =>
    ["Board.Analysis.ThreatMode", "Board.Analysis.ThreatModeHint"]
      .filter((key) => !translation[key])
      .map((key) => `${locale}:${key}`),
  );
  expect(missing).toEqual([]);
});
