// @vitest-environment node
import { describe, expect, test } from "vitest";
import { supportedLocales } from "../src/i18n.ts";
import config, { helpTopicChunkName } from "../vite.config.ts";

const nonEnglishLocales = supportedLocales.filter(
  (locale) => locale !== "en-US" && locale !== "en-GB",
);

describe("helpTopicChunkName", () => {
  test("groups translated topic markdown modules into one chunk per locale", () => {
    expect(nonEnglishLocales.length).toBe(14);
    for (const locale of nonEnglishLocales) {
      expect(
        helpTopicChunkName(`/repo/src/components/assistant/topics/${locale}/databases.md`),
      ).toBe(`help-topics-${locale}`);
      expect(
        helpTopicChunkName(`/repo/src/components/assistant/topics/${locale}/ai-connections.md?raw`),
      ).toBe(`help-topics-${locale}`);
      expect(
        helpTopicChunkName(
          `C:\\repo\\src\\components\\assistant\\topics\\${locale}\\settings.md?raw`,
        ),
      ).toBe(`help-topics-${locale}`);
    }
  });

  test("returns null for English topics, the English bundle, and unrelated modules", () => {
    expect(helpTopicChunkName("/repo/src/components/assistant/topics/databases.md")).toBeNull();
    expect(helpTopicChunkName("/repo/src/components/assistant/topics/databases.md?raw")).toBeNull();
    expect(helpTopicChunkName("/repo/src/components/assistant/topics/bundle.ts")).toBeNull();
    expect(helpTopicChunkName("/repo/src/components/settings/SettingsPage.tsx")).toBeNull();
  });

  test("is wired into Vite build codeSplitting groups", () => {
    expect(config.build?.rollupOptions?.output?.codeSplitting?.groups).toEqual([
      { name: helpTopicChunkName },
    ]);
  });
});
