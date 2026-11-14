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
    let cancelled = false;
    void getOpening(root, position).then(
      (name) => {
        if (!cancelled) setOpeningName(name);
      },
      (error: unknown) => {
        if (cancelled) return;
        setOpeningName("");
        const message = normalizeError(error).message;
        if (message !== NO_OPENING_FOUND) warnSafely(message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, position]);

  return (
    <Text style={{ userSelect: "text" }} fz="sm">
      {openingName}
    </Text>
  );
}

export default OpeningName;
