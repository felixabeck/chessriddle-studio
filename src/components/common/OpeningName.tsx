import { Text } from "@mantine/core";
import { useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { normalizeError, warnSafely } from "@/platform/errors";
import { getOpening } from "@/utils/chess";
import { TreeStateContext } from "./TreeStateContext";

// Display of `Error::NoOpeningFound` in src-tauri/src/error.rs.
const NO_OPENING_FOUND = "No opening found";

function OpeningName() {
  const [openingName, setOpeningName] = useState("");
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);

  useEffect(() => {
    let current = true;
    void getOpening(root, position).then(
      (name) => {
        if (current) setOpeningName(name);
      },
      (error: unknown) => {
        if (!current) return;
        setOpeningName("");
        const message = normalizeError(error).message;
        if (message !== NO_OPENING_FOUND) warnSafely(message);
      },
    );
    return () => {
      current = false;
    };
  }, [root, position]);

  return (
    <Text style={{ userSelect: "text" }} fz="sm">
      {openingName}
    </Text>
  );
}

export default OpeningName;
