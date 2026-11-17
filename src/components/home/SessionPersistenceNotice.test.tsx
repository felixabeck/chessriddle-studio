import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import type { i18n as I18n } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import enUS from "@/translation/en-US.json";
import { getSessionPersistenceSnapshot, savePublicSessions } from "@/utils/session";
import { deserializeStorageValue } from "@/state/store/debouncedStorage";
import { SessionPersistenceNotice } from "./SessionPersistenceNotice";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  localStorage.clear();
  savePublicSessions([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderNotice(i18n: I18n) {
  await act(async () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <SessionPersistenceNotice />
        </MantineProvider>
      </I18nextProvider>,
    ),
  );
}

function refuseWrites() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("private-notice-token", "QuotaExceededError");
  });
}

test("stays visible after failed retry and later edits, then saves the latest list and disappears", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    fallbackLng: false,
    keySeparator: false,
    resources: { "en-US": enUS },
  });
  await renderNotice(i18n);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const refusal = refuseWrites();
  await act(async () => {
    savePublicSessions([{ alias: "Original alias", updatedAt: 1 }]);
  });
  expect(host.textContent).toContain(enUS.translation["Accounts.Persistence.Unsaved"]);
  await act(async () => host.querySelector("button")?.click());
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await renderNotice(i18n);
  await act(async () => {
    savePublicSessions([{ alias: "Latest alias", updatedAt: 2 }]);
  });
  expect(host.textContent).not.toContain("private-notice-token");
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(host.querySelector("button")?.textContent).toBe("Try saving again");
  refusal.mockRestore();
  await act(async () => host.querySelector("button")?.click());
  expect(getSessionPersistenceSnapshot().status).toBe("saved");
  expect(deserializeStorageValue(localStorage.getItem("sessions")!)).toEqual([
    { alias: "Latest alias", updatedAt: 2 },
  ]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);
test.each(Object.entries(catalogues))(
  "uses shipped %s recovery copy with fallback disabled",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)?.replace(".json", "") ?? "";
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    refuseWrites();
    savePublicSessions([]);
    await renderNotice(i18n);
    for (const key of [
      "Accounts.Persistence.Title",
      "Accounts.Persistence.Unsaved",
      "Accounts.Persistence.TryAgain",
    ]) {
      expect(catalogue.translation[key]).toBeTruthy();
      expect(host.textContent).toContain(catalogue.translation[key]);
    }
  },
);

test.each([false, true])(
  "uses readable shipped copy when localization is unavailable (initialized: %s)",
  async (initialized) => {
    refuseWrites();
    savePublicSessions([]);
    const i18n = createInstance();
    if (initialized)
      await i18n.init({ lng: "de-DE", fallbackLng: false, keySeparator: false, resources: {} });
    await renderNotice(i18n);
    expect(host.textContent).toContain(enUS.translation["Accounts.Persistence.Title"]);
    expect(host.textContent).toContain(enUS.translation["Accounts.Persistence.Unsaved"]);
    expect(host.querySelector("button")?.textContent).toBe(
      enUS.translation["Accounts.Persistence.TryAgain"],
    );
  },
);
