import { Group } from "@mantine/core";
import type { AccountSite } from "@/utils/session";
import LichessLogo from "./LichessLogo";

/** The logo of the site an account lives on. */
export function SiteLogo({ site, size = 30 }: { site: AccountSite; size?: number }) {
  return site === "lichess" ? (
    <LichessLogo size={size} />
  ) : (
    <img width={size} height={size} src="/chesscom.png" alt="Chess.com" style={{ flexShrink: 0 }} />
  );
}

/**
 * Small side-by-side site logos, for a player whose accounts live on several sites.
 * `decorative` hides them from assistive technology where adjacent text already names the site.
 */
export function SiteLogos({
  sites,
  size = 18,
  decorative = false,
}: {
  sites: AccountSite[];
  size?: number;
  decorative?: boolean;
}) {
  if (sites.length === 0) return null;
  return (
    <Group
      gap={4}
      wrap="nowrap"
      data-site-logos={sites.join(" ")}
      aria-hidden={decorative || undefined}
    >
      {sites.map((site) => (
        <SiteLogo key={site} site={site} size={size} />
      ))}
    </Group>
  );
}

/** Mantine `leftSectionWidth` that fits `count` small logos plus the input's inner padding. */
export function siteLogosWidth(count: number, size = 18): number {
  return count === 0 ? 0 : count * size + (count - 1) * 4 + 16;
}
