import { Group, Text, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

interface BoardBarProps {
  name: string;
  rating?: string | number | null;
  onNameClick?: () => void;
  height: string;
  children?: ReactNode;
}

export function BoardBar({ name, rating, onNameClick, height, children }: BoardBarProps) {
  const hasPlayerName = name.trim().length > 0 && name !== "?";

  return (
    <Group
      data-board-bar
      ml="2.5rem"
      mr="xs"
      h={height}
      justify="space-between"
      wrap="nowrap"
      align="flex-end"
    >
      <Group gap={6} align="baseline">
        {hasPlayerName &&
          (onNameClick ? (
            <UnstyledButton type="button" onClick={onNameClick}>
              <Text fw="bold" size="md">
                {name}
              </Text>
            </UnstyledButton>
          ) : (
            <Text fw="bold" size="md">
              {name}
            </Text>
          ))}
        {rating && (
          <Text size="xs" c="dimmed">
            ({rating})
          </Text>
        )}
      </Group>

      <Group align="flex-end" wrap="nowrap">
        {children}
      </Group>
    </Group>
  );
}
