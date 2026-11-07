import { tauri } from "@/platform/tauri";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { Autocomplete } from "@mantine/core";
import { Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DatabaseHandle, type Player } from "@/bindings";
import { query_players } from "@/utils/db";
import classes from "./SideInput.module.css";

export function PlayerSearchInput({
  label,
  value,
  file,
  rightSection,
  setValue,
}: {
  label: string;
  value?: number;
  file: DatabaseHandle;
  rightSection?: ReactNode;
  setValue: (val: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const [tempValue, setTempValue] = useState("");
  const [data, setData] = useState<Player[]>([]);
  const playerLookupVersion = useRef(0);
  const searchController = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      playerLookupVersion.current += 1;
      searchController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    playerLookupVersion.current += 1;
    searchController.current?.abort();
    searchController.current = null;
    setData([]);
  }, [file]);

  useEffect(() => {
    const lookupVersion = ++playerLookupVersion.current;
    if (value === undefined) {
      setTempValue("");
      return;
    }

    tauri
      .getPlayer(file, value)
      .then((res) => {
        if (playerLookupVersion.current !== lookupVersion) return;
        const player = res;
        if (player?.name) {
          setTempValue(player.name);
        }
      })
      .catch((cause) => {
        if (playerLookupVersion.current !== lookupVersion) return;
        notifyUnlessCancelled(t("Common.Error"), cause);
      });
  }, [file, t, value]);

  async function handleChange(val: string) {
    const lookupVersion = ++playerLookupVersion.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setTempValue(val);
    if (val.trim().length === 0) {
      setValue(undefined);
      setData([]);
      return;
    }
    const player = data.find((player) => player.name === val);
    if (player) {
      setValue(player.id);
    }

    try {
      const res = await query_players(
        file,
        {
          name: val,
          options: {
            page: 1,
            pageSize: 5,
            skipCount: true,
            sort: "elo",
            direction: "asc",
          },
        },
        { signal: controller.signal },
      );
      if (playerLookupVersion.current === lookupVersion && !controller.signal.aborted) {
        setData(res.data);
      }
    } catch (cause) {
      if (playerLookupVersion.current === lookupVersion && !controller.signal.aborted) {
        notifyUnlessCancelled(t("Common.Error"), cause);
      }
    }
  }
  return (
    <Autocomplete
      value={tempValue}
      data={data.map((player) => player.name!)}
      onChange={handleChange}
      rightSection={rightSection}
      classNames={rightSection ? { root: classes.field, wrapper: classes.inputWrapper } : undefined}
      leftSection={<Search size="1rem" />}
      placeholder={label}
    />
  );
}
