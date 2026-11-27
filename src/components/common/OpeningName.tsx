import { Text } from "@mantine/core";
import { useContext } from "react";
import { useStore } from "zustand";
import {
  OPENING_NAME_CACHE_CAPACITY,
  openingNameCache,
  useOpeningName,
} from "@/hooks/useOpeningName";
import classes from "./OpeningName.module.css";
import { TreeStateContext } from "./TreeStateContext";

export { OPENING_NAME_CACHE_CAPACITY, openingNameCache };

/**
 * `reserveLine` keeps exactly one line, empty or truncated, so the content below never moves when
 * the name changes length or there is none.
 */
function OpeningName({ reserveLine = false }: { reserveLine?: boolean }) {
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const openingName = useOpeningName(root, position);

  return (
    <Text
      style={{ userSelect: "text" }}
      fz="sm"
      truncate={reserveLine ? "end" : undefined}
      className={reserveLine ? classes.reservedLine : undefined}
      title={reserveLine && openingName ? openingName : undefined}
    >
      {openingName}
    </Text>
  );
}

export default OpeningName;
