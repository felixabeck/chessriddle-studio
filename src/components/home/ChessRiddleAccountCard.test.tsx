import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInstance } from "i18next";
import type { AccountStatus } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { ChessRiddleCommandError } from "@/platform/chessriddle";
import { ChessRiddleAccountCard } from "./ChessRiddleAccountCard";

const mocks = vi.hoisted(() => ({
  chessriddleAccount: vi.fn(),
  connectChessriddle: vi.fn(),
  disconnectChessriddle: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

const connected: AccountStatus = {
  status: "connected",
  account: { handle: "native-account", username: "Alex", plan: "gold", tactic_rating: 1500 },
  durability_uncertain: false,
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.chessriddleAccount.mockResolvedValue({ status: "disconnected" });
  mocks.connectChessriddle.mockResolvedValue(connected);
  mocks.disconnectChessriddle.mockResolvedValue({
    status: "removed",
    revocation_pending: false,
    durability_uncertain: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render(onConnected?: () => void) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <div data-testid="card-content">
          <ChessRiddleAccountCard onConnected={onConnected} />
        </div>
      </MantineProvider>,
    ),
  );
}

test("only explicit successful connect, reconnect and refresh notify the training caller", async () => {
  const onConnected = vi.fn();
  mocks.chessriddleAccount.mockResolvedValue(connected);
  await render(onConnected);
  expect(onConnected).not.toHaveBeenCalled();
  await click("Refresh");
  expect(onConnected).toHaveBeenCalledOnce();
  mocks.chessriddleAccount.mockResolvedValue({ status: "reconnectNeeded" });
  await click("Refresh");
  expect(onConnected).toHaveBeenCalledOnce();
  await click("Reconnect");
  expect(onConnected).toHaveBeenCalledTimes(2);
  mocks.chessriddleAccount.mockResolvedValue({ status: "disconnected" });
  await click("Disconnect");
  expect(onConnected).toHaveBeenCalledTimes(2);
  await click("Connect");
  expect(onConnected).toHaveBeenCalledTimes(3);
});

test("failed card operations keep their error and do not request training", async () => {
  const onConnected = vi.fn();
  await render(onConnected);
  mocks.connectChessriddle.mockRejectedValue("network");
  await click("Connect");
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Network");
  expect(onConnected).not.toHaveBeenCalled();
  mocks.chessriddleAccount.mockRejectedValue("network");
  await click("Refresh");
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Network");
  expect(onConnected).not.toHaveBeenCalled();
});

test.each(["Connect", "Refresh"])(
  "%s with uncertain durability keeps the warning without notifying training",
  async (action) => {
    const onConnected = vi.fn();
    await render(onConnected);
    const uncertain = { ...connected, durability_uncertain: true };
    mocks.connectChessriddle.mockResolvedValue(uncertain);
    mocks.chessriddleAccount.mockResolvedValue(uncertain);
    await click(action);
    expect(host.textContent).toContain("Home.ChessRiddle.ConnectionDurabilityUncertain");
    expect(onConnected).not.toHaveBeenCalled();
  },
);

function button(key: string) {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent === key);
  expect(found).toBeDefined();
  return found!;
}

async function click(key: string) {
  await act(async () => button(`Home.ChessRiddle.${key}`).click());
}

test("unavailable renders nothing and exposes no connect action", async () => {
  mocks.chessriddleAccount.mockRejectedValue(new ChessRiddleCommandError("unavailable"));
  await render();
  const content = host.querySelector('[data-testid="card-content"]')!;
  expect(content.childNodes).toHaveLength(0);
  expect(mocks.connectChessriddle).not.toHaveBeenCalled();
});

test("connect and refresh use native profile and plan without writing web storage", async () => {
  const local = vi.spyOn(Storage.prototype, "setItem");
  try {
    await render();
    expect(host.textContent).toContain("Home.ChessRiddle.Disconnected");
    await click("Connect");
    expect(host.textContent).toContain("Home.ChessRiddle.ConnectedAs");
    expect(host.textContent).toContain("Home.ChessRiddle.PlanGold");
    mocks.chessriddleAccount.mockResolvedValue({
      ...connected,
      account: { ...connected.account, plan: "free", username: null },
    });
    await click("Refresh");
    expect(host.textContent).toContain("Home.ChessRiddle.PlanFree");
    expect(host.textContent).not.toContain("Home.ChessRiddle.ConnectedAs");
    expect(local).not.toHaveBeenCalled();
  } finally {
    local.mockRestore();
  }
});

test("reconnect-needed offers an explicit reconnect", async () => {
  mocks.chessriddleAccount.mockResolvedValue({ status: "reconnectNeeded" });
  await render();
  expect(host.textContent).toContain("Home.ChessRiddle.ReconnectNeeded");
  expect(mocks.connectChessriddle).not.toHaveBeenCalled();
  await click("Reconnect");
  expect(host.textContent).toContain("Home.ChessRiddle.PlanGold");
});

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "disconnect follows native status and independently shows flags %s / %s",
  async (revocation, durability) => {
    mocks.chessriddleAccount.mockResolvedValueOnce(connected);
    mocks.disconnectChessriddle.mockResolvedValue({
      status: "removed",
      revocation_pending: revocation,
      durability_uncertain: durability,
    });
    await render();
    await click("Disconnect");
    expect(mocks.chessriddleAccount).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Home.ChessRiddle.Disconnected");
    expect(host.textContent?.includes("Home.ChessRiddle.RevocationPending")).toBe(revocation);
    expect(host.textContent?.includes("Home.ChessRiddle.RemovalDurabilityUncertain")).toBe(
      durability,
    );
    expect(mocks.disconnectChessriddle).toHaveBeenCalledOnce();
    await click("Refresh");
    expect(mocks.disconnectChessriddle).toHaveBeenCalledOnce();
    expect(host.textContent?.includes("Home.ChessRiddle.RevocationPending")).toBe(revocation);
  },
);

test("failure before local removal keeps connected status and safe error", async () => {
  mocks.chessriddleAccount.mockResolvedValue(connected);
  mocks.disconnectChessriddle.mockRejectedValue(new ChessRiddleCommandError("storage"));
  await render();
  await click("Disconnect");
  expect(host.textContent).toContain("Home.ChessRiddle.ConnectedAs");
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Storage");
  expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
});

test.each(["network", "rateLimited", "server"] as const)(
  "a stored account with unreadable status (%s) can disconnect offline",
  async (error) => {
    mocks.chessriddleAccount.mockResolvedValueOnce({ status: "statusUnreadable", error });
    mocks.disconnectChessriddle.mockResolvedValue({
      status: "removed",
      revocation_pending: true,
      durability_uncertain: false,
    });
    await render();
    expect(host.textContent).toContain("Home.ChessRiddle.StatusUnreadable");
    expect(host.textContent).toContain(`Home.ChessRiddle.Error.${errorKeys[error]}`);
    expect(button("Home.ChessRiddle.Refresh").disabled).toBe(false);
    await click("Disconnect");
    expect(mocks.disconnectChessriddle).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Home.ChessRiddle.Disconnected");
    expect(host.textContent).toContain("Home.ChessRiddle.RevocationPending");
  },
);

test("not-found disconnect still takes its next state from native", async () => {
  mocks.chessriddleAccount.mockResolvedValue(connected);
  mocks.disconnectChessriddle.mockResolvedValue({ status: "notFound" });
  await render();
  await click("Disconnect");
  expect(host.textContent).toContain("Home.ChessRiddle.ConnectedAs");
  expect(mocks.chessriddleAccount).toHaveBeenCalledTimes(2);
});

test("a removed account with a failed status read offers only explicit refresh", async () => {
  mocks.chessriddleAccount
    .mockResolvedValueOnce(connected)
    .mockRejectedValueOnce(new ChessRiddleCommandError("network"));
  await render();
  await click("Disconnect");
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Network");
  expect(host.textContent).not.toContain("Home.ChessRiddle.Connect");
  await click("Refresh");
  expect(host.textContent).toContain("Home.ChessRiddle.Disconnected");
});

test("an interrupted profile fetch after connect reconciles the native account once", async () => {
  const onConnected = vi.fn();
  await render(onConnected);
  mocks.connectChessriddle.mockRejectedValue(new ChessRiddleCommandError("network"));
  mocks.chessriddleAccount.mockResolvedValue(connected);
  await click("Connect");
  expect(host.textContent).toContain("Home.ChessRiddle.ConnectedAs");
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Network");
  expect(mocks.chessriddleAccount).toHaveBeenCalledTimes(2);
  expect(onConnected).not.toHaveBeenCalled();
});

test("connected durability warning asks for recovery after restart", async () => {
  mocks.chessriddleAccount.mockResolvedValue({
    ...connected,
    durability_uncertain: true,
  });
  await render();
  expect(host.textContent).toContain("Home.ChessRiddle.ConnectionDurabilityUncertain");
});

test("a 180-second connect disables actions, never polls and settles after unmount", async () => {
  let finish!: (value: unknown) => void;
  mocks.connectChessriddle.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  vi.useFakeTimers();
  await click("Connect");
  expect(host.textContent).toContain("Home.ChessRiddle.Connecting");
  expect([...host.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180_000);
  });
  expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => finish(connected));
  expect(host.textContent).toBe("");
  expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
});

