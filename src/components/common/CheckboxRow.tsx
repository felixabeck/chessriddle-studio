import { Checkbox, type CheckboxProps, Group, type GroupProps } from "@mantine/core";

// Mantine puts a label 12px from its box; in a horizontal row with a similar gap, a label reads as
// belonging to the next box. A row keeps each label close to its own box and far from the next.
const ROW_GAP = "lg";
const LABEL_OFFSET = "calc(var(--mantine-spacing-xs) / 2)";

function CheckboxRow({ children, ...props }: Omit<GroupProps, "gap" | "wrap">) {
  return (
    <Group gap={ROW_GAP} wrap="wrap" {...props}>
      {children}
    </Group>
  );
}

// The offset variable also positions the description and error, so they stay aligned with the label.
// Labels sit on the right; a left label would take the right-hand offset, so the type rules it out.
function CheckboxRowItem(props: Omit<CheckboxProps, "styles" | "labelPosition">) {
  return (
    <Checkbox size="xs" styles={{ root: { "--label-offset-start": LABEL_OFFSET } }} {...props} />
  );
}

CheckboxRow.Item = CheckboxRowItem;

export { CheckboxRow };
