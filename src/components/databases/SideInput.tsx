import { Menu, Tooltip, UnstyledButton } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Sides } from "@/utils/db";
import classes from "./SideInput.module.css";

function SideSwatch({ color }: { color: string }) {
  return <span aria-hidden="true" className={classes.swatch} data-side={color} />;
}

export function SideInput({
  role,
  sides,
  setSides,
}: {
  role: "player" | "opponent";
  sides: Sides;
  setSides: (val: Sides) => void;
}) {
  const { t } = useTranslation();
  const data = [
    { label: t("Fen.White"), color: "white" },
    { label: t("Fen.Black"), color: "black" },
    { label: t("Board.Database.Local.Result.Any"), color: "gray" },
  ];
  const selected =
    (sides === "WhiteBlack" && role === "player") || (sides === "BlackWhite" && role === "opponent")
      ? data[0]
      : sides === "Any"
        ? data[2]
        : data[1];
  const setSelected = (item: (typeof data)[number]) => {
    if (
      (item.color === "white" && role === "player") ||
      (item.color === "black" && role === "opponent")
    ) {
      setSides("WhiteBlack");
    } else if (item.color === "gray") {
      setSides("Any");
    } else {
      setSides("BlackWhite");
    }
  };
  const items = data.map((item) => (
    <Menu.Item
      leftSection={<SideSwatch color={item.color} />}
      onClick={() => setSelected(item)}
      key={item.label}
    >
      {item.label}
    </Menu.Item>
  ));
  const label =
    role === "player"
      ? t("Board.Database.Local.PlayerColour", { side: selected.label })
      : t("Board.Database.Local.OpponentColour", { side: selected.label });

  return (
    <Menu>
      <Menu.Target>
        <Tooltip label={label}>
          <UnstyledButton className={classes.control} aria-label={label}>
            <SideSwatch color={selected.color} />
            <span className={classes.label}>{selected.label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </UnstyledButton>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>{items}</Menu.Dropdown>
    </Menu>
  );
}
