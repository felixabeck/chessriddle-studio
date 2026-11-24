import { MantineProvider } from "@mantine/core";
import { createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildAssistantTargets, type AssistantTargetActions } from "../targets";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { parseGuideBlocks, parseGuideInline } from "./guideBody";
import { GuideTopicBody } from "./GuideTopicBody";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let host: HTMLDivElement;
let root: Root;

const targets = buildAssistantTargets((key) => key, { platform: "linux", coachEnabled: true });
const actions: AssistantTargetActions = {
  createNewTab: vi.fn(),
  openLibrary: vi.fn(),
  openEngines: vi.fn(),
  openAccounts: vi.fn(),
  openSettings: vi.fn(),
  openFeedback: vi.fn(),
  store: createStore(),
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("parseGuideBlocks parses ordered lists alongside paragraphs and unordered lists", () => {
  const blocks = parseGuideBlocks(
    [
      "Intro paragraph.",
      "",
      "- Bullet one",
      "- Bullet two",
      "",
      "1. First step",
      "2. Second step",
    ].join("\n"),
  );

  expect(blocks).toEqual([
    { kind: "paragraph", text: "Intro paragraph." },
    { kind: "unordered-list", items: ["Bullet one", "Bullet two"] },
    { kind: "ordered-list", items: ["First step", "Second step"] },
  ]);
});

test("parseGuideInline splits inline code spans without stripping inner emphasis markers", () => {
  const segments = parseGuideInline("Press `*` or run `Ctrl+S`.", targets, targets);
  expect(segments).toEqual([
    { kind: "text", text: "Press " },
    { kind: "code", text: "*" },
    { kind: "text", text: " or run " },
    { kind: "code", text: "Ctrl+S" },
    { kind: "text", text: "." },
  ]);
});

test("GuideTopicBody renders ordered lists, inline code, and bold/italic emphasis with no raw syntax left", async () => {
  const body = [
    "Use **bold text** and *italic text*, or press `*` and `Ctrl+S`.",
    "",
    "1. Open **Settings**.",
    "2. Enter `e4` in the field.",
  ].join("\n");

  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GuideTopicBody
          body={body}
          targets={targets}
          fallbackTargets={targets}
          targetActions={actions}
        />
      </MantineProvider>,
    ),
  );

  const ol = host.querySelector("ol");
  expect(ol).not.toBeNull();
  expect(host.querySelector("ul")).toBeNull();
  const listItems = [...ol!.querySelectorAll("li")];
  expect(listItems.map((li) => li.textContent)).toEqual([
    "Open Settings.",
    "Enter e4 in the field.",
  ]);

  const codes = [...host.querySelectorAll("code")].map((node) => node.textContent);
  expect(codes).toEqual(["*", "Ctrl+S", "e4"]);

  const strongs = [...host.querySelectorAll("strong")].map((node) => node.textContent);
  expect(strongs).toEqual(["bold text", "Settings"]);

  const ems = [...host.querySelectorAll("em")].map((node) => node.textContent);
  expect(ems).toEqual(["italic text"]);

  const renderedText = host.textContent ?? "";
  expect(renderedText).not.toContain("`");
  expect(renderedText).not.toContain("**");
});