test("a connect rejection after unmount does not start another native read", async () => {
  let fail!: (cause: unknown) => void;
  mocks.connectChessriddle.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await render();
  await click("Connect");
  await act(async () => root.render(null));
  await act(async () => fail(new Error("network")));
  expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
  expect(host.textContent).toBe("");
});

const errorKeys = {
  busy: "Busy",
  storage: "Storage",
  network: "Network",
  rateLimited: "RateLimited",
  server: "Server",
  authentication: "Authentication",
  browser: "Browser",
  alreadyConnected: "AlreadyConnected",
};

test.each(Object.entries(errorKeys))(
  "native %s becomes its closed translated error",
  async (code, key) => {
    mocks.chessriddleAccount.mockRejectedValue(new ChessRiddleCommandError(code));
    await render();
    expect(host.textContent).toContain(`Home.ChessRiddle.Error.${key}`);
    expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
  },
);

test("arbitrary transport diagnostics are never displayed", async () => {
  mocks.chessriddleAccount.mockRejectedValue(new Error("private server diagnostic"));
  await render();
  expect(host.textContent).toContain("Home.ChessRiddle.Error.Server");
  expect(host.textContent).not.toContain("private server diagnostic");
});

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);
test.each(Object.entries(catalogues))(
  "%s contains all account messages without fallback",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    const primary = catalogues["../../translation/en-US.json"].translation;
    const keys = Object.keys(primary).filter((key) => key.startsWith("Home.ChessRiddle."));
    expect(keys).toHaveLength(24);
    for (const key of keys) {
      expect(i18n.t(key)).not.toBe(key);
      expect(i18n.t(key).trim()).not.toBe("");
    }
  },
);
