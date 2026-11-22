import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { OpponentAccount } from "@/bindings";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { OpponentLookup } from "./opponentLookup";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("./opponentLookup", async (original) => ({
  ...(await original<typeof import("./opponentLookup")>()),
  lookupOpponentAccount: mocks.lookup,
}));

// Real catalogue text, so a missing key or a wrong plural shows up here.
let translate: (key: string, options?: Record<string, unknown>) => string;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options),
  }),
}));

import AddOpponentAccount from "./AddOpponentAccount";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
installInlineComputedStyleStub();

let root: Root;
let container: HTMLDivElement;
const onLink = vi.fn();
const onClose = vi.fn();

async function render(linked: OpponentAccount[] = []) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AddOpponentAccount opened onClose={onClose} linked={linked} onLink={onLink} />
      </MantineProvider>,
    ),
  );
}

function button(name: string) {
  const found = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button named ${name}`);
  return found;
}

function hasButton(name: string) {
  return [...document.body.querySelectorAll("button")].some(
    (candidate) => candidate.textContent?.trim() === name,
  );
}

function usernameInput() {
  return document.body.querySelector<HTMLInputElement>("input")!;
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(usernameInput(), value);
    usernameInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(name: string) {
  await act(async () => button(name).click());
}

async function lookUp(username: string, answer: OpponentLookup) {
  mocks.lookup.mockResolvedValueOnce(answer);
  await type(username);
  await click("Look up");
}

function found(overrides: Partial<Extract<OpponentLookup, { kind: "found" }>["profile"]> = {}) {
  return {
    kind: "found",
    profile: { provider: "lichess", username: "DrNykterstein", closed: false, ...overrides },
  } satisfies OpponentLookup;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const i18n = await catalogueI18n("en-US");
  translate = (key, options) => i18n.t(key, options);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("a name the site cannot have is refused before anything is asked", async () => {
  await render();
  await type("a b/c");
  await click("Look up");

  expect(document.body.textContent).toContain("Enter the username as the site shows it.");
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(onLink).not.toHaveBeenCalled();
});

test("shows what the site says about the account and links it in the site's spelling", async () => {
  await render();
  await lookUp(
    " drnykterstein ",
    found({ title: "GM", realName: "Magnus Carlsen", country: "NO", ratedGames: 9876 }),
  );

  expect(mocks.lookup).toHaveBeenCalledWith("lichess", "drnykterstein");
  const profile = document.body.querySelector("[data-opponent-profile]")!;
  expect(profile.textContent).toContain("DrNykterstein");
  expect(profile.textContent).toContain("GM");
  expect(profile.textContent).toContain("Magnus Carlsen, NO");
  expect(profile.textContent).toContain("9876 rated games");
  expect(onLink).not.toHaveBeenCalled();

  await click("Link account");

  expect(onLink).toHaveBeenCalledExactlyOnceWith({
    provider: "lichess",
    username: "DrNykterstein",
  });
  expect(onClose).toHaveBeenCalledOnce();
});

test("one rated game is counted in the singular and an absent count is left out", async () => {
  await render();
  await lookUp("single", found({ ratedGames: 1 }));
  expect(document.body.textContent).toContain("1 rated game");
  expect(document.body.textContent).not.toContain("1 rated games");

  await lookUp("nocount", found());
  expect(document.body.textContent).not.toContain("rated game");
});

test("the chosen site is the one asked, and a closed Chess.com account can still be linked", async () => {
  await render();
  await click("Chess.com");
  mocks.lookup.mockResolvedValueOnce(
    found({ provider: "chesscom", username: "OldAccount", closed: true }),
  );
  await type("oldaccount");
  await click("Look up");

  expect(mocks.lookup).toHaveBeenCalledWith("chesscom", "oldaccount");
  expect(document.body.textContent).toContain(
    "This account is closed. Its games are still available.",
  );

  await click("Link account");

  expect(onLink).toHaveBeenCalledExactlyOnceWith({ provider: "chesscom", username: "OldAccount" });
});

test.each([
  [{ kind: "notFound" }, "Lichess has no account named nobody."],
  [{ kind: "closed" }, "This Lichess account is closed. Its games can no longer be downloaded."],
  [{ kind: "rateLimited" }, "Lichess is limiting requests. Try again in a minute."],
  [{ kind: "failed" }, "The account could not be looked up. Try again."],
] satisfies [OpponentLookup, string][])(
  "a lookup ending in %o shows its message and offers nothing to link",
  async (answer, message) => {
    await render();
    await lookUp("nobody", answer);

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(document.body.querySelector("[data-opponent-profile]")).toBeNull();
    expect(hasButton("Link account")).toBe(false);
    expect(hasButton("Look up")).toBe(true);
    expect(onLink).not.toHaveBeenCalled();
  },
);

test("an account the player already has, in any case, cannot be linked twice", async () => {
  await render([{ provider: "lichess", username: "drnykterstein" }]);
  await lookUp("DrNykterstein", found());

  expect(document.body.textContent).toContain("This account is already linked.");
  expect(button("Link account").disabled).toBe(true);
});

test("an answer to a name that was changed meanwhile is discarded", async () => {
  let answer!: (lookup: OpponentLookup) => void;
  mocks.lookup.mockReturnValueOnce(
    new Promise<OpponentLookup>((resolve) => {
      answer = resolve;
    }),
  );
  await render();
  await type("first");
  await click("Look up");
  await type("second");
  await act(async () => answer(found({ username: "First" })));

  expect(document.body.querySelector("[data-opponent-profile]")).toBeNull();
  expect(hasButton("Look up")).toBe(true);
  expect(button("Look up").disabled).toBe(false);
});

test("changing the name after an answer asks again instead of linking the old answer", async () => {
  await render();
  await lookUp("first", found({ username: "First" }));
  await type("second");

  expect(document.body.querySelector("[data-opponent-profile]")).toBeNull();
  expect(hasButton("Link account")).toBe(false);
});

test("cancel closes without linking and clears what was entered", async () => {
  await render();
  await lookUp("first", found({ username: "First" }));
  await click("Cancel");

  expect(onClose).toHaveBeenCalledOnce();
  expect(onLink).not.toHaveBeenCalled();
  expect(usernameInput().value).toBe("");
});
