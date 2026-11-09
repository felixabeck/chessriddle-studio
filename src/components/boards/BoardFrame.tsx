import { Box, type BoxProps } from "@mantine/core";
import type { ReactNode } from "react";
import VariationChooserCard from "@/components/boards/VariationChooserCard";
import classes from "@/components/boards/BoardFrame.module.css";

export default function BoardFrame({
  children,
  withVariationChooser = true,
  ...props
}: BoxProps & { children: ReactNode; withVariationChooser?: boolean }) {
  return (
    <Box {...props} className={classes.frame}>
      {children}
      {withVariationChooser && <VariationChooserCard />}
    </Box>
  );
}
