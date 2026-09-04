// HOW FAR AM I FROM THE CAR — the mirror of what the driver now sees.
//
// A SIBLING PANEL RATHER THAN PART OF THE JOB CARD, and that is not tidiness.
// The job card is rebuilt from a template string through morphdom on every
// tick; Leaflet owns real DOM inside its container and would have it diffed
// away several times a minute. technicianLadder.js renders the empty container
// and tells morphdom to leave its subtree alone; this file fills it, after.
//
// The drawing is js/trackingMap.js, shared with the driver's map. Same
// question, both sides of the windscreen, one implementation.
//
// NO STALENESS NOTE HERE, deliberately. The driver's map needs one because the
// dot it cares about is somebody ELSE, reported minutes ago. This map's moving
// dot is the technician's own last tap — they know perfectly well where they
// are, and captioning it "last seen 4 minutes ago" would be telling somebody
// their own whereabouts are uncertain.

import { createTrackingMap } from '../trackingMap.js';

let draw = null;
let boundTo = null;

export function render(state) {
  const container = document.querySelector('[data-field="technician-map"]');
  if (!container) {
    // The card is gone, so the next one gets a fresh instance rather than a map
    // bound to a detached node.
    draw = null;
    boundTo = null;
    return;
  }

  const job =
    state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId) ?? state.work.jobs[0];
  const tracking = job?.tracking;
  if (!tracking) return;

  if (draw === null || boundTo !== container) {
    draw = createTrackingMap(container);
    boundTo = container;
  }

  // `a` is the viewer — the technician — so the two surfaces colour themselves
  // consistently: your own dot is the quiet one, the other party's is the brand
  // colour. On this screen the car is what you are heading towards.
  draw({ a: tracking.you, b: tracking.job, aClass: 'driver-dot', bClass: 'helper-dot' });
}
