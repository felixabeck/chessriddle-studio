import { Group, Text, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

interface BoardBarProps {
  name: string;
  /** Muted secondary text after the name, such as a repertoire line's idea. */
  detail?: string;
  rating?: string | number | null;
  onNameClick?: () => void;
  /** Muted text shown in place of an empty name, for a name that can be set by clicking it. */
  placeholder?: string;
  height: string;
  /** Which side of the board the bar sits on; its content always hugs the board. */
  placement: "above" | "below";
  /** Board action controls rendered at the right end of the bar, after material and clock. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function BoardBar({
  name,
  detail,
  rating,
  onNameClick,
  placeholder,
  height,
  placement,
  actions,
  children,
}: BoardBarProps) {
  const hasPlayerName = name.trim().length > 0 && name !== "?";
  const towardBoard = placement === "above" ? "flex-end" : "flex-start";

  return (
    <Group
      data-board-bar={placement}
      pl="var(--board-bar-inset, 2.5rem)"
      pr="xs"
      w="100%"
      miw={0}
      h={height}
      justify="space-between"
      wrap="nowrap"
      align={towardBoard}
      gap="xs"
    >
      <Group gap={6} align="baseline" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 auto" }}>
        {(hasPlayerName || (placeholder && onNameClick)) &&
          (onNameClick ? (
            <UnstyledButton
              type="button"
              onClick={onNameClick}
              style={{ minWidth: 0, maxWidth: "100%" }}
            >
              <Text fw="bold" size="md" truncate c={hasPlayerName ? undefined : "dimmed"}>
                {hasPlayerName ? name : placeholder}
              </Text>
            </UnstyledButton>
          ) : (
            <Text fw="bold" size="md" truncate>
              {name}
            </Text>
          ))}
        {hasPlayerName && detail && (
          <Text size="sm" c="dimmed" truncate style={{ flexShrink: 1, minWidth: 0 }}>
            {detail}
          </Text>
        )}
        {rating && (
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            ({rating})
          </Text>
        )}
      </Group>

      <Group align={towardBoard} wrap="nowrap" gap="xs" style={{ flex: "0 1 auto", minWidth: 0 }}>
        {children}
        {actions}
      </Group>
    </Group>
  );
}
