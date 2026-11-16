import { Tooltip } from "@mantine/core";
import type { ReactElement } from "react";

/**
 * A text button with a hover explanation of what it does. A disabled button
 * swallows pointer events, so it is wrapped in a span to keep the explanation
 * reachable, the same way `@/components/common/IconAction` does.
 */
export default function ExplainedAction({
  explanation,
  disabled = false,
  children,
}: {
  explanation: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip
      label={explanation}
      multiline
      // 260 is rem-based (16.25rem). At 200% type that is 520px, wider than a 320px window.
      // Cap to the viewport and pin with shift/flip so the explanation cannot widen the page.
      w="min(16.25rem, calc(100vw - 16px))"
      maw="calc(100vw - 16px)"
      withinPortal
      floatingStrategy="fixed"
      middlewares={{ flip: true, shift: true, inline: false }}
    >
      {disabled ? <span>{children}</span> : children}
    </Tooltip>
  );
}
