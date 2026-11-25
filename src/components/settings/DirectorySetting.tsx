import { Input, Text } from "@mantine/core";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconAction } from "../common/IconAction";
import classes from "./DirectorySetting.module.css";

type DirectorySettingProps = {
  value: string | null | undefined;
  onSelect: (directory: string) => Promise<void> | void;
  /** Native code issues an opaque workspace capability and returns display metadata. */
  issueWorkspace: () => Promise<string>;
  onShowInFolder?: () => Promise<void> | void;
  onError?: (error: unknown) => void;
  disabled?: boolean;
};

/** Shared, validated directory picker with a semantic button target. */
export function DirectorySetting({
  value,
  onSelect,
  issueWorkspace,
  onShowInFolder,
  onError,
  disabled = false,
}: DirectorySettingProps) {
  const { t } = useTranslation();
  const { pending, run } = useSingleFlight();
  const showFolder = useSingleFlight();

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

  const picker = (
    <Input
      component="button"
      type="button"
      aria-label={t("Settings.Directories.Select")}
      aria-busy={pending || undefined}
      onClick={() => void chooseDirectory()}
      disabled={disabled || pending}
      w="min(100%, 22rem)"
      miw={0}
      classNames={{ wrapper: classes.wrapper, input: classes.input }}
    >
      <Text className={classes.label}>
        {pending || value === undefined
          ? t("Common.Loading")
          : value || t("Settings.Directories.Select")}
      </Text>
    </Input>
  );

  if (!onShowInFolder) return picker;

  return (
    <div className={classes.row}>
      <IconAction
        label={t("Settings.Directories.ShowInFolder")}
        onClick={() => void openFolder()}
        disabled={disabled || showFolder.pending || value == null}
        pending={showFolder.pending}
      >
        <Folder size="1.25rem" />
      </IconAction>
      {picker}
    </div>
  );
}
