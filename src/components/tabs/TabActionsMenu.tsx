import { Menu } from "@mantine/core";
import { Copy, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export function TabActionsMenu({
  tabId,
  onDuplicate,
  onRename,
  onClose,
}: {
  tabId: string;
  onDuplicate: (tabId: string) => void;
  onRename: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Menu.Item leftSection={<Copy size="0.875rem" />} onClick={() => onDuplicate(tabId)}>
        {t("Tab.Duplicate", { defaultValue: "Duplicate tab" })}
      </Menu.Item>
      <Menu.Item leftSection={<Pencil size="0.875rem" />} onClick={() => onRename(tabId)}>
        {t("Tab.Rename", { defaultValue: "Rename tab" })}
      </Menu.Item>
      <Menu.Item color="danger" leftSection={<X size="0.875rem" />} onClick={() => onClose(tabId)}>
        {t("Tab.Close", { defaultValue: "Close tab" })}
      </Menu.Item>
    </>
  );
}
