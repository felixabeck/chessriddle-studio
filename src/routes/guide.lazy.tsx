import { createLazyFileRoute } from "@tanstack/react-router";
import GuidePage from "@/components/assistant/guide/GuidePage";

export const Route = createLazyFileRoute("/guide")({
  component: GuidePage,
});
