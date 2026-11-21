import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@mantine/core", () => ({
  Typography: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import Comment from "./Comment";
import { parseNotationComment } from "@/utils/commentNotation";
import {
  commentDialectCases,
  commentDomText,
  forbiddenCommentElements,
} from "./tests/commentDialectCases";
import { assertCommentFormatting } from "./tests/assertCommentFormatting";
import { GameReferenceContext } from "./GameReference";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("renders Tiptap underline syntax without enabling raw HTML", async () => {
  await act(async () => {
    root.render(<Comment comment={'++critical++ <img src=x onerror="alert(1)">'} />);
  });

  expect(container.querySelector("u")?.textContent).toBe("critical");
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
});

test("keeps backticks literal and underlines the text between them", async () => {
  await act(async () => root.render(<Comment comment={"`++literal++` and ++underlined++"} />));

  expect(container.querySelector("code")).toBeNull();
  expect(container.textContent).toBe("`literal` and underlined");
  expect([...container.querySelectorAll("u")].map((element) => element.textContent)).toEqual([
    "literal",
    "underlined",
  ]);
});

test.each(commentDialectCases)(
  "renders the inline dialect: $name",
  async ({ input, text, formatting, absent }) => {
    await act(async () => root.render(<Comment comment={input} />));

    expect(commentDomText(container)).toBe(text);
    expect(container.querySelector(forbiddenCommentElements)).toBeNull();
    assertCommentFormatting(container, { text, formatting, absent });
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
  },
);

test.each(["javascript:alert(1)", "data:text/plain,x", "/relative", "ftp://x.y"])(
  "shows the source of a disallowed link %j",
  async (href) => {
    const input = `[x](${href})`;
    await act(async () => root.render(<Comment comment={input} />));
    expect(container.textContent).toBe(input);
    expect(container.querySelector("a")).toBeNull();
  },
);

test.each(["http://x.y", "HTTPS://x.y", "mailto:x@y.test"])(
  "renders an allowed link %j",
  async (href) => {
    await act(async () => root.render(<Comment comment={`[x](${href})`} />));
    expect(container.querySelector("a")?.getAttribute("href")).toBe(href);
  },
);

test("keeps the move-like prefix as text before strong formatting", async () => {
  await act(async () => root.render(<Comment comment="59. **x**" />));

  expect(container.querySelector("span")?.firstChild?.textContent).toBe("59. ");
  expect(container.querySelector("strong")?.textContent).toBe("x");
  expect(container.querySelector(forbiddenCommentElements)).toBeNull();
});

test("decorates across rich formatting, retains every character and activates the correct citation", async () => {
  const activate = vi.fn();
  const first =
    "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat 2022 (3)";
  const second =
    "0-1 Srinath,R (2255)-Deac,B (2690) Titled Tuesday intern op 19th Dec Late Chess.com INT blitz 2023 (6)";
  await act(async () =>
    root.render(
      <GameReferenceContext.Provider value={activate}>
        <Comment
          comment={`Before ${first.replace("Beerdsen,T", "**Beerdsen,T**")} then ${second.replace("Deac,B", "++Deac,B++")} after.`}
        />
      </GameReferenceContext.Provider>,
    ),
  );
  expect(container.textContent).toBe(`Before ${first} then ${second} after.`);
  const buttons = container.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0].querySelector("strong")?.textContent).toBe("Beerdsen,T");
  expect(buttons[1].querySelector("u")?.textContent).toBe("Deac,B");
  await act(async () => buttons[1].click());
  expect(activate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      label: second,
      context: "Titled Tuesday intern op 19th Dec Late Chess.com INT blitz 2023 (6) after.",
      closed: true,
      black: expect.objectContaining({ surname: "Deac" }),
    }),
    undefined,
  );
});

