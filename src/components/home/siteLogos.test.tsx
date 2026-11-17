import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";

const sessions = [
  {
    player: "GGalileo",
    updatedAt: 1,
    lichess: { username: "GGalileo", account: { id: "ggalileo", username: "GGalileo" } },
  },
  { player: "GGalileo", updatedAt: 1, chessCom: { username: "GGalile0", stats: {} } },
  { player: "Lena", updatedAt: 1, chessCom: { username: "Lena", stats: {} } },
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

test("the player dropdown shows the sites of the selected player and of every option", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <PlayerSelect label="Player" value="GGalileo" onChange={vi.fn()} />
      </MantineProvider>,
    ),
  );
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Player"]')!;
  expect(input.value).toBe("GGalileo");
  expect(logosNear(input)).toBe("lichess chesscom");

  const options = await openOptions(input);
  expect(options).toEqual(
    new Map([
      ["GGalileo", "lichess chesscom"],
      ["Lena", "chesscom"],
    ]),
  );
});

test("the website filter shows the selected site, and All websites shows every site of the player", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <WebsiteAccountSelector
          playerName="GGalileo"
          allowAll
          onWebsiteChange={vi.fn()}
          onAccountChange={vi.fn()}
        />
      </MantineProvider>,
    ),
  );
  const input = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
    (candidate) => candidate.value === "Home.Accounts.AllWebsites",
  )!;
  expect(logosNear(input)).toBe("lichess chesscom");

  const options = await openOptions(input);
  expect(options).toEqual(
    new Map([
      ["Home.Accounts.AllWebsites", "lichess chesscom"],
      ["Chess.com", "chesscom"],
      ["Lichess", "lichess"],
    ]),
  );

  const lichess = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent === "Lichess",
  )!;
  await act(async () => {
    lichess.click();
  });
  expect(input.value).toBe("Lichess");
  expect(logosNear(input)).toBe("lichess");
});
