import { Group } from "@mantine/core";
import type { AccountSite } from "@/utils/session";
import LichessLogo from "./LichessLogo";

/** Size and spacing of the small logos inside a dropdown; `siteLogosWidth` derives from them. */
const SMALL_LOGO_SIZE = 18;
const SMALL_LOGO_GAP = 4;
/** Mantine's horizontal padding around an input section. */
const SECTION_PADDING = 16;

/** The logo of the site an account lives on. */
export function SiteLogo({ site, size = 30 }: { site: AccountSite; size?: number }) {
  return site === "lichess" ? (
    <LichessLogo size={size} />
  ) : (
    <img width={size} height={size} src="/chesscom.png" alt="Chess.com" style={{ flexShrink: 0 }} />
  );
}

/**
 * Small side-by-side logos of one or more sites, as shown inside a dropdown.
 * `decorative` hides them from assistive technology where adjacent text already names the site.
 */
export function SiteLogos({
  sites,
  decorative = false,
}: {
  sites: AccountSite[];
  decorative?: boolean;
}) {
  if (sites.length === 0) return null;
  return (
    <Group
      gap={SMALL_LOGO_GAP}
      wrap="nowrap"
      data-site-logos={sites.join(" ")}
      aria-hidden={decorative || undefined}
    >
      {sites.map((site) => (
        <SiteLogo key={site} site={site} size={SMALL_LOGO_SIZE} />
      ))}
    </Group>
  );
}

/** Mantine `leftSectionWidth` that fits `count` small logos plus the section's padding. */
export function siteLogosWidth(count: number): number {
  return count === 0 ? 0 : count * SMALL_LOGO_SIZE + (count - 1) * SMALL_LOGO_GAP + SECTION_PADDING;
}
