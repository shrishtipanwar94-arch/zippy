# UI

Three surfaces, three different jobs. This is the design brief that later
phases follow. Nothing is built yet — the first pages arrive at Phase 4,
deliberately ugly, and are dressed up from Phase 14 onward.

## Visual direction

The genre is Indian roadside-assistance services: clean, high-contrast,
card-based, one obvious action per screen. No stock photography. No hero
imagery of people. Take the GENRE, not any brand — Zippy uses its own name,
palette and copy, and never reproduces another company's logo, colours or
wording.

## Palette

Hazard amber accent against a neutral slate base. Defined once as CSS custom
properties in `/public/css/tokens.css` and referenced everywhere — no
hardcoded hex in panel code.

- `--accent` — amber; primary actions and live status
- `--danger` — red; reserved for HIGH_RISK and failures
- `--ok` — green; only confirmed / resolved
- `--surface`, `--surface-alt`, `--text`, `--text-muted`, `--border`

Never use colour as the only signal. Pair it with a label or an icon.

## Driver — mobile-first, calm, one action per screen

The person is stressed, possibly at night, on a roadside. Large type,
generous tap targets, short sentences. No jargon. No enums, ever — status is
a sentence, not a badge. The live ETA and the technician's identity reduce
anxiety most, so they are the largest elements on the screen.

## Technician — field use

Big tap targets. Very high contrast for daylight. Glanceable. Accept/decline
with a visible countdown. One obvious primary button at a time. Assume
one-handed use and a cracked screen.

## Dispatcher — desktop control room, dense

Information density is the goal, not whitespace. Small type, tabular, dark
surface, many live regions. This is the surface an interviewer looks at; it
should read as an operations console, not a consumer app.

## Mechanics

- Bootstrap 5 via CDN.
- One state object. One `render(state)` per panel. Nothing else touches the
  DOM.
- Patch table rows by `data-job-id`. Never rebuild a table on every event, or
  scroll position and selection are lost during the demo — which looks broken
  when jobs arrive every few seconds.
- Use morphdom where targeted patching would otherwise be fiddly.
