import { Button, Group, InputWrapper, Tooltip } from "@mantine/core";
import { useId, type ReactNode } from "react";

interface ToggleButtonGroupProps<T> {
  label: string;
  options: ToggleButtonGroupOption<T>[];
  includeTooltips?: boolean;
  minButtonWidth?: string;
  toggleOption(option: T): void;
}

export interface ToggleButtonGroupOption<T> {
  content: ReactNode;
  name: string;
  value: T;
  isToggled: boolean;
}

function ToggleButtonGroup<T>(props: ToggleButtonGroupProps<T>) {
  const labelId = useId();

  const getButton = (option: ToggleButtonGroupOption<T>) => (
    <Button
      key={option.name}
      variant={option.isToggled ? "filled" : "default"}
      radius={0}
      onClick={() => props.toggleOption(option.value)}
      miw={props.minButtonWidth}
      aria-label={option.name}
      aria-pressed={option.isToggled}
    >
      {option.content}
    </Button>
  );

  return (
    <InputWrapper label={props.label} required={false} labelProps={{ id: labelId }}>
      <Group gap={0} role="group" aria-labelledby={labelId}>
        {props.options.map((option) => {
          if (props.includeTooltips) {
            return (
              <Tooltip label={option.name} key={option.name}>
                {getButton(option)}
              </Tooltip>
            );
          }
          return getButton(option);
        })}
      </Group>
    </InputWrapper>
  );
}

export default ToggleButtonGroup;
