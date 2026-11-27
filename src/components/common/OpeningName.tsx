import { Text } from "@mantine/core";
import { useContext } from "react";
import { useStore } from "zustand";
import {
  OPENING_NAME_CACHE_CAPACITY,
  openingNameCache,
  useOpeningName,
} from "@/hooks/useOpeningName";
import { TreeStateContext } from "./TreeStateContext";

export { OPENING_NAME_CACHE_CAPACITY, openingNameCache };

function OpeningName() {
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const openingName = useOpeningName(root, position);

  return (
    <Text style={{ userSelect: "text" }} fz="sm">
      {openingName}
    </Text>
  );
}

export default OpeningName;
