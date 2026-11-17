import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";

const lichess = (username: string) => ({ username, account: { id: username, username } });
const sessions = [
  { player: "GGalileo", updatedAt: 1, lichess: lichess("GGalileo") },
  { player: "GGalileo", updatedAt: 1, lichess: lichess("GGalileo2") },
  { player: "GGalileo", updatedAt: 1, chessCom: { username: "GGalile0", stats: {} } },
  { player: "Lena", updatedAt: 1, chessCom: { username: "Lena", stats: {} } },
  // No player alias: grouped under its Lichess username, as the statistics card groups it.
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

async function openOptions(input: HTMLInputElement): Promise<Map<string, string | null>> {
  await act(async () => {
    input.click();
  });
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  return new Map(
    options.map((option) => [
      option.textContent ?? "",
      option.querySelector("[data-site-logos]")?.getAttribute("data-site-logos") ?? null,
    ]),
  );
}

async function choose(input: HTMLInputElement, label: string) {
  await openOptions(input);
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent === label,
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
  await render(<PlayerSelect ariaLabel="Player" value="GGalileo" onChange={onChange} />);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Player"]')!;
  expect(input.value).toBe("GGalileo");
  expect(logosNear(input)).toBe("lichess chesscom");

  expect(await openOptions(input)).toEqual(
    new Map([
      ["GGalileo", "lichess chesscom"],
      ["Lena", "chesscom"],
      ["Solo", "lichess"],
    ]),
  );

  await choose(input, "Lena");
  expect(onChange).toHaveBeenLastCalledWith("Lena");

  await render(<PlayerSelect ariaLabel="Player" value="Lena" onChange={onChange} />);
  expect(input.value).toBe("Lena");
  expect(logosNear(input)).toBe("chesscom");
});

test("the website filter shows the selected site, and All websites shows every site of the player", async () => {
  await render(
    <WebsiteAccountSelector
      playerName="GGalileo"
      allowAll
      onWebsiteChange={vi.fn()}
      onAccountChange={vi.fn()}
    />,
  );
  const input = inputWithValue("Home.Accounts.AllWebsites");
  expect(logosNear(input)).toBe("lichess chesscom");

  expect(await openOptions(input)).toEqual(
    new Map([
      ["Home.Accounts.AllWebsites", "lichess chesscom"],
      ["Chess.com", "chesscom"],
      ["Lichess", "lichess"],
    ]),
  );

  await choose(input, "Lichess");
  expect(input.value).toBe("Lichess");
  expect(logosNear(input)).toBe("lichess");
});

test("the website filter lists the sites of a player grouped under its username", async () => {
  await render(
    <WebsiteAccountSelector
      playerName="Solo"
      allowAll={false}
      onWebsiteChange={vi.fn()}
      onAccountChange={vi.fn()}
    />,
  );
  const input = inputWithValue("Lichess");
  expect(await openOptions(input)).toEqual(new Map([["Lichess", "lichess"]]));
});

test("switching to a player without the selected website or account resets the filter", async () => {
  const onWebsiteChange = vi.fn();
  const onAccountChange = vi.fn();
  const selector = (playerName: string) => (
    <WebsiteAccountSelector
      playerName={playerName}
      allowAll={false}
      onWebsiteChange={onWebsiteChange}
      onAccountChange={onAccountChange}
    />
  );
  await render(selector("GGalileo"));
  await choose(inputWithValue("Chess.com"), "Lichess");
  await choose(inputWithValue("Home.Accounts.AllAccounts"), "GGalileo2");
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Lichess");
  expect(onAccountChange).toHaveBeenLastCalledWith("GGalileo2");

  // Solo has Lichess but not the account GGalileo2.
  await render(selector("Solo"));
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Lichess");
  expect(onAccountChange).toHaveBeenLastCalledWith("All accounts");

  // Lena has no Lichess account at all.
  await render(selector("Lena"));
  const website = inputWithValue("Chess.com");
  expect(logosNear(website)).toBe("chesscom");
  expect(onWebsiteChange).toHaveBeenLastCalledWith("Chess.com");
  expect(onAccountChange).toHaveBeenLastCalledWith("All accounts");
});
