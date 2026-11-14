import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sessionsAtom } from "@/state/atoms";
import { decodeCompressedOrJson } from "@/state/store/debouncedStorage";
import { getChessComAccount, type ChessComStats } from "@/utils/chess.com/api";
import type { ManagedDatabaseInfo } from "@/utils/db";
import { getLichessAccount, type LichessAccount } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";

const mocks = vi.hoisted(() => ({
  removeLichessAccount: vi.fn(),
  notificationsShow: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  accountCard: vi.fn(),
  translate: vi.fn((key: string, options?: { reason?: string }) =>
    options?.reason ? `${key} ${options.reason}` : key,
  ),
}));

vi.mock("@/platform/tauri", () => ({
  tauri: { removeLichessAccount: mocks.removeLichessAccount },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));
vi.mock("../files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock("@/utils/chess.com/api", () => ({ getChessComAccount: vi.fn(), getStats: vi.fn() }));
vi.mock("@/utils/lichess/api", () => ({ getLichessAccount: vi.fn() }));
vi.mock("../home/AccountCard", () => ({
  AccountCard: (props: { title: string; logout: () => Promise<void> }) => {
    mocks.accountCard(props);
    return (
      <button
        type="button"
        aria-label={`Log out ${props.title}`}
        onClick={() => void props.logout()}
      >
        Log out
      </button>
    );
  },
}));
vi.mock("../home/EmptyAccounts", () => ({ EmptyAccounts: () => <div>Empty</div> }));
import AccountCards from "./AccountCards";

vi.mock("./IconAction", () => ({
  default: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick} />
  ),
}));
vi.mock("lucide-react", () => ({
  Check: () => null,
  Pencil: () => null,
  Trash2: () => null,
}));
vi.mock("@mantine/core", () => ({
  Divider: () => null,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => <input value={value} onChange={onChange} />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

const session = {
  player: "Player",
  updatedAt: 1,
  lichess: {
    handle: "native-handle",
    username: "Player",
    account: { id: "player", username: "Player" },
  },
};

const collidingSessions = [
  {
    player: "bob",
    updatedAt: 1,
    lichess: {
      username: "carol",
      account: { id: "carol", username: "carol" },
    },
  },
  {
    player: "Alice",
    updatedAt: 1,
    lichess: {
      username: "bob",
      account: { id: "bob", username: "bob" },
    },
  },
];

function playerGroup(name: string) {
  const heading = Array.from(container.querySelectorAll("span")).find(
    (element) => element.textContent === name,
  );
  const group = heading?.parentElement?.parentElement;
  if (!group) throw new Error(`Player group ${name} not found`);
  return group;
}

async function renderCards(databases: ManagedDatabaseInfo[] = []) {
  await act(async () => {
    root.render(<AccountCards listing={{ databases, unread: [] }} onAddAccount={vi.fn()} />);
  });
}

async function logout() {
  await act(async () => {
    container
      .querySelector('button[aria-label^="Log out "]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function removeGroup(name: string) {
  await act(async () => {
    const button = playerGroup(name).querySelector('button[aria-label="Accounts.Remove"]');
    if (!button) throw new Error(`Remove button for ${name} not found`);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getDefaultStore().set(sessionsAtom, [session]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Player session grouping", () => {
  test("groups by player alias when another account has the same username", async () => {
    getDefaultStore().set(sessionsAtom, collidingSessions);
    await renderCards();

    expect(
      Array.from(container.querySelectorAll("span"), (element) => element.textContent),
    ).toEqual(["bob", "Alice"]);
    expect(
      Array.from(playerGroup("bob").querySelectorAll('button[aria-label^="Log out "]'), (button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Log out carol"]);
    expect(
      Array.from(
        playerGroup("Alice").querySelectorAll('button[aria-label^="Log out "]'),
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["Log out bob"]);
  });

  test("removing a player group preserves another player's matching username", async () => {
    getDefaultStore().set(sessionsAtom, collidingSessions);
    await renderCards();

    await act(async () => {
      playerGroup("bob")
        .querySelector('button[aria-label="Accounts.Remove"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([collidingSessions[1]]);
  });

  test("renaming a player group preserves another player's matching username", async () => {
    getDefaultStore().set(sessionsAtom, collidingSessions);
    await renderCards();
    const group = playerGroup("bob");

    await act(async () => {
      group
        .querySelector('button[aria-label="Accounts.EditName"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = group.querySelector("input");
    if (!input) throw new Error("Player name input not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Robert",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      group
        .querySelector('button[aria-label="Accounts.SaveName"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([
      { ...collidingSessions[0], player: "Robert" },
      collidingSessions[1],
    ]);
  });
});

describe("Player group account removal", () => {
  test("revokes the stored handle before dropping the session from the atom and storage", async () => {
    mocks.removeLichessAccount.mockImplementation(async (handle) => {
      expect(handle).toBe("native-handle");
      expect(getDefaultStore().get(sessionsAtom)).toEqual([session]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([session]);
      return {
        state: "removed",
        revocation_pending: false,
        revocation_outcome: "revoked",
        durability_uncertain: false,
      };
    });
    await renderCards();

    await removeGroup("Player");

    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test("drops a handle reported not found without a warning", async () => {
    mocks.removeLichessAccount.mockResolvedValue({ state: "not_found" });
    await renderCards();

    await removeGroup("Player");

    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test.each([
    [true, false, ["Home.Accounts.RevocationPending Lichess.Revocation.Unreachable"]],
    [false, true, ["Home.Accounts.RemoveDurabilityUncertain"]],
    [
      true,
      true,
      [
        "Home.Accounts.RevocationPending Lichess.Revocation.Unreachable",
        "Home.Accounts.RemoveDurabilityUncertain",
      ],
    ],
  ])("uses card warnings for pending=%s and uncertain=%s", async (pending, uncertain, messages) => {
    mocks.removeLichessAccount.mockResolvedValue({
      state: "removed",
      revocation_pending: pending,
      revocation_outcome: pending ? "unreachable" : "revoked",
      durability_uncertain: uncertain,
    });
    await renderCards();

    await removeGroup("Player");

    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
    expect(mocks.notificationsShow.mock.calls.map(([warning]) => warning)).toEqual(
      messages.map((message) => ({ message, color: "warning" })),
    );
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test("keeps a failed member, reports once, and continues through Chess.com and Lichess siblings", async () => {
    const failure = new Error("native unavailable");
    const chessCom = {
      player: "Player",
      updatedAt: 1,
      chessCom: { username: "chess-sibling", stats: {} },
    };
    const later = {
      ...session,
      lichess: { ...session.lichess, username: "later", handle: "later-handle" },
    };
    getDefaultStore().set(sessionsAtom, [session, chessCom, later]);
    const observedCalls: Array<{
      handle: string;
      atomSessions: Session[];
      storedSessions: unknown | null;
    }> = [];
    mocks.removeLichessAccount.mockImplementation(async (handle) => {
      observedCalls.push({
        handle,
        atomSessions: getDefaultStore().get(sessionsAtom),
        storedSessions: decodeCompressedOrJson(localStorage.getItem("sessions")),
      });
      if (handle === "native-handle") {
        throw failure;
      }
      return {
        state: "removed",
        revocation_pending: false,
        revocation_outcome: "revoked",
        durability_uncertain: false,
      };
    });
    await renderCards();

    await removeGroup("Player");

    expect(mocks.removeLichessAccount.mock.calls).toEqual([["native-handle"], ["later-handle"]]);
    expect(observedCalls).toEqual([
      {
        handle: "native-handle",
        atomSessions: [session, chessCom, later],
        storedSessions: [session, chessCom, later],
      },
      {
        handle: "later-handle",
        atomSessions: [session, later],
        storedSessions: [session, later],
      },
    ]);
    expect(getDefaultStore().get(sessionsAtom)).toEqual([session]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([session]);
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
  });

  test("preserves another group's matching username and never revokes its handle", async () => {
    const authenticated = collidingSessions.map((member, i) => ({
      ...member,
      lichess: { ...member.lichess, handle: `handle-${i}` },
    }));
    getDefaultStore().set(sessionsAtom, authenticated);
    mocks.removeLichessAccount.mockResolvedValue({ state: "not_found" });
    await renderCards();

    await removeGroup("bob");

    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("handle-0");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([authenticated[1]]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([authenticated[1]]);
  });

  test("preserves a replacement handle published while native removal is pending", async () => {
    const removal = Promise.withResolvers<{ state: "not_found" }>();
    mocks.removeLichessAccount.mockReturnValue(removal.promise);
    await renderCards();

    await removeGroup("Player");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([session]);
    const replacement = {
      ...session,
      lichess: { ...session.lichess, handle: "replacement-handle" },
    };
    await act(async () => {
      getDefaultStore().set(sessionsAtom, [replacement]);
      removal.resolve({ state: "not_found" });
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([replacement]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([replacement]);
    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
  });

  test("revokes a later member's original handle and preserves its replacement", async () => {
    const later = {
      ...session,
      lichess: { ...session.lichess, username: "later", handle: "later-handle" },
    };
    getDefaultStore().set(sessionsAtom, [session, later]);
    const removal = Promise.withResolvers<{ state: "not_found" }>();
    mocks.removeLichessAccount
      .mockReturnValueOnce(removal.promise)
      .mockResolvedValue({ state: "not_found" });
    await renderCards();

    await removeGroup("Player");
    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    const replacement = {
      ...later,
      lichess: { ...later.lichess, handle: "replacement-handle" },
    };
    await act(async () => {
      getDefaultStore().set(sessionsAtom, [session, replacement]);
      removal.resolve({ state: "not_found" });
    });

    expect(mocks.removeLichessAccount.mock.calls).toEqual([["native-handle"], ["later-handle"]]);
    expect(mocks.removeLichessAccount).not.toHaveBeenCalledWith("replacement-handle");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([replacement]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([replacement]);
  });

  test("drops the original handle even if its group is renamed during native removal", async () => {
    const removal = Promise.withResolvers<{ state: "not_found" }>();
    mocks.removeLichessAccount.mockReturnValue(removal.promise);
    await renderCards();

    await removeGroup("Player");
    await act(async () => {
      getDefaultStore().set(sessionsAtom, (current) =>
        current.map((member) => ({ ...member, player: "Renamed" })),
      );
    });
    expect(playerGroup("Renamed")).toBeDefined();
    await act(async () => removal.resolve({ state: "not_found" }));

    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
  });

  test.each(["lichess", "chesscom"])(
    "drops a renamed handle-less %s sibling but preserves one authenticated during the await",
    async (provider) => {
      const sibling: Session = {
        player: "Player",
        updatedAt: 1,
        ...(provider === "lichess"
          ? {
              lichess: {
                ...session.lichess,
                username: "sibling",
                handle: "",
              },
            }
          : { chessCom: { username: "sibling", stats: {} } }),
      };
      const newlyAuthenticated: Session = {
        ...sibling,
        ...(sibling.lichess
          ? { lichess: { ...sibling.lichess, username: "new-login" } }
          : { chessCom: { username: "new-login", stats: {} } }),
      };
      getDefaultStore().set(sessionsAtom, [session, sibling, newlyAuthenticated]);
      const removal = Promise.withResolvers<{ state: "not_found" }>();
      mocks.removeLichessAccount.mockReturnValue(removal.promise);
      await renderCards();

      await removeGroup("Player");
      const replacement: Session = {
        ...newlyAuthenticated,
        player: "Renamed",
        lichess: {
          ...session.lichess,
          username: "new-login",
          handle: "replacement-handle",
        },
      };
      await act(async () => {
        getDefaultStore().set(sessionsAtom, [
          session,
          { ...sibling, player: "Renamed" },
          replacement,
        ]);
        removal.resolve({ state: "not_found" });
      });

      expect(getDefaultStore().get(sessionsAtom)).toEqual([replacement]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([replacement]);
      expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    },
  );
});

describe("Lichess account removal", () => {
  test.each([undefined, ""])(
    "logs out handle-less cards (%s) without a native call",
    async (handle) => {
      const handleless = { ...session, lichess: { ...session.lichess, handle } };
      getDefaultStore().set(sessionsAtom, [handleless]);
      await renderCards();

      await logout();

      expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
      expect(mocks.removeLichessAccount).not.toHaveBeenCalled();
      expect(mocks.notificationsShow).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, ""])(
    "preserves an authenticated same-username session when logging out a handle-less card (%s)",
    async (handle) => {
      const handleless = { ...session, lichess: { ...session.lichess, handle } };
      const authenticated = {
        ...session,
        lichess: { ...session.lichess, handle: "kept-handle" },
      };
      getDefaultStore().set(sessionsAtom, [handleless, authenticated]);
      await renderCards();

      await logout();

      expect(getDefaultStore().get(sessionsAtom)).toEqual([authenticated]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([authenticated]);
      expect(mocks.removeLichessAccount).not.toHaveBeenCalled();
    },
  );

  test("keeps a replacement handle when the card's logout finishes", async () => {
    const removal = Promise.withResolvers<{ state: "not_found" }>();
    mocks.removeLichessAccount.mockReturnValue(removal.promise);
    await renderCards();

    await logout();
    const replacement = {
      ...session,
      lichess: { ...session.lichess, handle: "replacement-handle" },
    };
    await act(async () => {
      getDefaultStore().set(sessionsAtom, [replacement]);
      removal.resolve({ state: "not_found" });
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([replacement]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([replacement]);
    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
  });

  test.each([
    ["unreachable", "Lichess.Revocation.Unreachable"],
    ["rate_limited", "Lichess.Revocation.RateLimited"],
    ["rejected", "Lichess.Revocation.Rejected"],
  ])(
    "completes local logout for %s and keeps both independent warnings",
    async (outcome, reasonKey) => {
      mocks.removeLichessAccount.mockResolvedValue({
        state: "removed",
        revocation_pending: true,
        revocation_outcome: outcome,
        durability_uncertain: true,
      });
      await renderCards();
      await logout();
      expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
      expect(mocks.notificationsShow).toHaveBeenCalledTimes(2);
      expect(mocks.notificationsShow.mock.calls.map(([warning]) => warning.message)).toEqual([
        `Home.Accounts.RevocationPending ${reasonKey}`,
        "Home.Accounts.RemoveDurabilityUncertain",
      ]);
      expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    },
  );

  test.each([null, "unexpected_revocation_outcome"])(
    "completes local logout for %s and shows the unconfirmed warning",
    async (outcome) => {
      mocks.removeLichessAccount.mockResolvedValue({
        state: "removed",
        revocation_pending: true,
        revocation_outcome: outcome,
        durability_uncertain: false,
      });
      await renderCards();
      await logout();
      expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
      expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
      expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
      expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith({
        message: "Home.Accounts.RevocationPending Lichess.Revocation.Unconfirmed",
        color: "warning",
      });
      expect(mocks.notificationsShow.mock.calls[0][0].message).not.toContain(
        "unexpected_revocation_outcome",
      );
    },
  );

  test.each(["revoked", "already_invalid", null])(
    "%s needs no pending warning",
    async (outcome) => {
      mocks.removeLichessAccount.mockResolvedValue({
        state: "removed",
        revocation_pending: false,
        revocation_outcome: outcome,
        durability_uncertain: false,
      });
      await renderCards();
      await logout();
      expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
      expect(mocks.notificationsShow).not.toHaveBeenCalled();
    },
  );

  test("logs out after an uncertain committed removal and shows a warning", async () => {
    mocks.removeLichessAccount.mockResolvedValue({
      state: "removed",
      revocation_pending: false,
      durability_uncertain: true,
    });
    await renderCards();

    await logout();

    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(mocks.notificationsShow).toHaveBeenCalledWith({
      message: "Home.Accounts.RemoveDurabilityUncertain",
      color: "warning",
    });
  });

  test("removes the local session when native reports not found", async () => {
    mocks.removeLichessAccount.mockResolvedValue({ state: "not_found" });
    await renderCards();

    await logout();

    expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
    expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("native-handle");
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
  });

  test("keeps the local session when native removal throws", async () => {
    const failure = new Error("native unavailable");
    mocks.removeLichessAccount.mockRejectedValue(failure);
    await renderCards();
    const { logout: remove } = mocks.accountCard.mock.lastCall![0];

    await act(async () => {
      await expect(remove()).rejects.toBe(failure);
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([session]);
    expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([session]);
    expect(mocks.notificationsShow).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });
});

test.each(["lichess", "chesscom"] as const)(
  "%s filename matches retain errors and refuse distinct conflicting candidates",
  async (type) => {
    if (type === "chesscom")
      getDefaultStore().set(sessionsAtom, [
        { player: "Player", updatedAt: 1, chessCom: { username: "Player", stats: {} } },
      ]);
    const broken: ManagedDatabaseInfo = {
      type: "error",
      file: { id: { id: "broken" }, kind: "database" },
      filename: `Player_${type}.db3`,
      indexed: false,
      error: "unfinished",
    };
    await renderCards([broken]);
    expect(mocks.accountCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ type, database: broken }),
    );
    const usable: ManagedDatabaseInfo = {
      type: "success",
      file: { id: { id: "usable" }, kind: "database" },
      filename: broken.filename,
      title: "Player",
      description: "",
      indexed: false,
      player_count: 0,
      game_count: 0,
      event_count: 0,
      storage_size: "0",
    };
    await renderCards([broken, usable]);
    expect(mocks.accountCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type,
        database: null,
        associationIssue: expect.objectContaining({ type: "unavailable" }),
      }),
    );
    await renderCards([{ ...usable, filename: "Other.db3" }]);
    expect(mocks.accountCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ type, database: null }),
    );
  },
);

describe("Chess.com case-insensitive removal", () => {
  const unrelatedChessCom: Session = {
    player: "Other",
    updatedAt: 3,
    chessCom: { username: "other", stats: {} },
  };
  const unrelatedLichess: Session = {
    player: "Carol",
    updatedAt: 4,
    lichess: { username: "carol", account: { id: "carol", username: "carol" } },
  };
  const legacyDuplicates: Session[] = [
    { player: "Felix", updatedAt: 1, chessCom: { username: "Felix", stats: {} } },
    { player: "felix", updatedAt: 2, chessCom: { username: "felix", stats: {} } },
    unrelatedChessCom,
    unrelatedLichess,
  ];

  test("logging out one Chess.com card removes legacy case-variant duplicates", async () => {
    getDefaultStore().set(sessionsAtom, legacyDuplicates);
    await renderCards();

    await logout();

    expect(getDefaultStore().get(sessionsAtom)).toEqual([unrelatedChessCom, unrelatedLichess]);
  });

  test("removing a player group removes legacy case-variant Chess.com duplicates", async () => {
    getDefaultStore().set(sessionsAtom, legacyDuplicates);
    await renderCards();

    await removeGroup("Felix");

    expect(getDefaultStore().get(sessionsAtom)).toEqual([unrelatedChessCom, unrelatedLichess]);
  });
});

describe("Account card reload and Lichess case-insensitive removal", () => {
  const statsA: ChessComStats = {
    chess_rapid: { last: { rating: 1500, date: 1, rd: 50 }, record: { win: 1, loss: 0, draw: 0 } },
  };
  const statsB: ChessComStats = {
    chess_rapid: { last: { rating: 1600, date: 2, rd: 45 }, record: { win: 2, loss: 0, draw: 0 } },
  };

  test("Chess.com reload updates a re-added case-variant session without reverting its spelling", async () => {
    const unrelatedChessCom: Session = {
      player: "Other",
      updatedAt: 2,
      chessCom: { username: "other", stats: statsA },
    };
    const unrelatedLichess: Session = {
      player: "Carol",
      updatedAt: 3,
      lichess: { username: "carol", account: { id: "carol", username: "carol" } },
    };
    getDefaultStore().set(sessionsAtom, [
      { player: "Felix", updatedAt: 1, chessCom: { username: "Felix", stats: statsA } },
      unrelatedChessCom,
      unrelatedLichess,
    ]);

    let resolveStats!: (stats: ChessComStats | null) => void;
    vi.mocked(getChessComAccount).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStats = resolve;
        }),
    );

    await renderCards();
    const felixCard = mocks.accountCard.mock.calls.find((call) => call[0]?.title === "Felix")?.[0];
    expect(felixCard).toBeDefined();

    const reloadPromise = felixCard.reload();
    act(() => {
      getDefaultStore().set(sessionsAtom, [
        unrelatedChessCom,
        unrelatedLichess,
        { player: "felix", updatedAt: 10, chessCom: { username: "felix", stats: statsA } },
      ]);
    });

    vi.spyOn(Date, "now").mockReturnValue(99);
    await act(async () => {
      resolveStats(statsB);
      await reloadPromise;
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([
      unrelatedChessCom,
      unrelatedLichess,
      { player: "felix", updatedAt: 99, chessCom: { username: "felix", stats: statsB } },
    ]);
  });

  test("Lichess reload preserves a handle that appeared while reload was in flight", async () => {
    const initialAccount: LichessAccount = { id: "alice", username: "alice" };
    const refreshedAccount: LichessAccount = {
      id: "alice",
      username: "Alice",
      perfs: { blitz: { games: 10, rating: 1800, rd: 60, prog: 5, prov: false } },
    };
    getDefaultStore().set(sessionsAtom, [
      {
        player: "alice",
        updatedAt: 1,
        lichess: { username: "alice", account: initialAccount },
      },
    ]);

    let resolveAccount!: (account: LichessAccount | null) => void;
    vi.mocked(getLichessAccount).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve;
        }),
    );

    await renderCards();
    const aliceCard = mocks.accountCard.mock.calls.find((call) => call[0]?.title === "alice")?.[0];
    expect(aliceCard).toBeDefined();

    const reloadPromise = aliceCard.reload();
    act(() => {
      getDefaultStore().set(sessionsAtom, [
        {
          player: "alice",
          updatedAt: 2,
          lichess: { username: "Alice", handle: "native-handle", account: initialAccount },
        },
      ]);
    });

    vi.spyOn(Date, "now").mockReturnValue(88);
    await act(async () => {
      resolveAccount(refreshedAccount);
      await reloadPromise;
    });

    expect(getDefaultStore().get(sessionsAtom)).toEqual([
      {
        player: "alice",
        updatedAt: 88,
        lichess: { username: "Alice", handle: "native-handle", account: refreshedAccount },
      },
    ]);
  });

  test("Lichess handle-less logout removes case-variant Alice/alice duplicates", async () => {
    const unrelatedLichess: Session = {
      player: "Carol",
      updatedAt: 3,
      lichess: { username: "carol", account: { id: "carol", username: "carol" } },
    };
    getDefaultStore().set(sessionsAtom, [
      {
        player: "Alice",
        updatedAt: 1,
        lichess: { username: "Alice", account: { id: "alice", username: "Alice" } },
      },
      {
        player: "alice",
        updatedAt: 2,
        lichess: { username: "alice", account: { id: "alice", username: "alice" } },
      },
      unrelatedLichess,
    ]);

    await renderCards();
    await logout();

    expect(getDefaultStore().get(sessionsAtom)).toEqual([unrelatedLichess]);
  });

  test("removing a player group removes case-variant handle-less Lichess duplicates", async () => {
    const unrelatedLichess: Session = {
      player: "Carol",
      updatedAt: 3,
      lichess: { username: "carol", account: { id: "carol", username: "carol" } },
    };
    getDefaultStore().set(sessionsAtom, [
      {
        player: "Alice",
        updatedAt: 1,
        lichess: { username: "Alice", account: { id: "alice", username: "Alice" } },
      },
      {
        player: "alice",
        updatedAt: 2,
        lichess: { username: "alice", account: { id: "alice", username: "alice" } },
      },
      unrelatedLichess,
    ]);

    await renderCards();
    await removeGroup("Alice");

    expect(getDefaultStore().get(sessionsAtom)).toEqual([unrelatedLichess]);
  });
});
