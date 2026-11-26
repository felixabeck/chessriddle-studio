import { Button, Input, Text } from "@mantine/core";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconAction } from "../common/IconAction";
import classes from "./DirectorySetting.module.css";

type DirectorySettingProps = {
  value: string | null | undefined;
  onSelect: (directory: string) => Promise<void> | void;
  /** Native code issues an opaque workspace capability and returns display metadata, or null if cancelled. */
  issueWorkspace: () => Promise<string | null>;
  onShowInFolder?: () => Promise<void> | void;
  onRestoreDefault?: () => Promise<string | null> | void;
  showRestoreDefault?: boolean;
  onError?: (error: unknown) => void;
  disabled?: boolean;
};

/** Shared, validated directory picker with a semantic button target. */
export function DirectorySetting({
  value,
  onSelect,
  issueWorkspace,
  onShowInFolder,
  onRestoreDefault,
  showRestoreDefault = false,
  onError,
  disabled = false,
}: DirectorySettingProps) {
  const { t } = useTranslation();
  const { pending, run } = useSingleFlight();
  const showFolder = useSingleFlight();
  const restore = useSingleFlight();

  const chooseDirectory = () =>
    run(async () => {
      try {
        const selected = await issueWorkspace();
        if (typeof selected === "string" && selected.trim()) await onSelect(selected);
      } catch (error) {
        onError?.(error);
      }
    });

  const openFolder = () =>
    showFolder.run(async () => {
      try {
        await onShowInFolder?.();
      } catch (error) {
        onError?.(error);
      }
    });

  const restoreDefault = () =>
    restore.run(async () => {
      try {
        const restored = await onRestoreDefault?.();
        if (typeof restored === "string" && restored.trim()) await onSelect(restored);
      } catch (error) {
        onError?.(error);
      }
    });

  const busy = disabled || pending || restore.pending;

  const picker = (
    <Input
      component="button"
      type="button"
      aria-label={t("Settings.Directories.Select")}
      aria-busy={pending || restore.pending || undefined}
      onClick={() => void chooseDirectory()}
      disabled={busy}
      w="min(100%, 22rem)"
      miw={0}
      classNames={{ wrapper: classes.wrapper, input: classes.input }}
    >
      <Text className={classes.label}>
        {pending || restore.pending || value === undefined
          ? t("Common.Loading")
          : value || t("Settings.Directories.Select")}
      </Text>
    </Input>
  );

  if (!onShowInFolder && !(showRestoreDefault && onRestoreDefault)) return picker;

  return (
    <div className={classes.row}>
      {onShowInFolder && (
        <IconAction
          label={t("Settings.Directories.ShowInFolder")}
          onClick={() => void openFolder()}
          disabled={disabled || showFolder.pending || value == null}
          pending={showFolder.pending}
        >
          <Folder size="1.25rem" />
        </IconAction>
      )}
      {picker}
      {showRestoreDefault && onRestoreDefault && (
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => void restoreDefault()}
          disabled={busy}
          loading={restore.pending}
          style={{ flexShrink: 0 }}
        >
          {t("Settings.Directories.RestoreDefault")}
        </Button>
      )}
    </div>
  );
}
