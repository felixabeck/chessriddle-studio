import { createInstance } from "i18next";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CoachCommandError } from "@/platform/coach";
import { formatScoresheetIntakeCounts } from "@/state/scoresheetPhotos";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import ImportPhotoPane from "./ImportPhotoPane";

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  warnSafely: vi.fn(),
  coachAvailable: vi.fn(),
  coachHasConnection: vi.fn(),
  scoresheetPickPhotos: vi.fn(),
  scoresheetPastePhoto: vi.fn(),
  scoresheetTakeDroppedPhotos: vi.fn(),
  dropRegistrationError: null as Error | null,
  dropListeners: new Set<(event: { payload: { drop: string } }) => void>(),
  unlistenCount: 0,
}));

vi.mock("@/platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/errors")>()),
  warnSafely: (message: string) => mocks.warnSafely(message),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    coachAvailable: () => mocks.coachAvailable(),
    coachHasConnection: () => mocks.coachHasConnection(),
    scoresheetPickPhotos: () => mocks.scoresheetPickPhotos(),
    scoresheetPastePhoto: () => mocks.scoresheetPastePhoto(),
    scoresheetTakeDroppedPhotos: (drop: string) => mocks.scoresheetTakeDroppedPhotos(drop),
  },
  tauriSubscriptions: {
    scoresheetPhotosDropped: async (callback: (event: { payload: { drop: string } }) => void) => {
      if (mocks.dropRegistrationError) {
        throw mocks.dropRegistrationError;
      }
      mocks.dropListeners.add(callback);
      return () => {
        mocks.dropListeners.delete(callback);
        mocks.unlistenCount += 1;
      };
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const parts = Object.entries(options)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      return `${key}(${parts})`;
    },
  }),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => null;
  return {
    ...(await importOriginal<typeof import("lucide-react")>()),
    Clipboard: Icon,
    ImagePlus: Icon,
    X: Icon,
  };
});

vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, ...props }: any) => (
    <button type="button" aria-label={label} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@mantine/core", () => ({
  Button: ({ children, leftSection, ...props }: any) => (
    <button type="button" {...props}>
      {leftSection}
      {children}
    </button>
  ),
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Text: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PHOTO_1 = "data:image/jpeg;base64,AAAA";
const PHOTO_2 = "data:image/jpeg;base64,BBBB";
const PHOTO_3 = "data:image/jpeg;base64,CCCC";
const PHOTO_4 = "data:image/jpeg;base64,DDDD";
const PHOTO_5 = "data:image/jpeg;base64,EEEE";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dropRegistrationError = null;
  mocks.dropListeners.clear();
  mocks.unlistenCount = 0;
  mocks.coachAvailable.mockResolvedValue(true);
  mocks.coachHasConnection.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderPane(options?: { hasConnection?: boolean; onClose?: () => void }) {
  mocks.coachAvailable.mockResolvedValue(true);
  mocks.coachHasConnection.mockResolvedValue(options?.hasConnection ?? true);
  const store = createStore();
  await act(async () => {
    root.render(
      <Provider store={store}>
        <ImportPhotoPane onClose={options?.onClose} />
      </Provider>,
    );
  });
  // Flush loadable coachAvailableAtom + refreshAssistantAvailabilityAtom microtasks.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return store;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

test("without a connection shows hint, navigates to AI settings, and subscribes to no drop events", async () => {
  const onClose = vi.fn();
  const store = await renderPane({ hasConnection: false, onClose });

  expect(host.querySelector("[data-scoresheet-no-connection]")?.textContent).toContain(
    "Scoresheet.Intake.NeedsConnection",
  );
  expect(host.querySelector("[data-scoresheet-intake-pane]")).toBeNull();
  expect(mocks.dropListeners.size).toBe(0);

  await act(async () => {
    buttonByText("Scoresheet.Intake.OpenAiSettings").click();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(store.get(settingsNavigationRequestAtom)).toMatchObject({
    target: {
      kind: "category",
      category: "coach",
    },
  });
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings" });
});

test("choosing photos appends thumbnails in order, removes one, caps at 4, and reports skipped/failed", async () => {
  await renderPane({ hasConnection: true });

  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }, { dataUrl: PHOTO_2 }],
    skipped: 0,
    failed: 1,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });

  let images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([PHOTO_1, PHOTO_2]);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Failed(count=1)",
  );

  // Remove first photo.
  const removeBtn = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Scoresheet.Intake.RemovePhoto(number=1)"]',
  )!;
  await act(async () => {
    removeBtn.click();
  });
  images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([PHOTO_2]);

  // Add 4 more while 1 is present -> 3 accepted (cap 4), 1 extra skipped + 1 native skipped = 2 skipped.
  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [
      { dataUrl: PHOTO_1 },
      { dataUrl: PHOTO_3 },
      { dataUrl: PHOTO_4 },
      { dataUrl: PHOTO_5 },
    ],
    skipped: 1,
    failed: 0,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });

  images = Array.from(host.querySelectorAll("img"));
  expect(images.map((img) => img.getAttribute("src"))).toEqual([
    PHOTO_2,
    PHOTO_1,
    PHOTO_3,
    PHOTO_4,
  ]);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Skipped(count=2)",
  );
});

