import { getDefaultZIndex, Stack, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";
import { chessBaseGuideAtom } from "./chessBaseGuideState";

export default function ChessBaseGuide() {
  const { t } = useTranslation();
  const [mode, setMode] = useAtom(chessBaseGuideAtom);
  useTauriListener(tauriSubscriptions.chessBaseSelected, () => setMode("selected"), {
    onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
  });
  return (
    <AppModal
      opened={mode !== "closed"}
      onClose={() => setMode("closed")}
      title={t("ChessBaseGuide.Title")}
      size="lg"
      zIndex={getDefaultZIndex("modal") + 1}
      className="wrap-anywhere"
    >
      <Stack gap="md">
        {mode === "selected" && <Text fw={500}>{t("ChessBaseGuide.Selected")}</Text>}
        <Text>{t("ChessBaseGuide.Intro")}</Text>
        <Stack component="ol" gap="sm" m={0} pl="lg">
          <Text component="li">{t("ChessBaseGuide.Step1")}</Text>
          <Text component="li">{t("ChessBaseGuide.Step2")}</Text>
          <Text component="li">
            {t("ChessBaseGuide.Step3", {
              importDatabase: t("Library.AddDatabase"),
              local: t("Common.Local"),
            })}
          </Text>
        </Stack>
        <Text fw={600}>{t("ChessBaseGuide.Tips")}</Text>
        <Stack component="ul" gap="sm" m={0} pl="lg">
          <Text component="li">{t("ChessBaseGuide.Tip1")}</Text>
          <Text component="li">{t("ChessBaseGuide.Tip2")}</Text>
          <Text component="li">{t("ChessBaseGuide.Tip3")}</Text>
        </Stack>
      </Stack>
    </AppModal>
  );
}
