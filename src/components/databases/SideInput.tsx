import { Menu, Tooltip, UnstyledButton } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Sides } from "@/utils/db";
import classes from "./SideInput.module.css";

function SideSwatch({ side }: { side: "white" | "black" | "any" }) {
  return <span aria-hidden="true" className={classes.swatch} data-side={side} />;
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
    { label: t("Fen.White"), side: "white" },
    { label: t("Fen.Black"), side: "black" },
    { label: t("Board.Database.Local.Result.Any"), side: "any" },
  ] as const;
  const selected =
    (sides === "WhiteBlack" && role === "player") || (sides === "BlackWhite" && role === "opponent")
      ? data[0]
      : sides === "Any"
        ? data[2]
        : data[1];
  const setSelected = (item: (typeof data)[number]) => {
    if (
      (item.side === "white" && role === "player") ||
      (item.side === "black" && role === "opponent")
    ) {
      setSides("WhiteBlack");
    } else if (item.side === "any") {
      setSides("Any");
    } else {
      setSides("BlackWhite");
    }
  };
  const items = data.map((item) => (
    <Menu.Item
      leftSection={<SideSwatch side={item.side} />}
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
      <Tooltip label={label}>
        <Menu.Target>
          <UnstyledButton className={classes.control} aria-label={label}>
            <SideSwatch side={selected.side} />
            <span className={classes.label}>{selected.label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </UnstyledButton>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>{items}</Menu.Dropdown>
    </Menu>
  );
}
