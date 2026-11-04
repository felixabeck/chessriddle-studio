import { Stack } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./NotationColumn.module.css";

export default function NotationColumn({ children }: { children: ReactNode }) {
  return (
    <Stack h="100%" gap="xs" className={classes.column}>
      {children}
    </Stack>
  );
}
