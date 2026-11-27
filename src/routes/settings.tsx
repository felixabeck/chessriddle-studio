import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  SETTING_CATEGORIES,
  type SettingCategory,
} from "@/components/settings/settingsDescription";
import { getVersion } from "@/platform/native";

export const settingsSearchSchema = z
  .object({
    category: z.enum(SETTING_CATEGORIES).optional().catch(undefined),
    q: z
      .preprocess((value) => {
        if (typeof value === "string") return value === "" ? undefined : value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return undefined;
      }, z.string().optional())
      .catch(undefined),
  })
  .catch({});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

export function settingsRouteSearch(category: SettingCategory, q: string): SettingsSearch {
  return {
    category: category === "board" ? undefined : category,
    q: q === "" ? undefined : q,
  };
}

export const Route = createFileRoute("/settings")({
  validateSearch: settingsSearchSchema,
  loader: async () => ({ version: await getVersion() }),
});
