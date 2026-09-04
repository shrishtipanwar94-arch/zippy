// THE DRIVER'S MAP — two dots, and an honest sentence about the second one.
//
// SAME DISCIPLINE AS THE DISPATCHER'S MAP, for the same reason and then some.
// The map, the tile layer and both markers are created ONCE and mutated after
// that; nothing here rebuilds a layer group. On the console that rule protects
// an operator's pan and zoom. Here it protects something more basic: this is a
// dot moving towards a person who is waiting for it, and a marker that is
// destroyed and recreated on every socket event does not move — it blinks, and
// a blinking dot does not read as somebody approaching.
//
// IT IS THE SECOND THING ON THE SCREEN, DELIBERATELY. The answer to the
// driver's question is the name and the duration above this. A map is
// reassurance that the answer is true, and reassurance that takes the top of
// the screen has been promoted past its usefulness — you cannot ring a map.
//
// A MAP THAT LIES IS WORSE THAN NO MAP, which is the whole reason the staleness
// note is rendered by this file rather than left to a caption somewhere else.
// The feed is as coarse as the technician's status taps (src/commit/
// unitPosition.ts), so a fix can be minutes old, and the sentence beside the
// map has to say so in the driver's words rather than leaving a confident dot
// to imply otherwise.

const DEFAULT_ZOOM = 14;

let map = null;
let layer = null;
let youMarker = null;
let helperMarker = null;
// The positions the current framing was chosen for, so the view is fitted when
// the picture genuinely changes and left alone when it does not.
let fittedKey = '';

export function render(state) {
  const section = document.querySelector('[data-panel="driver-map"]');
  if (!section) return;

  const tracking = state.driverView?.tracking ?? null;

  // NO GUESSING. No coordinates for the breakdown, or no crew yet, and there is
  // simply no map. An empty space is honest; a dot in the middle of the city is
  // not.
  section.hidden = !tracking;
  if (!tracking) return;

  const L = typeof window !== 'undefined' ? window.L : undefined;
  const container = section.querySelector('[data-field="driver-map"]');
  if (!L || !container) {
    section.hidden = true;
    return;
  }

  if (!map) {
    map = L.map(container, {
      zoomControl: false,
      attributionControl: false,
      // A driver is not navigating with this. Dragging a map with one hand
      // while standing on a verge is not a thing to support, and a map that
      // swallows a scroll gesture on a phone is actively annoying.
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      keyboard: false,
    }).setView([tracking.you.lat, tracking.you.lng], DEFAULT_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    // ONE layer group for the life of the page.
    layer = L.layerGroup().addTo(map);

    // Leaflet caches its container size at construction, and this container is
    // inside a panel that is hidden until there is a job — so at construction
    // it may have had no size at all.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => map.invalidateSize({ animate: false, pan: false })).observe(container);
    }
  }

  youMarker = place(L, youMarker, tracking.you, 'driver-dot');
  if (tracking.helper) {
    helperMarker = place(L, helperMarker, tracking.helper, 'helper-dot', tracking.stale);
  } else if (helperMarker) {
    layer.removeLayer(helperMarker);
    helperMarker = null;
  }

  frame(tracking);
  renderNote(section, tracking);
}

// Moves a marker, or creates it the first time. `setLatLng` mutates the marker
// that is already on the map, which is what makes the dot travel rather than
// flicker.
function place(L, marker, at, className, stale = false) {
  const position = [at.lat, at.lng];
  if (marker) {
    const current = marker.getLatLng();
    if (current.lat !== at.lat || current.lng !== at.lng) marker.setLatLng(position);
    marker.setOpacity(stale ? 0.55 : 1);
    return marker;
  }

  const created = L.marker(position, {
    icon: L.divIcon({ className: `map-dot ${className}`, iconSize: [18, 18] }),
    keyboard: false,
    interactive: false,
  });
  created.setOpacity(stale ? 0.55 : 1);
  created.addTo(layer);
  return created;
}

// Fits both dots, and only when the pair has actually moved enough to matter.
// Refitting on every tick would jitter the view under a driver who is watching
// it; never refitting would let the technician drive off the edge.
function frame(tracking) {
  const key = tracking.helper
    ? `${round(tracking.you)}|${round(tracking.helper)}`
    : round(tracking.you);
  if (key === fittedKey) return;
  fittedKey = key;

  if (!tracking.helper) {
    map.setView([tracking.you.lat, tracking.you.lng], DEFAULT_ZOOM, { animate: false });
    return;
  }
  map.fitBounds(
    [
      [tracking.you.lat, tracking.you.lng],
      [tracking.helper.lat, tracking.helper.lng],
    ],
    { padding: [34, 34], maxZoom: 15, animate: false },
  );
}

// Three decimal places is about 100 metres — below that a refit is noise.
function round(point) {
  return `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
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
