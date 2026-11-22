import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, ErrorPayload } from "@/bindings";
import { opponentImportsAtom, opponentLinksAtom } from "@/state/atoms";
import { defaultOpponentFilter, type OpponentLink } from "@/state/opponentLinks";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { OpponentImportResult } from "./opponentImport";

const mocks = vi.hoisted(() => ({
  listing: undefined as unknown,
  listingError: undefined as unknown,
  run: vi.fn(),
  cancel: vi.fn(),
  removeGames: vi.fn(),
  unlink: vi.fn(),
  lookup: vi.fn(),
  playerIds: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("@/hooks/useDatabaseList", () => ({
  DATABASE_LIST_KEY: "databases",
  useDatabaseList: () => ({ data: mocks.listing, error: mocks.listingError }),
}));
vi.mock("@/hooks/useProgress", () => ({ useProgress: () => ({ progress: 40 }) }));
vi.mock("./opponentImport", () => ({
  runOpponentImport: mocks.run,
  cancelOpponentImport: mocks.cancel,
  removeOpponentGames: mocks.removeGames,
  unlinkOpponent: mocks.unlink,
}));
vi.mock("./opponentLookup", async (original) => ({
  ...(await original<typeof import("./opponentLookup")>()),
  lookupOpponentAccount: mocks.lookup,
  opponentPlayerIds: mocks.playerIds,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/components/files/notifyError", async (original) => ({
  ...(await original<typeof import("@/components/files/notifyError")>()),
  notifyUnlessCancelled: mocks.notifyError,
}));

let translate: (key: string, options?: Record<string, unknown>) => string;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options),
  }),
}));

import OpponentAccounts, { opponentGames } from "./OpponentAccounts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
installInlineComputedStyleStub();

const ID = "11111111-1111-4111-8111-111111111111";
const DATABASE = `opponent-${ID}-0a1b2c3d.db3`;
const NAME = "Carlsen, Magnus";
const lichess = { provider: "lichess", username: "DrNykterstein" } as const;
const chesscom = { provider: "chesscom", username: "MagnusCarlsen" } as const;
const file: DatabaseHandle = { id: { id: "opponent-db" }, kind: "database" };

function link(overrides: Partial<OpponentLink> = {}): OpponentLink {
  return {
    id: ID,
    playerName: NAME,
    accounts: [lichess],
    filter: defaultOpponentFilter(),
    ...overrides,
  };
}

function listed(type: "success" | "error", gameCount = 0) {
  return {
    databases: [
      type === "success"
        ? { type, file, filename: DATABASE, title: "online", game_count: gameCount }
        : { type, file, filename: DATABASE, error: "unreadable" },
    ],
  };
}

let root: Root;
let container: HTMLDivElement;
let store: ReturnType<typeof createStore>;

async function render(playerName = NAME) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={store}>
          <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <OpponentAccounts playerName={playerName} />
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    ),
  );
}

