// STORED CONSTANTS, IN WORDS.
//
// Manufacturers are stored in SCREAMING_SNAKE — `MARUTI_SUZUKI` is a database
// value, "Maruti Suzuki" is a car — and docs/UI.md's rule is that no enum ever
// reaches a driver. Phase 22b's audit found the same string reaching the
// TECHNICIAN too, through `/technician/work`, so the translation moved out of
// one route and into here where both can share it.
//
// PURE, AND ON THE SERVER. A second copy of this in the browser would be a
// second place for an underscore to leak out, which is exactly what the rule is
// about.

export function inWords(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return stored
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
