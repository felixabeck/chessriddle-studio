import { Fragment, type ReactNode } from "react";

const EMPHASIS = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

/**
 * Answer prose. The text is the model's and is only ever rendered as text: the two emphasis
 * marks become elements, everything else stays what it is. Paragraph breaks are kept by the
 * surrounding `white-space: pre-wrap`.
 */
export function CoachText({ text }: { text: string }): ReactNode {
  return text.split(EMPHASIS).map((part, index) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
