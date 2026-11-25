import { Badge } from "@mantine/core";
import type { ReactNode } from "react";

export type LibrarySyncBadgeColor = "gray" | "gold" | "success" | "warning" | "danger";

export function LibrarySyncBadge({
  children,
  color,
  component,
}: {
  children: ReactNode;
  color: LibrarySyncBadgeColor;
  component?: "span";
}) {
  return (
    <Badge
      component={component}
      size="sm"
      color={color}
      styles={{
        root: { height: "auto", flexShrink: 0 },
        label: {
          whiteSpace: "normal",
          overflowWrap: "anywhere",
          color: "var(--cf-foreground)",
        },
      }}
    >
      {children}
    </Badge>
  );
}
