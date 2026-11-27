import { createTheme, MantineProvider } from "@mantine/core";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, type State } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { cancellationError, TauriCommandError } from "@/platform/tauri";
import english from "@/translation/en-US.json";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { EditGameDataModal, type EditGameDataTarget } from "./EditGameDataModal";

dayjs.extend(customParseFormat);

const mocks = vi.hoisted(() => ({
  getDbGame: vi.fn(),
  writeDbGameHeaders: vi.fn(),
  notification: vi.fn(),
}));

vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      getDbGame: mocks.getDbGame,
      writeDbGameHeaders: mocks.writeDbGameHeaders,
    },
  };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notification } }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      (english.translation as Record<string, string>)[key] ?? options?.defaultValue ?? key,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      (
        (english.translation as Record<string, string>)[key] ??
        options?.defaultValue ??
        key
      ).replace(/\{\{(\w+)\}\}/g, (placeholder, name) => options?.[name] ?? placeholder),
  }),
}));

installMatchMediaStub();
installResizeObserverStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Element.prototype.scrollIntoView = () => {};

const instantModalTheme = createTheme({
  components: {
    Modal: {
      defaultProps: {
        transitionProps: { duration: 0 },
        overlayProps: { transitionProps: { duration: 0 } },
      },
    },
  },
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setNativeInputValue(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("EditGameDataModal", () => {
  const file: DatabaseHandle = { id: { id: "db-1" }, kind: "database" };
  const baseGame: NormalizedGame = {
    id: 42,
    stamp: "stamp-v1",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    event: 'Grand \\"Open\\" \\\\ 2026',
    event_id: 1,
    site: 'Berlin \\"Club\\"',
    site_id: 1,
    date: "2026.11.01",
    round: "3",
    white: "Alice",
    white_id: 1,
    white_elo: 2100,
    black: "Bob",
    black_id: 2,
    black_elo: 2050,
    result: "1-0",
    time_control: "5400+30",
    moves: "1. e4 e5 *",
  };

  let host: HTMLDivElement;
  let root: Root;
  let cache: Map<string, State>;
  let gamesFetcher: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  const gamesKey = ["games", file, { limit: 10 }] as const;

  function GamesSubscriber() {
    useSWR(gamesKey, gamesFetcher);
    return null;
  }

  beforeEach(() => {
    mocks.getDbGame.mockReset().mockResolvedValue({ kind: "found", game: baseGame });
    mocks.writeDbGameHeaders.mockReset().mockResolvedValue("stamp-v2");
    mocks.notification.mockReset();
    onClose = vi.fn();
    cache = new Map();
    gamesFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue({ data: [], count: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(
    target: EditGameDataTarget | null = { file, gameId: 42 },
    showModal = true,
  ) {
    await act(async () =>
      root.render(
        <MantineProvider env="test" theme={instantModalTheme}>
          <SWRConfig
            value={{
              provider: () => cache,
              shouldRetryOnError: false,
              revalidateOnFocus: false,
              revalidateOnReconnect: false,
            }}
          >
            <GamesSubscriber />
            {showModal && <EditGameDataModal target={target} onClose={onClose} />}
          </SWRConfig>
        </MantineProvider>,
      ),
    );
  }

  function dialogs() {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
  }

  function dialog() {
    return dialogs()[0]!;
  }

  function dialogButton(label: string, container: HTMLElement = dialog()) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label,
    )!;
  }

  function whiteInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="White"]')!;
  }

  function eventInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="Event"]')!;
  }

  function siteInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="Site"]')!;
  }

  function dateInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="Date"]')!;
  }

  function whiteEloInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="White Elo"]')!;
  }

  function blackEloInput() {
    return dialog().querySelector<HTMLInputElement>('input[aria-label="Black Elo"]')!;
  }

  function resultInput() {
    const label = [...dialog().querySelectorAll("label")].find(
      (item) => item.textContent === "Result",
    )!;
    const id = label.getAttribute("for")!;
    return document.getElementById(id) as HTMLInputElement;
  }

  function timeControlInput() {
    return (
      dialog().querySelector<HTMLInputElement>('input[aria-label="Time control"]') ??
      (() => {
        const label = [...dialog().querySelectorAll("label")].find(
          (item) => item.textContent === "Time control",
        )!;
        const id = label.getAttribute("for")!;
        return document.getElementById(id) as HTMLInputElement;
      })()
    );
  }

  test("loads via get_db_game, decodes Event and Site, focuses White, and disables Save until changed", async () => {
    await render();
    expect(mocks.getDbGame).toHaveBeenCalledExactlyOnceWith(
      file,
      42,
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.activeElement).toBe(whiteInput());
    expect(eventInput().value).toBe('Grand "Open" \\ 2026');
    expect(siteInput().value).toBe('Berlin "Club"');
    expect(dialogButton("Save").disabled).toBe(true);

    await act(async () => setNativeInputValue(eventInput(), "Updated Event"));
    expect(dialogButton("Save").disabled).toBe(false);
  });

  test("renders a Lichess Site URL as an editable input in the dialog", async () => {
    mocks.getDbGame.mockResolvedValueOnce({
      kind: "found",
      game: { ...baseGame, site: "https://lichess.org/Abcd1234" },
    });
    await render();
    expect(dialog().querySelector("a")).toBeNull();
    expect(siteInput().value).toBe("https://lichess.org/Abcd1234");
  });

  test("missing game on load shows missing state with only Close", async () => {
    mocks.getDbGame.mockResolvedValueOnce({ kind: "missing" });
    await render();
    expect(dialog().textContent).toContain("This game no longer exists in the database.");
    expect(dialogButton("Close")).toBeDefined();
    expect(dialogButton("Save")).toBeUndefined();
    await act(async () => dialogButton("Close").click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("load error shows inline error and closing aborts an in-flight load", async () => {
    const pendingLoad = deferred<{ kind: "found"; game: NormalizedGame }>();
    let capturedSignal: AbortSignal | undefined;
    mocks.getDbGame.mockImplementationOnce((_file, _id, _linked, options) => {
      capturedSignal = options?.signal;
      return pendingLoad.promise;
    });
    await render();
    expect(capturedSignal?.aborted).toBe(false);
    await render(null);
    expect(capturedSignal?.aborted).toBe(true);

    mocks.getDbGame.mockRejectedValueOnce(new Error("Disk unreadable"));
    await render();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "There was an error loading this database",
    );
    expect(dialogButton("Close")).toBeDefined();
  });

  test("Save sends one call with draft and loaded stamp, closes, and refreshes queries", async () => {
    const saveDeferred = deferred<string>();
    mocks.writeDbGameHeaders.mockReturnValueOnce(saveDeferred.promise);
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Candidates"));
    await act(async () => dialogButton("Save").click());

    expect(dialogButton("Save").disabled).toBe(true);
    expect(dialogButton("Cancel").disabled).toBe(true);
    expect(mocks.writeDbGameHeaders).toHaveBeenCalledExactlyOnceWith(
      file,
      42,
      expect.objectContaining({
        white: "Alice",
        black: "Bob",
        event: "Candidates",
        site: 'Berlin "Club"',
      }),
      "stamp-v1",
    );

    await act(async () => saveDeferred.resolve("stamp-v2"));
    expect(onClose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(gamesFetcher).toHaveBeenCalledTimes(2));
  });

  test("Escape and Cancel close directly when unchanged, and ask for confirmation when dirty", async () => {
    await render();

    // Unchanged draft -> Escape closes directly without confirmation
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(1);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();

    // Dirty draft -> Escape opens discard confirmation
    await act(async () => setNativeInputValue(eventInput(), "Changed"));
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(2);
    const confirmDialog = dialogs()[1]!;
    expect(confirmDialog.textContent).toContain("Discard changes?");

    // Cancelling confirmation returns to the dialog with the draft intact
    await act(async () => dialogButton("Cancel", confirmDialog).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(1);
    expect(eventInput().value).toBe("Changed");

    // Confirming discards and closes without writing
    await act(async () => dialogButton("Cancel").click());
    expect(dialogs()).toHaveLength(2);
    await act(async () => dialogButton("Discard", dialogs()[1]!).click());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();
  });

  test("Escape while saving does nothing", async () => {
    const saveDeferred = deferred<string>();
    mocks.writeDbGameHeaders.mockReturnValueOnce(saveDeferred.promise);
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Saving Event"));
    await act(async () => dialogButton("Save").click());

    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(esc));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);
    expect(dialogButton("Save").disabled).toBe(true);

    await act(async () => saveDeferred.resolve("stamp-v2"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("Enter in a text field submits the save", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Enter Event"));
    await act(async () =>
      eventInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.writeDbGameHeaders).toHaveBeenCalledExactlyOnceWith(
      file,
      42,
      expect.objectContaining({ event: "Enter Event" }),
      "stamp-v1",
    );
  });

  test("Enter in Date (calendar open), Result, and Time control dropdowns does not save", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Dirty"));

    // Open Date calendar and press Enter: guard must call preventDefault() so the browser
    // cannot trigger implicit form submission.
    const date = dateInput();
    await act(async () => {
      date.focus();
      date.click();
    });
    const dateEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      date.dispatchEvent(dateEnter);
    });
    expect(dateEnter.defaultPrevented).toBe(true);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();

    // Open Result dropdown and press Enter
    const result = resultInput();
    await act(async () => result.click());
    expect(result.getAttribute("aria-expanded")).toBe("true");
    const resultEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      result.dispatchEvent(resultEnter);
    });
    expect(resultEnter.defaultPrevented).toBe(true);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();

    // Open Time control Select dropdown and press Enter
    const tc = timeControlInput();
    await act(async () => tc.click());
    expect(tc.getAttribute("data-expanded")).toBe("true");
    const tcEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      tc.dispatchEvent(tcEnter);
    });
    expect(tcEnter.defaultPrevented).toBe(true);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();
  });

  test("Escape in open Date calendar, Result dropdown, and Time control dropdown leaves the dialog open without discard prompt", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Dirty"));

    // 1. Open Date calendar -> Escape closes only the calendar
    const date = dateInput();
    await act(async () => {
      date.focus();
      date.click();
    });
    const dateEsc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      date.dispatchEvent(dateEsc);
    });
    expect(dateEsc.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);

    // 2. Open Result dropdown -> Escape closes only the dropdown
    const result = resultInput();
    await act(async () => result.click());
    expect(result.getAttribute("aria-expanded")).toBe("true");
    const resultEsc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      result.dispatchEvent(resultEsc);
    });
    expect(resultEsc.defaultPrevented).toBe(true);
    expect(result.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);

    // 3. Open Time control dropdown -> Escape closes only the dropdown
    const tc = timeControlInput();
    await act(async () => tc.click());
    expect(tc.getAttribute("data-expanded")).toBe("true");
    const tcEsc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      tc.dispatchEvent(tcEsc);
    });
    expect(tcEsc.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogs()).toHaveLength(1);

    // 4. With nothing open -> Escape follows the normal close path (dirty -> discard prompt)
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(dialogs()).toHaveLength(2);
    expect(dialogs()[1]!.textContent).toContain("Discard changes?");
  });

  test("Elo outside 0-4000 (including beyond i32) shows an inline error and blocks saving before IPC", async () => {
    await render();

    await act(async () => setNativeInputValue(whiteEloInput(), "9999999999"));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "Elo must be between 0 and 4000.",
    );
    expect(dialogButton("Save").disabled).toBe(true);
    await act(async () =>
      whiteEloInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();

    await act(async () => setNativeInputValue(whiteEloInput(), "-5"));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "Elo must be between 0 and 4000.",
    );
    expect(dialogButton("Save").disabled).toBe(true);

    await act(async () => setNativeInputValue(whiteEloInput(), "2500"));
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialogButton("Save").disabled).toBe(false);

    await act(async () => setNativeInputValue(blackEloInput(), "4001"));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "Elo must be between 0 and 4000.",
    );
    expect(dialogButton("Save").disabled).toBe(true);
    expect(mocks.writeDbGameHeaders).not.toHaveBeenCalled();
  });

  test("first save refresh settling after reopen does not clear the second save's pending state", async () => {
    const firstRefresh = deferred<unknown>();
    const secondSave = deferred<string>();
    await render();
    await vi.waitFor(() => expect(gamesFetcher).toHaveBeenCalledTimes(1));

    // First save succeeds immediately, but its post-save query refresh stays pending.
    gamesFetcher.mockReturnValueOnce(firstRefresh.promise);
    mocks.writeDbGameHeaders.mockResolvedValueOnce("stamp-v2");
    await act(async () => setNativeInputValue(eventInput(), "First Save"));
    await act(async () => dialogButton("Save").click());
    expect(onClose).toHaveBeenCalledTimes(1);

    // Close and reopen while first save's refresh is still in flight.
    await render(null);
    mocks.getDbGame.mockResolvedValueOnce({
      kind: "found",
      game: { ...baseGame, stamp: "stamp-v2", event: "First Save" },
    });
    await render({ file, gameId: 42 });

    // Start second save (remains pending).
    mocks.writeDbGameHeaders.mockReturnValueOnce(secondSave.promise);
    await act(async () => setNativeInputValue(eventInput(), "Second Save"));
    await act(async () => dialogButton("Save").click());
    expect(dialogButton("Save").disabled).toBe(true);

    // First save's refresh completes -> must NOT clear second save's pending state.
    await act(async () => firstRefresh.resolve({ data: [], count: 0 }));
    expect(dialogButton("Save").disabled).toBe(true);
    expect(dialogButton("Cancel").disabled).toBe(true);

    // Second save completes -> now closes.
    await act(async () => secondSave.resolve("stamp-v3"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("stale-game keeps draft, reloads fresh stamp, and second Save uses the new stamp", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "My Draft Event"));

    const reloadDeferred = deferred<{ kind: "found"; game: NormalizedGame }>();
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "stale-game",
        message: "Game changed on disk",
      }),
    );
    mocks.getDbGame.mockReturnValueOnce(reloadDeferred.promise);

    await act(async () => dialogButton("Save").click());

    // While reload runs: Save is disabled and notice is not shown yet.
    expect(dialogButton("Save").disabled).toBe(true);
    expect(dialog().textContent).not.toContain("This game was changed elsewhere.");
    expect(eventInput().value).toBe("My Draft Event");

    await act(async () =>
      reloadDeferred.resolve({
        kind: "found",
        game: { ...baseGame, stamp: "stamp-v2", event: "Other Edit" },
      }),
    );

    expect(dialog().textContent).toContain(
      "This game was changed elsewhere. Your entries are kept; the current data was reloaded.",
    );
    expect(eventInput().value).toBe("My Draft Event");
    expect(dialogButton("Save").disabled).toBe(false);

    mocks.writeDbGameHeaders.mockResolvedValueOnce("stamp-v3");
    await act(async () => dialogButton("Save").click());
    expect(mocks.writeDbGameHeaders).toHaveBeenLastCalledWith(
      file,
      42,
      expect.objectContaining({ event: "My Draft Event" }),
      "stamp-v2",
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("stale-game reload returning missing switches to missing state", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Draft"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "stale-game",
        message: "Game changed on disk",
      }),
    );
    mocks.getDbGame.mockResolvedValueOnce({ kind: "missing" });

    await act(async () => dialogButton("Save").click());
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain("This game no longer exists in the database."),
    );
    expect(dialogButton("Close")).toBeDefined();
    expect(dialogButton("Save")).toBeUndefined();
  });

  test("stale-game reload failure keeps draft, shows inline error and Reload, and keeps Save disabled", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Preserved Draft"));

    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "stale-game",
        message: "Game changed on disk",
      }),
    );
    mocks.getDbGame.mockRejectedValueOnce(new Error("Reload I/O error"));

    await act(async () => dialogButton("Save").click());
    await vi.waitFor(() =>
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
        "There was an error loading this database",
      ),
    );

    expect(eventInput().value).toBe("Preserved Draft");
    expect(dialogButton("Save").disabled).toBe(true);
    expect(dialogButton("Reload")).toBeDefined();

    mocks.getDbGame.mockResolvedValueOnce({
      kind: "found",
      game: { ...baseGame, stamp: "stamp-v2" },
    });
    await act(async () => dialogButton("Reload").click());
    expect(dialog().textContent).toContain(
      "This game was changed elsewhere. Your entries are kept; the current data was reloaded.",
    );
    expect(dialogButton("Save").disabled).toBe(false);
  });

  test("external cancellation on initial load or stale reload reaches a terminal error state", async () => {
    // External cancellation on initial load (not aborted by this dialog) -> error state
    mocks.getDbGame.mockRejectedValueOnce(cancellationError());
    await render();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "There was an error loading this database",
    );
    expect(dialogButton("Close")).toBeDefined();

    // External cancellation on stale reload -> failed state with Reload button
    await render(null);
    await render({ file, gameId: 42 });
    await act(async () => setNativeInputValue(eventInput(), "Draft"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "stale-game",
        message: "Game changed on disk",
      }),
    );
    mocks.getDbGame.mockRejectedValueOnce(cancellationError());
    await act(async () => dialogButton("Save").click());
    await vi.waitFor(() =>
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
        "There was an error loading this database",
      ),
    );
    expect(dialogButton("Reload")).toBeDefined();
    expect(dialogButton("Save").disabled).toBe(true);
  });

  test("save failing with missing-resource switches to missing state when rootFailure is absent", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Updated"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "missing-resource",
        message: "Game not found",
      }),
    );
    await act(async () => dialogButton("Save").click());
    expect(dialog().textContent).toContain("This game no longer exists in the database.");
    expect(dialogButton("Close")).toBeDefined();
    expect(dialogButton("Save")).toBeUndefined();
  });

  test("save failing with missing-resource and a rootFailure shows the database error inline and keeps the draft", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Preserved Event"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "missing-resource",
        message: "missing database root at /private/databases",
        rootFailure: "missing",
      }),
    );
    await act(async () => dialogButton("Save").click());
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "This database folder is no longer available. Choose another.",
    );
    expect(eventInput().value).toBe("Preserved Event");
    expect(dialogButton("Save").disabled).toBe(false);
    expect(dialog().textContent).not.toContain("This game no longer exists in the database.");
  });

  test("save failing with invalid-input shows message inline", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Bad"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "invalid-input",
        message: "Invalid date format",
      }),
    );
    await act(async () => dialogButton("Save").click());
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Invalid date format");
    expect(mocks.notification).not.toHaveBeenCalled();
  });

  test("other save errors notify with the database domain", async () => {
    await render();
    await act(async () => setNativeInputValue(eventInput(), "Updated"));
    mocks.writeDbGameHeaders.mockRejectedValueOnce(
      new TauriCommandError({
        tag: "backend-error",
        category: "io",
        message: "missing database root at /private/databases",
        rootFailure: "missing",
      }),
    );
    await act(async () => dialogButton("Save").click());
    expect(mocks.notification).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        color: "danger",
        title: "Error",
        message: "This database folder is no longer available. Choose another.",
      }),
    );
  });

  test("unmounting only the dialog during save still completes the write and refreshes the subscriber", async () => {
    const saveDeferred = deferred<string>();
    mocks.writeDbGameHeaders.mockReturnValueOnce(saveDeferred.promise);
    await render();
    await vi.waitFor(() => expect(gamesFetcher).toHaveBeenCalledTimes(1));

    await act(async () => setNativeInputValue(eventInput(), "In-flight"));
    await act(async () => dialogButton("Save").click());

    // Unmount only the dialog, keeping GamesSubscriber mounted.
    await render({ file, gameId: 42 }, false);
    await act(async () => saveDeferred.resolve("stamp-v2"));
    expect(onClose).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(gamesFetcher).toHaveBeenCalledTimes(2));
  });
});
