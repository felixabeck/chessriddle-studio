import { Text } from "@mantine/core";
import AppModal from "./common/AppModal";
import ExternalLink from "./common/ExternalLink";
import { getTauriVersion, getVersion } from "@/platform/native";
import { arch, osType, OSVersion } from "@/platform/native";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { PRODUCT_NAME, REPOSITORY_URL } from "@/utils/product.json";

function AboutModal({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const errorTitle = t("Common.Error");
  const [info, setInfo] = useState<{
    version: string;
    tauri: string;
    os: string;
    architecture: string;
    osVersion: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [os, version, tauri, architecture, osVersion] = await Promise.all([
          osType(),
          getVersion(),
          getTauriVersion(),
          arch(),
          OSVersion(),
        ]);
        if (active) setInfo({ version, tauri, os, architecture, osVersion });
      } catch (error) {
        if (active) notifyUnlessCancelled(errorTitle, error);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [errorTitle]);
  const unknown = t("Common.Unknown");
  return (
    <AppModal centered opened={opened} onClose={() => setOpened(false)} title={PRODUCT_NAME}>
      <Text>
        {t("Common.Version")}: {info?.version ?? unknown}
      </Text>
      <Text>
        {t("About.TauriVersion")}: {info?.tauri ?? unknown}
      </Text>
      <Text>
        {t("About.OperatingSystem")}:{" "}
        {info ? `${info.os} ${info.architecture} ${info.osVersion}` : unknown}
      </Text>

      <Text size="xs" c="dimmed">
        {t("About.ModificationNotice", { date: "2026-08-09" })}
      </Text>

      <br />

      <ExternalLink href={REPOSITORY_URL} style={{ overflowWrap: "anywhere" }}>
        {REPOSITORY_URL}
      </ExternalLink>
    </AppModal>
  );
}

export default AboutModal;