function buttons(name: string) {
  return [...document.body.querySelectorAll("button")].filter(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
}

function button(name: string) {
  const [found] = buttons(name);
  if (!found) throw new Error(`no button named ${name}`);
  return found;
}

async function click(name: string) {
  await act(async () => button(name).click());
}

/** The confirming button of the open dialog; the strip has a button of the same name. */
async function confirm(name: string) {
  const inDialog = [...document.body.querySelectorAll('[role="dialog"] button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLButtonElement;
  await act(async () => inDialog.click());
}

function status() {
  return document.body.querySelector("[data-opponent-status]")!;
}

function storedLink() {
  return store.get(opponentLinksAtom).find((entry) => entry.id === ID);
}

function checkbox(label: string) {
  const found = [
    ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) => input.closest("label, div")?.parentElement?.textContent?.trim() === label);
  if (!found) throw new Error(`no checkbox named ${label}`);
  return found;
}

async function settle(result: OpponentImportResult) {
  mocks.run.mockResolvedValueOnce(result);
  await click("Download games");
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listing = { databases: [] };
  mocks.listingError = undefined;
  mocks.playerIds.mockResolvedValue([1]);
  mocks.removeGames.mockResolvedValue(0);
  mocks.unlink.mockResolvedValue(0);
  mocks.cancel.mockResolvedValue(undefined);
  const i18n = await catalogueI18n("en-US");
  translate = (key, options) => i18n.t(key, options);
  localStorage.clear();
  store = createStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("opponentGames", () => {
  test("a link without a database has no games, whatever the listing says", () => {
    expect(opponentGames(undefined, undefined, undefined)).toEqual({ kind: "none" });
    expect(opponentGames(link(), listed("success", 5) as never, undefined)).toEqual({
      kind: "none",
    });
  });

  test("the listed database decides between games, unreadable and gone", () => {
    const withDatabase = link({ database: DATABASE });

    expect(opponentGames(withDatabase, listed("success", 5) as never, undefined)).toEqual({
      kind: "games",
      count: 5,
      file,
    });
    expect(opponentGames(withDatabase, listed("error") as never, undefined)).toEqual({
      kind: "unreadable",
    });
    expect(opponentGames(withDatabase, { databases: [] } as never, undefined)).toEqual({
      kind: "none",
    });
  });

  test("without a listing the state is pending, or failed once the listing failed", () => {
    const withDatabase = link({ database: DATABASE });
    const cancelled: ErrorPayload = {
      tag: "backend-error",
      category: "cancellation",
      message: "Cancellation",
    };

    expect(opponentGames(withDatabase, undefined, undefined)).toEqual({ kind: "pending" });
    expect(opponentGames(withDatabase, undefined, cancelled)).toEqual({ kind: "pending" });
    expect(opponentGames(withDatabase, undefined, new Error("disk"))).toEqual({ kind: "failed" });
  });
});

describe("a player without online accounts", () => {
  test("offers to add one and shows nothing else", async () => {
    await render();

    expect(document.body.textContent).toContain("Online accounts");
    expect(buttons("Add online account")).toHaveLength(1);
    expect(document.body.querySelector("[data-opponent-status]")).toBeNull();
    expect(document.body.querySelector("[data-opponent-details]")).toBeNull();
  });

  test("the confirmed account creates the link under the player's name with the default filter", async () => {
    mocks.lookup.mockResolvedValue({
      kind: "found",
      profile: { ...lichess, closed: false },
    });
    await render();
    await click("Add online account");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      setter.call(input, "drnykterstein");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Look up");
    await click("Link account");

    const [created] = store.get(opponentLinksAtom);
    expect(created).toMatchObject({
      playerName: NAME,
      accounts: [lichess],
      filter: { years: 3, timeControls: ["blitz", "rapid", "classical", "correspondence"] },
    });
    expect(created.database).toBeUndefined();
    // The new link opens on its settings: last three years, every time control but bullet.
    expect(document.body.querySelector<HTMLSelectElement>("select")!.value).toBe("3");
    expect(checkbox("Bullet").checked).toBe(false);
    for (const control of ["Blitz", "Rapid", "Classical", "Correspondence"]) {
      expect(checkbox(control).checked).toBe(true);
    }
    expect(status().textContent).toBe("No games downloaded");
  });

  test("a link is found by the player's name in any case", async () => {
    store.set(opponentLinksAtom, [link()]);
    await render("  CARLSEN, magnus ");

    expect(document.body.textContent).toContain("DrNykterstein");
  });
});

describe("downloading", () => {
  beforeEach(() => store.set(opponentLinksAtom, [link()]));

  test("starts the import of this link under the player's name and reports the games", async () => {
    await render();
    await settle({ kind: "imported", games: 2, merged: true, leftovers: 0 });

    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ store }),
      ID,
      "Carlsen, Magnus (online)",
    );
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ color: "success", message: "Downloaded 2 online games." }),
    );
  });

  test("one downloaded game is reported in the singular, a leftover copy in a second message", async () => {
    await render();
    await settle({ kind: "imported", games: 1, merged: true, leftovers: 1 });

    expect(mocks.notify.mock.calls.map(([shown]) => shown.message)).toEqual([
      "Downloaded 1 online game.",
      "An older copy of the online games could not be deleted. You can delete it in the Library.",
    ]);
  });

  test.each([
    [{ kind: "noGames" }, "warning", "No game matches the period and time controls."],
    [
      { kind: "accountFailed", account: lichess, reason: "notFound" },
      "danger",
      "Lichess has no account named DrNykterstein.",
    ],
    [
      { kind: "accountFailed", account: chesscom, reason: "rateLimited" },
      "danger",
      "Chess.com is limiting requests. Try again in a minute.",
    ],
    [
      { kind: "accountFailed", account: lichess, reason: "signIn" },
      "danger",
      "Lichess rejected your sign-in. Sign in again on the Accounts page.",
    ],
    [
      { kind: "accountFailed", account: chesscom, reason: "other" },
      "danger",
      "The games of MagnusCarlsen on Chess.com could not be downloaded.",
    ],
  ] satisfies [OpponentImportResult, string, string][])(
    "a run ending in %o says so",
    async (result, color, message) => {
      await render();
      await settle(result);

      expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ color, message }),
      );
    },
  );

  test("a cancelled run says nothing and an unexpected failure goes to the error notice", async () => {
    await render();
    await settle({ kind: "cancelled" });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();

    const error = new Error("disk full");
    await settle({ kind: "failed", error });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith("Error", error);
  });

  test("a running import shows its progress and can be cancelled, and nothing else can change", async () => {
    store.set(opponentImportsAtom, new Map([[ID, "ticket-1"]]));
    await render();
    await click("Manage online accounts");

    expect(status().textContent).toBe("Downloading online games");
    expect(buttons("Download games")).toHaveLength(0);
    expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(button("Remove online games").disabled).toBe(true);
    expect(button("Unlink accounts").disabled).toBe(true);
    expect(button("Remove DrNykterstein").disabled).toBe(true);
    expect(document.body.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(checkbox("Blitz").disabled).toBe(true);

    await click("Cancel");

    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(store, ID);
  });

  test("before the import has its ticket there is nothing to cancel yet", async () => {
    store.set(opponentImportsAtom, new Map([[ID, null]]));
    await render();

    expect(button("Cancel").disabled).toBe(true);
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe("downloaded games", () => {
  beforeEach(() => store.set(opponentLinksAtom, [link({ database: DATABASE })]));

  test("shows how many there are and offers to update them", async () => {
    mocks.listing = listed("success", 1234);
    await render();

    expect(status().textContent).toBe("1234 online games");
    expect(status().getAttribute("role")).toBe("status");
    expect(buttons("Update games")).toHaveLength(1);
    expect(buttons("Download games")).toHaveLength(0);
  });

  test("one game is counted in the singular", async () => {
    mocks.listing = listed("success", 1);
    await render();

    expect(status().textContent).toBe("1 online game");
  });

  test("an unreadable database and a failed listing are shown as problems", async () => {
    mocks.listing = listed("error");
    await render();
    expect(status().textContent).toBe("The online games cannot be read");
    expect(status().getAttribute("role")).toBe("alert");

    mocks.listing = undefined;
    mocks.listingError = new Error("disk");
    await render();
    expect(status().textContent).toBe("The databases could not be listed");
    expect(status().getAttribute("role")).toBe("alert");
  });

  test("a database that is no longer listed reads as no games, and the link is left alone", async () => {
    await render();

    expect(status().textContent).toBe("No games downloaded");
    expect(storedLink()?.database).toBe(DATABASE);
    expect(mocks.playerIds).not.toHaveBeenCalled();
  });

  test("usernames that stayed separate players are named, one merged player is not", async () => {
    store.set(opponentLinksAtom, [link({ database: DATABASE, accounts: [lichess, chesscom] })]);
    mocks.listing = listed("success", 10);
    mocks.playerIds.mockResolvedValue([3, 8]);
    await render();

    expect(mocks.playerIds).toHaveBeenCalledWith(file, [lichess, chesscom]);
    expect(document.body.querySelector("[data-opponent-separate]")?.textContent).toBe(
      "The linked usernames played each other, so they stay separate players. The board shows the games of DrNykterstein.",
    );
  });

  test("one merged player needs no note", async () => {
    mocks.listing = listed("success", 10);
    await render();

    expect(mocks.playerIds).toHaveBeenCalledOnce();
    expect(document.body.querySelector("[data-opponent-separate]")).toBeNull();
  });
});

describe("managing a link", () => {
  beforeEach(() => {
    store.set(opponentLinksAtom, [link({ database: DATABASE, accounts: [lichess, chesscom] })]);
    mocks.listing = listed("success", 10);
  });

  test("the settings stay closed until asked for", async () => {
    await render();
    expect(document.body.querySelector("[data-opponent-details]")).toBeNull();
    expect(button("Manage online accounts").getAttribute("aria-pressed")).toBe("false");

    await click("Manage online accounts");
    expect(document.body.querySelector("[data-opponent-details]")).not.toBeNull();
    expect(button("Manage online accounts").getAttribute("aria-pressed")).toBe("true");
  });

  test("period and time controls are stored on the link", async () => {
    await render();
    await click("Manage online accounts");
    const select = document.body.querySelector<HTMLSelectElement>("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "1 year",
      "3 years",
      "5 years",
      "All games",
    ]);

    await act(async () => {
      select.value = "all";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(storedLink()?.filter.years).toBeNull();

    await act(async () => checkbox("Bullet").click());
    await act(async () => checkbox("Rapid").click());
    expect(storedLink()?.filter.timeControls).toEqual([
      "bullet",
      "blitz",
      "classical",
      "correspondence",
    ]);
    expect(storedLink()?.database).toBe(DATABASE);
  });

  test("removing one of several accounts needs no confirmation", async () => {
    await render();
    await click("Manage online accounts");
    await click("Remove DrNykterstein");

    expect(storedLink()?.accounts).toEqual([chesscom]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  test("removing the last account asks to unlink instead", async () => {
    store.set(opponentLinksAtom, [link({ database: DATABASE })]);
    await render();
    await click("Manage online accounts");
    await click("Remove DrNykterstein");

    expect(storedLink()?.accounts).toEqual([lichess]);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "The linked accounts of Carlsen, Magnus and their downloaded games are removed.",
    );
  });

  test("removing the online games asks first and names what stays", async () => {
    mocks.removeGames.mockResolvedValue(1);
    await render();
    await click("Manage online accounts");
    await click("Remove online games");

    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "The downloaded online games of Carlsen, Magnus are deleted. The linked accounts stay.",
    );
    expect(mocks.removeGames).not.toHaveBeenCalled();

    await confirm("Remove online games");

    expect(mocks.removeGames).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ store }),
      ID,
    );
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ color: "warning" }),
    );
  });

  test("games that could not be deleted keep the dialog open with the failure", async () => {
    mocks.removeGames.mockRejectedValue(new Error("locked at /private/path"));
    await render();
    await click("Manage online accounts");
    await click("Remove online games");
    await confirm("Remove online games");

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      "The action could not be completed. Please try again.",
    );
    expect(dialog.textContent).not.toContain("/private/path");
    expect(storedLink()?.database).toBe(DATABASE);
  });

  test("unlinking asks first, and a failed deletion keeps the link", async () => {
    mocks.unlink.mockRejectedValueOnce(new Error("locked"));
    await render();
    await click("Manage online accounts");
    await click("Unlink accounts");
    expect(mocks.unlink).not.toHaveBeenCalled();

    await confirm("Unlink accounts");

    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ store }), ID);
    expect(document.body.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
    expect(storedLink()?.accounts).toEqual([lichess, chesscom]);

    await confirm("Unlink accounts");

    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("without downloaded games there is nothing to remove", async () => {
    store.set(opponentLinksAtom, [link()]);
    await render();
    await click("Manage online accounts");

    expect(button("Remove online games").disabled).toBe(true);
    expect(button("Unlink accounts").disabled).toBe(false);
  });

  test("a full link offers no further account", async () => {
    store.set(opponentLinksAtom, [
      link({
        accounts: Array.from({ length: 8 }, (_, index) => ({
          provider: "lichess" as const,
          username: `account${index}`,
        })),
      }),
    ]);
    await render();
    await click("Manage online accounts");

    expect(buttons("Add online account")).toHaveLength(0);
  });
});
