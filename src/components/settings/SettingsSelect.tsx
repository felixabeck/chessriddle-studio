import { CheckIcon, Combobox, Select, type SelectProps } from "@mantine/core";
import cx from "clsx";
import { useContext, useEffect, useRef } from "react";
import { SettingLabelContext } from "./SettingsLayout";
import classes from "./SettingsSelect.module.css";

export type SettingsSelectProps = SelectProps & {
  /** Temporary hover preview. Closing without choosing restores the committed value. */
  onPreview?: (value: string) => void;
};

export default function SettingsSelect({
  onPreview,
  onDropdownClose,
  onOptionSubmit,
  renderOption,
  value,
  withCheckIcon = true,
  classNames,
  ...props
}: SettingsSelectProps) {
  const inheritedLabel = useContext(SettingLabelContext);
  const committedValue = useRef(value);
  const previewedValue = useRef<string | null>(null);

  useEffect(() => {
    // Preview writes flow back through `value` and must not become the committed value.
    if (previewedValue.current === null) committedValue.current = value;
  }, [value]);

  return (
    <Select
      aria-label={inheritedLabel}
      withCheckIcon={withCheckIcon}
      {...props}
      value={value}
      classNames={
        onPreview
          ? typeof classNames === "function"
            ? (theme, selectProps, ctx) => {
                const resolved = classNames(theme, selectProps, ctx);
                return { ...resolved, option: cx(resolved.option, classes.previewOption) };
              }
            : { ...classNames, option: cx(classNames?.option, classes.previewOption) }
          : classNames
      }
      renderOption={
        onPreview
          ? (item) => (
              <div
                className={classes.previewHit}
                onPointerEnter={() => {
                  previewedValue.current = item.option.value;
                  onPreview(item.option.value);
                }}
              >
                {withCheckIcon && item.checked ? (
                  <CheckIcon className={Combobox.classes.optionsDropdownCheckIcon} />
                ) : null}
                {renderOption ? renderOption(item) : item.option.label}
              </div>
            )
          : renderOption
      }
      onOptionSubmit={
        onPreview
          ? (next) => {
              previewedValue.current = null;
              // Committing the option already being previewed leaves `value` unchanged, so the sync
              // effect does not re-run. Mantine also skips onChange when the controlled value already
              // matches (Select.mjs onOptionSubmit → setValue only if nextValue !== _value).
              committedValue.current = next;
              onOptionSubmit?.(next);
            }
          : onOptionSubmit
      }
      onDropdownClose={
        onPreview
          ? () => {
              if (
                previewedValue.current !== null &&
                previewedValue.current !== committedValue.current
              ) {
                const committed = committedValue.current;
                if (committed != null) onPreview(committed);
              }
              previewedValue.current = null;
              onDropdownClose?.();
            }
          : onDropdownClose
      }
    />
  );
}