test("paste button and Ctrl/Cmd+V paste when no text field is focused, and respect quiet/error codes", async () => {
  await renderPane({ hasConnection: true });

  // Ctrl+V inside an input does not trigger native paste.
  const input = document.createElement("input");
  host.append(input);
  input.focus();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).not.toHaveBeenCalled();
  input.blur();

  // Ctrl+V with no text field focused triggers native paste.
  mocks.scoresheetPastePhoto.mockResolvedValueOnce({ dataUrl: PHOTO_1 });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll("img")).toHaveLength(1);

  // clipboardEmpty shown on intake line.
  mocks.scoresheetPastePhoto.mockRejectedValueOnce(new CoachCommandError("clipboardEmpty"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.PasteFromClipboard").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Coach.Error.ClipboardEmpty",
  );

  // Quiet cancelled clears/shows nothing on intake line.
  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("cancelled"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();

  // An intake error other than the named ones (e.g. unavailable -> Scoresheet.Error.Unavailable) is shown.
  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("unavailable"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Error.Unavailable",
  );

  // Another non-named error (network) also renders on the intake line.
  mocks.scoresheetPastePhoto.mockRejectedValueOnce(new CoachCommandError("network"));
  await act(async () => {
    buttonByText("Scoresheet.Intake.PasteFromClipboard").click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Coach.Error.Network",
  );

  // Fill up to 4 photos, then Ctrl+V reports skipped=1 without calling scoresheetPastePhoto.
  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_2 }, { dataUrl: PHOTO_3 }, { dataUrl: PHOTO_4 }],
    skipped: 0,
    failed: 0,
  });
  await act(async () => {
    buttonByText("Scoresheet.Intake.ChoosePhotos").click();
  });
  expect(host.querySelectorAll("img")).toHaveLength(4);
  mocks.scoresheetPastePhoto.mockClear();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
  });
  expect(mocks.scoresheetPastePhoto).not.toHaveBeenCalled();
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Skipped(count=1)",
  );

  // formatScoresheetIntakeCounts joins both skipped and failed when both are > 0.
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key}(${Object.entries(options ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",")})`;
  expect(formatScoresheetIntakeCounts({ skipped: 2, failed: 1 }, t)).toBe(
    "Scoresheet.Intake.Skipped(count=2) Scoresheet.Intake.Failed(count=1)",
  );
});

test("drop subscription takes dropped photos while open, shows visible errors, stays quiet on notFound, and unsubscribes on unmount", async () => {
  await renderPane({ hasConnection: true });
  expect(mocks.dropListeners.size).toBe(1);

  mocks.scoresheetTakeDroppedPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }],
    skipped: 0,
    failed: 0,
  });
  const [listener] = [...mocks.dropListeners];
  await act(async () => {
    listener({ payload: { drop: "drop-1" } });
    await Promise.resolve();
  });
  expect(mocks.scoresheetTakeDroppedPhotos).toHaveBeenCalledWith("drop-1");
  expect(host.querySelectorAll("img")).toHaveLength(1);

  // Visible drop error code renders its message on the intake line.
  mocks.scoresheetTakeDroppedPhotos.mockRejectedValueOnce(new CoachCommandError("unavailable"));
  await act(async () => {
    listener({ payload: { drop: "drop-error" } });
    await Promise.resolve();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Error.Unavailable",
  );

  // Stale drop answering notFound shows nothing on the intake line.
  mocks.scoresheetTakeDroppedPhotos.mockRejectedValueOnce(new CoachCommandError("notFound"));
  await act(async () => {
    listener({ payload: { drop: "drop-stale" } });
    await Promise.resolve();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();

  // Unmount unsubscribes so subsequent drops are never taken.
  await act(async () => {
    root.unmount();
  });
  expect(mocks.dropListeners.size).toBe(0);
  expect(mocks.unlistenCount).toBe(1);
  mocks.scoresheetTakeDroppedPhotos.mockClear();
  listener({ payload: { drop: "drop-after-unmount" } });
  expect(mocks.scoresheetTakeDroppedPhotos).not.toHaveBeenCalled();
});

test("failed drop listener registration logs through warnSafely without showing an intake error", async () => {
  mocks.dropRegistrationError = new Error("ipc listen refused");
  await renderPane({ hasConnection: true });
  expect(mocks.warnSafely).toHaveBeenCalledWith(
    "Scoresheet photo drop listener failed: ipc listen refused",
  );
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();
});

test.each(Object.entries(catalogues))(
  "ships scoresheet intake and error copy in %s with fallback disabled",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    const cases: readonly (readonly [string, Record<string, string | number> | undefined])[] = [
      ["Coach.Error.PhotoUnreadable", undefined],
      ["Coach.Error.ClipboardEmpty", undefined],
      ["Scoresheet.Error.Busy", undefined],
      ["Scoresheet.Error.LimitExceeded", undefined],
      ["Scoresheet.Error.Unavailable", undefined],
      ["Scoresheet.Error.InvalidInput", undefined],
      ["Scoresheet.LoadPhotoAgain", undefined],
      ["Scoresheet.Intake.NeedsConnection", undefined],
      ["Scoresheet.Intake.OpenAiSettings", undefined],
      ["Scoresheet.Intake.ChoosePhotos", undefined],
      ["Scoresheet.Intake.PasteFromClipboard", undefined],
      ["Scoresheet.Intake.DropHint", undefined],
      ["Scoresheet.Intake.RemovePhoto", { number: 1 }],
      ["Scoresheet.Intake.Skipped", { count: 1 }],
      ["Scoresheet.Intake.Skipped", { count: 3 }],
      ["Scoresheet.Intake.Failed", { count: 1 }],
      ["Scoresheet.Intake.Failed", { count: 2 }],
    ];
    for (const [key, opts] of cases) {
      const value = String(opts ? i18n.t(key, opts) : i18n.t(key));
      expect(value.trim()).toBeTruthy();
      expect(value).not.toBe(key);
    }
  },
);
