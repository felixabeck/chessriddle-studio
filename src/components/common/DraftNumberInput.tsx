import { NumberInput, type NumberInputProps } from "@mantine/core";
import { type FocusEvent, useState } from "react";

/**
 * The text of a controlled Mantine `NumberInput` while it is being edited.
 *
 * Mantine only resyncs the field's text when its `value` prop changes, and its
 * blur clamp works on that prop. A caller that stores only valid numbers and
 * passes the stored number straight back would leave a cleared or rejected
 * draft on screen after blur while the old value stays in effect. Holding the
 * draft here lets Mantine clamp what was typed on blur (that value reaches
 * `onChange` first), and blur then drops whatever was never stored so the
 * field shows the stored value again.
 */
export function useNumberInputDraft(stored: number) {
  const [draft, setDraft] = useState<number | string | null>(null);
  return {
    value: draft ?? stored,
    track: setDraft,
    reset: () => setDraft(null),
  };
}

type DraftNumberInputProps = Omit<NumberInputProps, "value"> & { value: number };

/** A `NumberInput` whose `value` is the stored number; see `useNumberInputDraft`. */
export default function DraftNumberInput({
  value,
  onChange,
  onBlur,
  ...props
}: DraftNumberInputProps) {
  const draft = useNumberInputDraft(value);
  return (
    <NumberInput
      {...props}
      value={draft.value}
      onChange={(next) => {
        draft.track(next);
        onChange?.(next);
      }}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        draft.reset();
        onBlur?.(event);
      }}
    />
  );
}
