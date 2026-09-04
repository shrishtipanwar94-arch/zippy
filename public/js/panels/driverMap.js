// THE DRIVER'S MAP — two dots, and an honest sentence about the second one.
//
// The drawing is `js/trackingMap.js`, shared with the technician's job card:
// it is the same question from both sides of the windscreen, so it is one
// implementation. What stays here is everything specific to the DRIVER's
// version of it — which is almost entirely about honesty rather than geometry.
//
// IT IS THE SECOND THING ON THE SCREEN, DELIBERATELY. The answer to the
// driver's question is the name and the duration above this. A map is
// reassurance that the answer is true, and reassurance that takes the top of
// the screen has been promoted past its usefulness — you cannot ring a map.
//
// A MAP THAT LIES IS WORSE THAN NO MAP, which is why the staleness note is
// rendered by this file rather than left to a caption somewhere else. The feed
// is as coarse as the technician's status taps (src/commit/unitPosition.ts), so
// a fix can be minutes old, and the sentence beside the map has to say so
// rather than leaving a confident dot to imply otherwise.

import { createTrackingMap } from '../trackingMap.js';

let draw = null;

export function render(state) {
  const section = document.querySelector('[data-panel="driver-map"]');
  if (!section) return;

  const tracking = state.driverView?.tracking ?? null;

  // NO GUESSING. No coordinates for the breakdown, or no crew yet, and there is
  // simply no map. An empty space is honest; a dot in the middle of the city is
  // not.
  section.hidden = !tracking;
  if (!tracking) return;

  const container = section.querySelector('[data-field="driver-map"]');
  if (!draw && container) draw = createTrackingMap(container);
  if (!draw) {
    section.hidden = true;
    return;
  }

  const drawn = draw({
    a: tracking.you,
    b: tracking.helper,
    // A stale fix is drawn faded as well as described. Removing the dot would
    // answer "where are they" with silence, which is worse.
    fade: Boolean(tracking.stale),
  });
  section.hidden = !drawn;

  renderNote(section, tracking);
}

// THE SENTENCE IS THE HONEST PART. Written entirely by the server
// (src/commit/unitPosition.ts) so the wording a driver reads about a stale fix
// and the wording the health ladder uses about a stale fleet cannot drift.
function renderNote(section, tracking) {
  const note = section.querySelector('[data-field="track-note"]');
  if (!note) return;

  note.hidden = !tracking.note;
  if (!tracking.note) return;

  if (note.textContent !== tracking.note) note.textContent = tracking.note;
  note.classList.toggle('is-stale', Boolean(tracking.stale));
}
