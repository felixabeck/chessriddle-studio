import { tauri } from "@/platform/tauri";
import { rem, Slider } from "@mantine/core";
import { GripVertical } from "lucide-react";
import { useEffect, useState } from "react";
import useSWRImmutable from "swr/immutable";
import { formatBytes } from "@/utils/format";

export default function HashSlider(props: {
  value: number;
  setValue: (v: number) => void;
  color?: string;
  ariaLabel?: string;
}) {
  const [tempValue, setTempValue] = useState(Math.log2(props.value));

  useEffect(() => {
    setTempValue(Math.log2(props.value));
  }, [props.value]);

  const { data: memorySize } = useSWRImmutable("memory", async () => {
    return (await tauri.memorySize()) / 2;
  });

  return (
    <Slider
      min={0}
      max={Math.log2(memorySize || 16)}
      color={props.color}
      value={tempValue}
      onChange={setTempValue}
      onChangeEnd={(v) => props.setValue(2 ** v)}
      label={(v) => formatBytes(2 ** v * 1024 * 1024)}
      thumbLabel={props.ariaLabel}
      thumbChildren={<GripVertical style={{ width: rem(20), height: rem(20) }} strokeWidth={2} />}
      styles={(theme) => ({
        mark: {
          display: "flex",
        },
        thumb: {
          width: rem(20),
          height: rem(20),
          backgroundColor: theme.white,
          color: theme.colors.gray[5],
          border: `1px solid ${theme.colors.gray[2]}`,
        },
      })}
    />
  );
}
