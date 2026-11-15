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
    <Tooltip label={explanation} multiline w={260}>
      {disabled ? <span>{children}</span> : children}
    </Tooltip>
  );
}
