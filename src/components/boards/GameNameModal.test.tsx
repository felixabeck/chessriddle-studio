import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree, type GameHeaders } from "@/utils/treeReducer";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/common/AppModal", async () => ({
  default: (await import("@/tests/appModal")).PendingAppModal,
}));

import GameNameModal from "./GameNameModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function headersWith(values: Partial<GameHeaders>): GameHeaders {
  return { ...defaultTree().headers, ...values };
}

async function render(headers: GameHeaders, repertoire: boolean) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <MantineProvider>
        <GameNameModal
          opened
          onClose={onClose}
          headers={headers}
          repertoire={repertoire}
          title="Title"
          confirmLabel="Confirm"
          onConfirm={onConfirm}
        />
      </MantineProvider>,
    ),
  );
  return { onConfirm, onClose };
}

function input(label: string): HTMLInputElement {
  const labelled = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
  const field = labelled && document.getElementById(labelled.htmlFor);
  if (!(field instanceof HTMLInputElement)) throw new Error(`No field labelled ${label}`);
  return field;
}

async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => host.querySelector("form")!.requestSubmit());
}

test("a repertoire line asks for its name and idea, with the cursor in the name", async () => {
  const { onConfirm } = await render(headersWith({ white: "Main", black: "?" }), true);
  expect([...host.querySelectorAll("label")].map((l) => l.textContent)).toEqual([
    "GameInfo.LineName",
    "GameInfo.Idea",
  ]);
  expect(input("GameInfo.LineName").value).toBe("Main");
  expect(input("GameInfo.LineName").hasAttribute("data-autofocus")).toBe(true);
  expect(input("GameInfo.Idea").value).toBe("");

  await type(input("GameInfo.LineName"), "  Two Knights  ");
  await type(input("GameInfo.Idea"), "3...Lg4");
  await submit();

  expect(onConfirm).toHaveBeenCalledWith(headersWith({ white: "Two Knights", black: "3...Lg4" }));
});

test("a line named by its Event edits the Event, so clearing it leaves the line untitled", async () => {
  const headers = headersWith({ white: "", event: "Caro-Kann", black: "?" });
  const { onConfirm } = await render(headers, true);
  expect(input("GameInfo.LineName").value).toBe("Caro-Kann");
  await type(input("GameInfo.LineName"), "");
  await submit();
  expect(onConfirm).toHaveBeenCalledWith({ ...headers, event: "" });
});

test("confirming untouched names keeps every header spelling", async () => {
  const headers = headersWith({ white: "?", event: "Caro-Kann", black: "?" });
  const { onConfirm } = await render(headers, true);
  await submit();
  expect(onConfirm).toHaveBeenCalledWith(headers);
});

test("a game asks for its players and event", async () => {
  const { onConfirm } = await render(headersWith({ white: "?", black: "?", event: "?" }), false);
  expect(input("Fen.White").value).toBe("");
  expect(input("Fen.White").hasAttribute("data-autofocus")).toBe(true);
  expect(input("Databases.Game.Event").value).toBe("");

  await type(input("Fen.White"), "Carlsen");
  await type(input("Fen.Black"), "Nakamura");
  await type(input("Databases.Game.Event"), "Blitz");
  await submit();

  expect(onConfirm).toHaveBeenCalledWith(
    headersWith({ white: "Carlsen", black: "Nakamura", event: "Blitz" }),
  );
});

test("Cancel closes without confirming", async () => {
  const { onConfirm, onClose } = await render(headersWith({}), true);
  const cancel = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Common.Cancel",
  );
  await act(async () => cancel?.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
