// TWO DOTS ON A SMALL MAP, drawn once and moved after that.
//
// Extracted from panels/driverMap.js when the technician's job card needed the
// same picture from the other side. It is the same question both ways round —
// how far apart are we — so it is one implementation rather than two that
// drift, which is the rule the `.person` component already follows.
//
// THE PATCH-IN-PLACE RULE IS THE WHOLE POINT. The map, the tile layer and both
// markers are created ONCE and mutated after that; nothing here rebuilds a
// layer group. A marker that is destroyed and recreated on every socket event
// does not travel, it blinks — and a blinking dot does not read as somebody
// approaching.
//
// Each caller keeps its own instance, because two maps on two pages are two
// maps. `createTrackingMap` hands back a `draw` function that closes over one.

const DEFAULT_ZOOM = 14;

export function createTrackingMap(container, options = {}) {
  let map = null;
  let layer = null;
  let markers = { a: null, b: null };
  // The dashed line between the two dots and the "1.9 km apart" badge. Created
  // once, moved after that, like the markers.
  let link = null;
  let badge = null;
  // The positions the current framing was chosen for, so the view is refitted
  // when the picture genuinely changes and left alone when it does not.
  let fittedKey = '';

  // `a` is the viewer, `b` is the other party. Either may be null: a job with
  // no crew yet has one dot, and that is honest.
  // `aClass` / `bClass` are the two marker shapes. They differ on purpose: two
  // identical circles need a legend, and a map with a legend on a phone is a map
  // nobody reads.
  // `aLabel` / `bLabel` name the two dots ("You", "Ravi") — a bare circle and a
  // bare pin left people guessing which was which, and which way to read the
  // map. The distance between them is the one number the map exists to show.
  return function draw({
    a,
    b,
    aClass = 'driver-dot',
    bClass = 'helper-dot',
    fade = false,
    aLabel = null,
    bLabel = null,
  }) {
    const L = typeof window !== 'undefined' ? window.L : undefined;
    if (!L || !container) return false;
    if (!a && !b) return false;

    if (!map) {
      const anchor = a ?? b;
      map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
        // Nobody navigates with this. Dragging a map with one hand at the
        // roadside is not a thing to support, and a map that swallows a scroll
        // gesture on a phone is actively annoying.
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        keyboard: false,
        ...options.mapOptions,
      }).setView([anchor.lat, anchor.lng], DEFAULT_ZOOM);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      layer = L.layerGroup().addTo(map);

      // Leaflet caches its container size at construction, and these containers
      // live inside panels that are hidden until there is a job — so at
      // construction they may have had no size at all.
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => map.invalidateSize({ animate: false, pan: false })).observe(
          container,
        );
      }
    }

    markers.a = place(L, layer, markers.a, a, aClass, false);
    markers.b = place(L, layer, markers.b, b, bClass, fade);
    label(markers.a, aLabel);
    label(markers.b, bLabel);
    joinTheDots(L, a, b);
    frame(map, a, b);
    return true;
  };

  // A name that stays on screen beside its dot. Re-bound only when the words
  // change, so a tick that moves the dot does not rebuild the label.
  function label(marker, text) {
    if (!marker) return;
    const current = marker.getTooltip();
    if (!text) {
      if (current) marker.unbindTooltip();
      return;
    }
    if (current && current.getContent() === text) return;
    marker.unbindTooltip();
    marker.bindTooltip(text, { permanent: true, direction: 'top', offset: [0, -12], className: 'map-label' });
  }

  // The line and the badge only make sense with two dots; with one they go.
  function joinTheDots(L, a, b) {
    if (!a || !b) {
      if (link) layer.removeLayer(link);
      link = null;
      if (badge) badge.hidden = true;
      return;
    }
    const points = [
      [a.lat, a.lng],
      [b.lat, b.lng],
    ];
    if (link) link.setLatLngs(points);
    else link = L.polyline(points, { className: 'map-link', weight: 2, dashArray: '6 6', interactive: false }).addTo(layer);

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'map-distance';
      container.appendChild(badge);
    }
    badge.hidden = false;
    const text = `${distanceText(a, b)} apart`;
    if (badge.textContent !== text) badge.textContent = text;
  }

  // Moves a marker, creates it the first time, removes it when its point is
  // gone. `setLatLng` mutates the marker already on the map, which is what
  // makes the dot travel rather than flicker.
  function place(L, group, marker, at, className, fade) {
    if (!at) {
      if (marker) group.removeLayer(marker);
      return null;
    }
    if (marker) {
      const current = marker.getLatLng();
      if (current.lat !== at.lat || current.lng !== at.lng) marker.setLatLng([at.lat, at.lng]);
      marker.setOpacity(fade ? 0.55 : 1);
      return marker;
    }
    // A pin is taller than it is wide and is anchored at its point, not its
    // centre — a pin centred on its coordinate points at the wrong place.
    const pin = className.includes('job-pin');
    // THE SHAPE GOES IN AN INNER ELEMENT, not on the icon itself. Leaflet
    // positions a divIcon with a `transform: translate3d(...)`, so a
    // `transform: rotate()` used to draw the pin's point lands on the same
    // element and overwrites it — the marker renders as a rounded blob in
    // roughly the right place. The wrapper is Leaflet's; the shape is ours.
    const created = L.marker([at.lat, at.lng], {
      icon: L.divIcon({
        className: `map-dot ${className}`,
        html: pin ? '<span class="job-pin-shape"></span>' : '',
        iconSize: pin ? [22, 28] : [18, 18],
        iconAnchor: pin ? [11, 28] : [9, 9],
      }),
      keyboard: false,
      interactive: false,
    });
    created.setOpacity(fade ? 0.55 : 1);
    created.addTo(group);
    return created;
  }

  // Fits both dots, and only when the pair has actually moved enough to matter.
  // Refitting every tick would jitter the view under somebody watching it;
  // never refitting would let the other party drive off the edge.
  function frame(instance, a, b) {
    const key = [a, b].map((point) => (point ? round(point) : '-')).join('|');
    if (key === fittedKey) return;
    fittedKey = key;

    if (!a || !b) {
      const only = a ?? b;
      instance.setView([only.lat, only.lng], DEFAULT_ZOOM, { animate: false });
      return;
    }
    instance.fitBounds(
      [
        [a.lat, a.lng],
        [b.lat, b.lng],
      ],
      { padding: [34, 34], maxZoom: 15, animate: false },
    );
  }
}

// STRAIGHT-LINE DISTANCE, said the way a person says it. The arrival time is
// the server's (it knows the routing mode); this is just how far apart the two
// dots on this map are, which is what the eye is trying to judge anyway.
function distanceText(a, b) {
  const metres = haversineMetres(a, b);
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function haversineMetres(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// Three decimal places is about 100 metres — below that a refit is noise.
function round(point) {
  return `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
}
