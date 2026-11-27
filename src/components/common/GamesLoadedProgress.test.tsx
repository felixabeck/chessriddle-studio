import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { catalogueI18n } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { GamesLoadedProgress, type GamesLoadedProgressProps } from "./GamesLoadedProgress";

const i18nState = vi.hoisted(() => ({
  language: "en-US",
  t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => i18nState.t(key, options),
    i18n: { language: i18nState.language },
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let container: HTMLDivElement;
let root: Root;

async function useLocale(locale: "en-US" | "de-DE") {
  const instance = await catalogueI18n(locale);
  i18nState.language = locale;
  i18nState.t = (key, options) => instance.t(key, options);
}

async function renderProgress(props: GamesLoadedProgressProps) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <GamesLoadedProgress {...props} />
      </MantineProvider>,
    );
  });
}

function statusText() {
  return container.querySelector<HTMLElement>('[role="status"]')?.textContent ?? "";
}

function progressbar() {
  return container.querySelector<HTMLElement>('[role="progressbar"]')!;
}

beforeEach(async () => {
  await useLocale("en-US");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("GamesLoadedProgress", () => {
  test("running with a total renders the 'of' line and proportional animated bar", async () => {
    await renderProgress({ count: 1234, total: 5678, phase: "running" });

    expect(statusText()).toBe("1,234 of 5,678 games loaded");
    expect(statusText()).not.toContain("%");
    const bar = progressbar();
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo((1234 / 5678) * 100, 3);
    expect(bar.dataset.animated).toBe("true");
  });

  test("running without a total renders count only and a full animated bar", async () => {
    await renderProgress({ count: 1234, phase: "running" });

    expect(statusText()).toBe("1,234 games loaded");
    const bar = progressbar();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.dataset.animated).toBe("true");
  });

  test("running before the first count renders 'Loading games…' even when a total is given", async () => {
    await renderProgress({ count: null, total: 5678, phase: "running" });

    expect(statusText()).toBe("Loading games…");
    const bar = progressbar();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.dataset.animated).toBe("true");
  });

  test.each(["succeeded", "failed", "cancelled"] as const)(
    "terminal phase %s without a count renders '0 games loaded'",
    async (phase) => {
      await renderProgress({ count: null, total: 500, phase });

      expect(statusText()).toBe("0 games loaded");
      const bar = progressbar();
      expect(bar.getAttribute("aria-valuenow")).toBe(phase === "succeeded" ? "100" : "0");
      expect(bar.dataset.animated).toBeUndefined();
    },
  );

  test("total of 0 falls back to count only with no NaN in aria-valuenow or width", async () => {
    await renderProgress({ count: 0, total: 0, phase: "running" });

    expect(statusText()).toBe("0 games loaded");
    const bar = progressbar();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).not.toContain("NaN");
    expect(bar.style.width).not.toContain("NaN");
  });

  test("count above total falls back to count only and full animated bar", async () => {
    await renderProgress({ count: 6000, total: 5678, phase: "running" });

    expect(statusText()).toBe("6,000 games loaded");
    const bar = progressbar();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.dataset.animated).toBe("true");
  });

  test("succeeded renders the final count with a full static bar even when below total", async () => {
    await renderProgress({ count: 4000, total: 5678, phase: "succeeded" });

    expect(statusText()).toBe("4,000 games loaded");
    const bar = progressbar();
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.dataset.animated).toBeUndefined();
    expect(bar.dataset.striped).toBeUndefined();
  });

  test.each(["failed", "cancelled"] as const)(
    "%s renders the last count with an unfilled static bar",
    async (phase) => {
      await renderProgress({ count: 1234, total: 5678, phase });

      expect(statusText()).toBe("1,234 games loaded");
      const bar = progressbar();
      expect(bar.getAttribute("aria-valuenow")).toBe("0");
      expect(bar.dataset.animated).toBeUndefined();
      expect(bar.dataset.striped).toBeUndefined();
    },
  );

  test("groups numbers according to the interface language", async () => {
    await useLocale("de-DE");
    await renderProgress({ count: 1234, total: 5678, phase: "running" });
    expect(statusText()).toBe("1.234 von 5.678 Partien geladen");

    await renderProgress({ count: 1234, phase: "running" });
    expect(statusText()).toBe("1.234 Partien geladen");

    await renderProgress({ count: null, total: 5678, phase: "running" });
    expect(statusText()).toBe("Partien werden geladen …");
  });
});
