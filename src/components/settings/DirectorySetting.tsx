import { Input, Text } from "@mantine/core";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { useTranslation } from "react-i18next";

type DirectorySettingProps = {
  value: string | null | undefined;
  onSelect: (directory: string) => Promise<void> | void;
  /** Native code issues an opaque workspace capability and returns display metadata. */
  issueWorkspace: () => Promise<string>;
  onError?: (error: unknown) => void;
  disabled?: boolean;
};

/** Shared, validated directory picker with a semantic button target. */
export function DirectorySetting({
  value,
  onSelect,
  issueWorkspace,
  onError,
  disabled = false,
}: DirectorySettingProps) {
  const { t } = useTranslation();
  const { pending, run } = useSingleFlight();

  const chooseDirectory = () =>
    run(async () => {
      try {
        const selected = await issueWorkspace();
        if (typeof selected === "string" && selected.trim()) await onSelect(selected);
      } catch (error) {
        onError?.(error);
      }
    });

  return (
    <Input
      component="button"
      type="button"
      aria-label={t("Settings.Directories.Select")}
      aria-busy={pending || undefined}
      onClick={() => void chooseDirectory()}
      disabled={disabled || pending}
      w="min(100%, 22rem)"
    >
      <Text lineClamp={1}>
        {pending || value === undefined
          ? t("Common.Loading")
          : value || t("Settings.Directories.Select")}
      </Text>
    </Input>
  );
}
