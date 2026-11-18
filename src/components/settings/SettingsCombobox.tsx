import {
  Box,
  Combobox,
  Input,
  InputBase,
  ScrollArea,
  useCombobox,
  VisuallyHidden,
} from "@mantine/core";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

export type SettingsComboboxItem<T extends string> = {
  value: T;
  label: React.ReactNode;
  preview?: React.ReactNode;
};

type SettingsComboboxProps<T extends string> = {
  value: T;
  data: SettingsComboboxItem<T>[];
  onCommit: (value: T) => void;
  onPreview?: (value: T) => void;
  width?: string | number;
  withinPortal?: boolean;
  ariaLabel: string;
};

/**
 * A transactional setting selector. Preview is temporary: closing with Escape
 * or outside click restores the committed value; selecting commits it.
 */
export function SettingsCombobox<T extends string>({
  value,
  data,
  onCommit,
  onPreview,
  width = "12rem",
  withinPortal = false,
  ariaLabel,
}: SettingsComboboxProps<T>) {
  const { t } = useTranslation();
  const committedValue = useRef(value);
  const previewedValue = useRef<T | null>(null);

  useEffect(() => {
    // Preview writes flow back through `value` and must not become the committed value.
    if (previewedValue.current === null) committedValue.current = value;
  }, [value]);

  const restorePreview = () => {
    if (previewedValue.current !== null && previewedValue.current !== committedValue.current) {
      onPreview?.(committedValue.current);
    }
    previewedValue.current = null;
  };

  const combobox = useCombobox({
    onDropdownClose: () => {
      restorePreview();
      combobox.resetSelectedOption();
    },
  });

  const selected = data.find((item) => item.value === value);
  const nameId = useId();
  const valueId = useId();

  return (
    <>
      {/* Named by field and current value ("Piece Set Merida"): an aria-label would replace the
          value, so the field name is a hidden node outside the button, referenced beside it. */}
      <VisuallyHidden id={nameId}>{ariaLabel}</VisuallyHidden>
      <Combobox
        store={combobox}
        withinPortal={withinPortal}
        onOptionSubmit={(nextValue) => {
          const next = nextValue as T;
          previewedValue.current = null;
          // Committing the option already being previewed leaves `value` unchanged, so the sync
          // effect does not re-run.
          committedValue.current = next;
          onCommit(next);
          combobox.closeDropdown();
        }}
      >
        <Combobox.Target>
          <InputBase
            aria-labelledby={`${nameId} ${valueId}`}
            component="button"
            type="button"
            pointer
            onClick={() => combobox.toggleDropdown()}
            w={width}
            maw="100%"
          >
            <Box id={valueId} miw={0}>
              {selected?.preview ?? selected?.label ?? (
                <Input.Placeholder>{t("Common.PickValue")}</Input.Placeholder>
              )}
            </Box>
          </InputBase>
        </Combobox.Target>
        <Combobox.Dropdown>
          <Combobox.Options labelledBy={nameId}>
            <ScrollArea.Autosize mah={200} type="always" scrollbars="y">
              {data.map((item) => (
                <Combobox.Option
                  value={item.value}
                  key={item.value}
                  onMouseEnter={() => {
                    previewedValue.current = item.value;
                    onPreview?.(item.value);
                  }}
                >
                  {item.label}
                </Combobox.Option>
              ))}
            </ScrollArea.Autosize>
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
    </>
  );
}
