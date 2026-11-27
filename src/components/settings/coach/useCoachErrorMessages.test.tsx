import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { expect, test } from "vitest";
import type { SupportedLocale } from "@/i18n";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import {
  useAssistantErrorMessages,
  useCoachErrorMessages,
  useScoresheetErrorMessages,
} from "./useCoachErrorMessages";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Lookup data, never literal t calls: tests must not seed the extractor for production.
const TIMEOUT_KEY = "Coach.Error.ProviderTimeout";
const FAILURE_KEY = "Coach.Error.ProviderFailure";

const catalogues = shippedCatalogues();

test.each(catalogues.map(({ locale }) => locale))(
  "every error surface shows the provider timeout in its own words in %s",
  async (locale) => {
    const translation = catalogues.find((entry) => entry.locale === locale)!.translation;
    const i18n = await catalogueI18n(locale as SupportedLocale);
    const seen: string[] = [];
    function Probe() {
      seen.push(
        useCoachErrorMessages().providerTimeout,
        useAssistantErrorMessages().providerTimeout,
        useScoresheetErrorMessages().providerTimeout,
      );
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <Probe />
        </I18nextProvider>,
      );
    });
    act(() => root.unmount());

    const expected = translation[TIMEOUT_KEY];
    expect(expected?.trim()).toBeTruthy();
    expect(expected).not.toBe(translation[FAILURE_KEY]);
    expect(seen.slice(-3)).toEqual([expected, expected, expected]);
  },
);
