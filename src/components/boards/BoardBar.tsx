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
  children,
}: BoardBarProps) {
  const hasPlayerName = name.trim().length > 0 && name !== "?";
  const towardBoard = placement === "above" ? "flex-end" : "flex-start";

  return (
    <Group
      data-board-bar={placement}
      ml="2.5rem"
      mr="xs"
      h={height}
      justify="space-between"
      wrap="nowrap"
      align={towardBoard}
    >
      <Group gap={6} align="baseline">
        {(hasPlayerName || (placeholder && onNameClick)) &&
          (onNameClick ? (
            <UnstyledButton type="button" onClick={onNameClick}>
              <Text fw="bold" size="md" c={hasPlayerName ? undefined : "dimmed"}>
                {hasPlayerName ? name : placeholder}
              </Text>
            </UnstyledButton>
          ) : (
            <Text fw="bold" size="md">
              {name}
            </Text>
          ))}
        {hasPlayerName && detail && (
          <Text size="sm" c="dimmed">
            {detail}
          </Text>
        )}
        {rating && (
          <Text size="xs" c="dimmed">
            ({rating})
          </Text>
        )}
      </Group>

      <Group align={towardBoard} wrap="nowrap">
        {children}
      </Group>
    </Group>
  );
}
