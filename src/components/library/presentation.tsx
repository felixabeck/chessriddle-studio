import { wrappingButton } from "@/components/common/wrappingButton";
import { Badge, Group, Text, type BadgeProps } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./Library.module.css";

export { classes as libraryClasses };

export const libraryButtonProps = { color: "gold", styles: wrappingButton } as const;

// The default variant with a foreground label keeps destructive Library actions above AA
// contrast in the dark theme, where the filled danger fill measures 3.29:1.
export const libraryDangerButtonProps = {
  ...libraryButtonProps,
  variant: "default",
  color: "danger",
  c: "var(--cf-foreground)",
} as const;

export function LibrarySectionHeading({
  children,
  count,
  icon,
}: {
  children: ReactNode;
  count: number;
  icon?: ReactNode;
}) {
  return (
    <Group
      component="h2"
      m={0}
      px="xs"
      pt="xs"
      pb="sm"
      justify="space-between"
      gap="xs"
      role="presentation"
    >
      <Group component="span" gap="xs" miw={0} wrap="nowrap">
        {icon && (
          <span className={classes.sectionIcon} aria-hidden>
            {icon}
          </span>
        )}
        <Text component="span" size="sm" fw={600} miw={0} style={{ overflowWrap: "anywhere" }}>
          {children}
        </Text>
      </Group>
      <Badge component="span" size="xs" color="gray">
        {count}
      </Badge>
    </Group>
  );
}

export function LibraryTypeBadge({
  children,
  size = "xs",
}: {
  children: ReactNode;
  size?: BadgeProps["size"];
}) {
  return (
    <Badge
      size={size}
      color="gold"
      maw="100%"
      styles={{
        root: { height: "auto" },
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

/** The column captions of the Databases section, aligned with `libraryClasses.databaseCard`. */
export function LibraryDatabaseColumns({
  name,
  games,
  storage,
  reference,
}: {
  name: string;
  games: string;
  storage: string;
  reference: string;
}) {
  return (
    <div
      className={`${classes.databaseColumns} ${classes.columnCaption}`}
      aria-hidden
      data-library-columns
    >
      <span>{name}</span>
      <span>{games}</span>
      <span>{storage}</span>
      <span>{reference}</span>
    </div>
  );
}
