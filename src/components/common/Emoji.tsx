import classes from "./Emoji.module.css";

/** Decorative system colour-emoji glyph; the surrounding label carries the accessible name. `size` is a rem length. */
export function Emoji({ glyph, size }: { glyph: string; size?: `${number}rem` }) {
  return (
    <span
      aria-hidden="true"
      className={classes.emoji}
      style={size === undefined ? undefined : { fontSize: size }}
    >
      {glyph}
    </span>
  );
}

/** Inline decorative emoji paired with a visible text label whose accessible name stays plain text. */
export function EmojiLabel({ glyph, label }: { glyph: string; label: string }) {
  return (
    <span className={classes.label}>
      <Emoji glyph={glyph} />
      <span className={classes.labelText}>{label}</span>
    </span>
  );
}