test("leaves an unterminated citation tail outside the action and preserves its text", async () => {
  const activate = vi.fn();
  const label = "0-1 Beerdsen,T (2520)-Bluebaum,M (2651)";
  const context = "BEL-NED 2017 ICCF and this is ordinary preparation prose.";
  const comment = `Before ${label} ${context}`;
  await act(async () =>
    root.render(
      <GameReferenceContext.Provider value={activate}>
        <Comment comment={comment} />
      </GameReferenceContext.Provider>,
    ),
  );

  const button = container.querySelector("button");
  expect(button?.textContent).toBe(label);
  expect(button?.previousSibling?.textContent).toBe("Before ");
  expect(button?.nextSibling?.textContent).toBe(` ${context}`);
  expect(container.textContent).toBe(comment);

  await act(async () => button?.click());
  expect(activate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ label, context }),
    undefined,
  );
});

test("an external link anywhere across a citation keeps its behavior without nested actions", async () => {
  const activate = vi.fn();
  for (const comment of [
    "[0-1 Beerdsen,T-Bluebaum,M](https://example.com/game)",
    "0-1 **[Beerdsen,T](https://example.com/player)**-Bluebaum,M",
  ]) {
    await act(async () =>
      root.render(
        <GameReferenceContext.Provider value={activate}>
          <Comment comment={comment} />
        </GameReferenceContext.Provider>,
      ),
    );
    expect(container.querySelector("a")?.target).toBe("_blank");
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("0-1 Beerdsen,T-Bluebaum,M");
  }
});

test.each(["\n\n", "\n\n\n\n"])(
  "preserves the view's block-space newline and the notation document for %j",
  async (separator) => {
    const source = `**a**${separator}++b++`;
    await act(async () => root.render(<Comment comment={source} />));

    expect(container.firstElementChild?.innerHTML).toBe(
      "<p><strong>a</strong></p>\n<p><u>b</u></p>",
    );
    expect(parseNotationComment(source)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a", marks: [{ type: "bold" }] }] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "b", marks: [{ type: "underline" }] }],
        },
      ],
    });
  },
);

test("wraps formatted siblings together and keeps text outside underline pairs", async () => {
  await act(async () =>
    root.render(
      <Comment comment="before ++a **b** *c* ~~d~~ [e](https://x.y) f++ between ++**g**++ after" />,
    ),
  );

  expect(container.textContent).toBe("before a b c d e f between g after");
  const underlines = container.querySelectorAll("u");
  expect(underlines).toHaveLength(2);
  expect(underlines[0].textContent).toBe("a b c d e f");
  expect(underlines[0].querySelector("strong")?.textContent).toBe("b");
  expect(underlines[0].querySelector("em")?.textContent).toBe("c");
  expect(underlines[0].querySelector("del")?.textContent).toBe("d");
  expect(underlines[0].querySelector('a[href="https://x.y"]')?.textContent).toBe("e");
  expect(underlines[1].querySelector("strong")?.textContent).toBe("g");
});

test.each(["\n", "\n\n"])("does not pair underline delimiters across %j", async (separator) => {
  await act(async () => root.render(<Comment comment={`++a **b**${separator}c++`} />));

  expect(container.textContent?.replace(/\s/g, "")).toBe("++abc++");
  expect(container.querySelector("strong")?.textContent).toBe("b");
  expect(container.querySelector("u")).toBeNull();
});

test("does not pair delimiters in literal tables across a paragraph", async () => {
  const comment =
    "| a | b |\n| --- | --- |\n| ++c | d |\n\noutside **x**\n\n| a | b |\n| --- | --- |\n| c++ | d |";
  await act(async () => root.render(<Comment comment={comment} />));

  expect(container.textContent?.replace(/\s/g, "")).toBe(
    comment.replace("**x**", "x").replace(/\s/g, ""),
  );
  expect(container.querySelector("strong")?.textContent).toBe("x");
  expect(container.querySelector("u")).toBeNull();
  expect(container.querySelector(forbiddenCommentElements)).toBeNull();
});
