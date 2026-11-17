import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";

const lichess = (username: string) => ({ username, account: { id: username, username } });
const sessions = [
  { alias: "GGalileo", updatedAt: 1, lichess: lichess("GGalileo") },
  { alias: "GGalileo", updatedAt: 1, lichess: lichess("GGalileo2") },
  { alias: "GGalileo", updatedAt: 1, chessCom: { username: "GGalile0", stats: {} } },
  // No alias: each account is its own player, so the same name on both sites stays two players.
  { updatedAt: 1, chessCom: { username: "Twin", stats: {} } },
  { updatedAt: 1, lichess: lichess("Twin") },
  { updatedAt: 1, lichess: lichess("Solo") },
];

vi.mock("@/state/atoms", () => ({ sessionsAtom: Symbol("sessions") }));
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => sessions,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./LichessLogo", () => ({ default: () => <span data-lichess-logo /> }));

import { PlayerSelect } from "./PlayerSelect";
import WebsiteAccountSelector from "./PersonalCardPanels/WebsiteAccountSelector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let container: HTMLDivElement;
let root: Root;
// jsdom has no scrollIntoView; Mantine's combobox calls it on the selected option.
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

async function render(node: ReactNode) {
  await act(async () => root.render(<MantineProvider>{node}</MantineProvider>));
}

function logosNear(input: HTMLInputElement): string | null {
  const wrapper = input.closest(".mantine-Input-wrapper") ?? input.parentElement!;
  return wrapper.querySelector("[data-site-logos]")?.getAttribute("data-site-logos") ?? null;
}

/** Each option's label and the sites its logos show, in order; labels can repeat. */
async function openOptions(input: HTMLInputElement): Promise<[string, string | null][]> {
  await act(async () => {
    input.click();
  });
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  return options.map((option) => [
    option.textContent ?? "",
    option.querySelector("[data-site-logos]")?.getAttribute("data-site-logos") ?? null,
  ]);
}

async function choose(input: HTMLInputElement, label: string, sites?: string) {
  await openOptions(input);
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) =>
      candidate.textContent === label &&
      (sites === undefined ||
        candidate.querySelector("[data-site-logos]")?.getAttribute("data-site-logos") === sites),
  )!;
  await act(async () => {
    option.click();
  });
}

function inputWithValue(value: string): HTMLInputElement {
  return Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
    (candidate) => candidate.value === value,
  )!;
}

test("the player dropdown shows the sites of the selected player and of every option", async () => {
  const onChange = vi.fn();
  await render(<PlayerSelect ariaLabel="Player" value="alias:GGalileo" onChange={onChange} />);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Player"]')!;
  expect(input.value).toBe("GGalileo");
  expect(logosNear(input)).toBe("lichess chesscom");

  expect(await openOptions(input)).toEqual([
    ["GGalileo", "lichess chesscom"],
    ["Twin", "chesscom"],
    ["Twin", "lichess"],
    ["Solo", "lichess"],
  ]);
});

test("the same name on Lichess and Chess.com is two players told apart by their logos", async () => {
  const onChange = vi.fn();
  await render(<PlayerSelect ariaLabel="Player" value="chesscom:twin" onChange={onChange} />);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Player"]')!;
  expect(input.value).toBe("Twin");
  expect(logosNear(input)).toBe("chesscom");

  await choose(input, "Twin", "lichess");
  expect(onChange).toHaveBeenLastCalledWith("lichess:twin");

  await render(<PlayerSelect ariaLabel="Player" value="lichess:twin" onChange={onChange} />);
  expect(input.value).toBe("Twin");
  expect(logosNear(input)).toBe("lichess");
});

test("the website filter shows the selected site, and All websites shows every site of the player", async () => {
  await render(
    <WebsiteAccountSelector
      playerKey="alias:GGalileo"
      allowAll
      onWebsiteChange={vi.fn()}
      onAccountChange={vi.fn()}
    />,
  );
  const input = inputWithValue("Home.Accounts.AllWebsites");
  expect(logosNear(input)).toBe("lichess chesscom");

  expect(await openOptions(input)).toEqual([
    ["Home.Accounts.AllWebsites", "lichess chesscom"],
    ["Chess.com", "chesscom"],
    ["Lichess", "lichess"],
  ]);

  await choose(input, "Lichess");
  expect(input.value).toBe("Lichess");
  expect(logosNear(input)).toBe("lichess");
});

test("the website filter of an account without an alias lists only that account's site", async () => {
  await render(
    <WebsiteAccountSelector
      playerKey="lichess:twin"
      allowAll={false}
      onWebsiteChange={vi.fn()}
      onAccountChange={vi.fn()}
    />,
  );
  const input = inputWithValue("Lichess");
  expect(await openOptions(input)).toEqual([["Lichess", "lichess"]]);
});

test("switching to a player without the selected website or account resets the filter", async () => {
  const onWebsiteChange = vi.fn();
  const onAccountChange = vi.fn();
  const selector = (playerKey: string) => (
    <WebsiteAccountSelector
      playerKey={playerKey}
      allowAll={false}
      onWebsiteChange={onWebsiteChange}
      onAccountChange={onAccountChange}
    />
  );
  await render(selector("alias:GGalileo"));
  await choose(inputWithValue("Chess.com"), "Lichess");
  await choose(inputWithValue("Home.Accounts.AllAccounts"), "GGalileo2");
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Lichess");
  expect(onAccountChange).toHaveBeenLastCalledWith("GGalileo2");

  // Solo has Lichess but not the account GGalileo2.
  await render(selector("lichess:solo"));
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Lichess");
  expect(onAccountChange).toHaveBeenLastCalledWith("All accounts");

  // The Chess.com Twin has no Lichess account at all.
  await render(selector("chesscom:twin"));
  const website = inputWithValue("Chess.com");
  expect(logosNear(website)).toBe("chesscom");
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Chess.com");
  expect(onAccountChange).toHaveBeenLastCalledWith("All accounts");
});
