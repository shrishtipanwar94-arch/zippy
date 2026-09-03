// THE LIVE MAP — Leaflet + OpenStreetMap tiles, no API key.
//
// THE ONE RULE THIS FILE EXISTS TO OBEY: markers update IN PLACE. The map, the
// tile layer and every marker are created ONCE and then mutated. Nothing here
// ever calls `map.remove()`, rebuilds a layer group, or clears and re-adds
// markers on an event.
//
// Why it matters more here than anywhere else on the page: a job event arrives
// every few seconds, and `render()` runs on each one. Recreating the map would
// reset the operator's pan and zoom mid-drag; recreating the marker layer would
// make every pin blink, close any open popup, and — on a board with a hundred
// jobs — drop several frames each time. Both look exactly like a broken
// application, and both are the default if you write the obvious code.
//
// So this panel keeps its own registry of live markers keyed by job id, and
// each render does three things: move the ones that moved, add the ones that
// are new, remove the ones that are gone. That is the same discipline the jobs
// table and the timeline follow, applied to a different kind of node.
//
// LEAFLET IS LOADED FROM A CDN as a global, matching how Bootstrap and morphdom
// are loaded (docs/UI.md: no build step). If it has not loaded — offline, CDN
// blocked — this panel does nothing at all rather than throwing, because a
// missing map must not take the rest of the console down with it.

const BENGALURU = [12.9716, 77.5946];
const DEFAULT_ZOOM = 11;

const SAFETY_COLOUR = {
  HIGH_RISK: 'var(--danger)',
  ELEVATED: 'var(--accent)',
  NORMAL: 'var(--text-muted)',
};

// Created once, on the first render that has a container and a Leaflet.
let map = null;
let markerLayer = null;
// jobId -> Leaflet marker. The registry that makes in-place updates possible:
// without it the only way to find a marker again is to rebuild the layer.
const markers = new Map();

export function render(state) {
  const container = document.querySelector('[data-panel="map"]');
  if (!container) return;

  // eslint-disable-next-line no-undef
  const L = typeof window !== 'undefined' ? window.L : undefined;
  if (!L) {
    container.textContent = 'Map unavailable — Leaflet did not load.';
    return;
  }

  if (!map) {
    map = L.map(container, { zoomControl: true, attributionControl: true }).setView(
      BENGALURU,
      DEFAULT_ZOOM,
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    // ONE layer group for the life of the page. Markers are added to and
    // removed from it individually; it is never replaced.
    markerLayer = L.layerGroup().addTo(map);

    // LEAFLET CACHES ITS CONTAINER'S SIZE at construction and has no way to
    // learn that the page moved underneath it. Phase 22c put this panel in a
    // CSS grid column, which lays out after the map is built — so the tiles
    // rendered into a stale, much smaller box and the rest of the card stayed
    // grey. `invalidateSize` is the documented fix; a ResizeObserver is what
    // makes it fire without a render loop calling it on every socket event.
    // `pan: false` matters as much as the call itself: the default pans the view
    // to preserve the centre point, so an observer that fires on every layout
    // change would walk the operator's map around underneath them once the
    // console starts resizing panels. This is a correction to Leaflet's idea of
    // the box, and after the first one it must move nothing.
    //
    // THE FIRST FIRE IS DIFFERENT, and re-frames. The map was constructed
    // against a box the grid had not laid out yet, so its centre is anchored to
    // the wrong origin — `invalidateSize` alone widens the viewport from that
    // wrong anchor and leaves the city off the edge. Re-applying the framing
    // once is the only way to recover it; doing it every time would yank a
    // panning operator back. `frameTheJobs` falls back to the city when there
    // is nothing to fit, which is what the opening view used to hardcode.
    if (typeof ResizeObserver === 'function') {
      let sized = false;
      new ResizeObserver(() => {
        map.invalidateSize({ animate: false, pan: false });
        if (sized) return;
        sized = true;
        frameTheJobs();
      }).observe(container);
    }
  }

  const jobs = mappableJobs(state);
  const wanted = new Set(jobs.map((job) => job.id));

  // 1. REMOVE what is gone. Done first so a marker for a resolved job does not
  // linger while its replacement is added nearby.
  for (const [jobId, marker] of markers) {
    if (!wanted.has(jobId)) {
      markerLayer.removeLayer(marker);
      markers.delete(jobId);
    }
  }

  for (const job of jobs) {
    const existing = markers.get(job.id);

    // 2. MOVE and restyle what is already there. `setLatLng` and `setStyle`
    // mutate the existing marker — the DOM node stays, so there is no flicker
    // and an open popup survives.
    if (existing) {
      const [lat, lng] = [job.lat, job.lng];
      const current = existing.getLatLng();
      if (current.lat !== lat || current.lng !== lng) existing.setLatLng([lat, lng]);
      existing.setStyle(styleFor(job));
      existing.setPopupContent(popupFor(job));
      continue;
    }

    // 3. ADD what is new.
    const marker = L.circleMarker([job.lat, job.lng], {
      radius: 6,
      ...styleFor(job),
    });
    marker.bindPopup(popupFor(job));
    // Selecting from the map is the same action as selecting from the timeline
    // or the queue, so it goes through the same delegated handler rather than
    // a third copy of the fetch.
    marker.on('click', () => {
      const button = document.querySelector(`[data-action="inspect"][data-job-id="${job.id}"]`);
      if (button) button.click();
    });
    marker.addTo(markerLayer);
    markers.set(job.id, marker);
  }

  // 4. FRAME what is there. Moving the VIEW is not rebuilding the layer: every
  // marker created above is still the same object at the same coordinates, and
  // nothing below touches `markers` or `markerLayer`.
  if (shouldRefit(wanted)) {
    fittedIds = wanted;
    frameTheJobs();
  }

  const summary = document.querySelector('[data-field="map-summary"]');
  if (summary) summary.textContent = `${jobs.length} job(s) with a position`;
}

// WHY THE MAP HAS TO FIT ITSELF, and why it must not do it often.
//
// The opening view was a hardcoded centre on Bengaluru at zoom 11, chosen
// before anything was ever plotted on it. That looked correct on a small
// reseeded board by luck — the jobs happened to be near the centroid — and was
// plainly broken on a real one, where every marker crushed into the top-left
// corner while the viewport sat on empty countryside. A map that does not
// contain its own markers is not a map.
//
// The opposite failure is worse though: refitting on every render would fight
// the operator. This panel re-renders on every socket event, and a dispatcher
// who has zoomed into one junction to compare two vans would be thrown back
// out to the whole city several times a minute. So the fit is deliberately
// rare — the first time there is anything to fit, and afterwards only when the
// set has changed enough that the old framing is answering a stale question.
//
// SUBSTANTIALLY is defined rather than felt: a third of the jobs on screen
// being different. One arrival among forty does not move the view; a zone
// filling up, or the board draining after a solve, does.
const REFIT_CHURN_FRACTION = 1 / 3;

// The ids the current framing was chosen for. Null until the first fit.
let fittedIds = null;

function shouldRefit(wanted) {
  if (wanted.size === 0) return false;
  if (fittedIds === null) return true;

  let changed = 0;
  for (const id of wanted) if (!fittedIds.has(id)) changed += 1;
  for (const id of fittedIds) if (!wanted.has(id)) changed += 1;

  // Against the larger of the two sets, so a board draining from ninety jobs to
  // three counts as the upheaval it is rather than as three arrivals.
  const scale = Math.max(wanted.size, fittedIds.size);
  return changed / scale >= REFIT_CHURN_FRACTION;
}

// Fits the view to the live markers, reading their positions off the markers
// themselves rather than off a job array — the markers are the thing on screen,
// and anything that moves one has already moved what this should frame.
function frameTheJobs() {
  if (!map) return;

  const positions = [...markers.values()].map((marker) => marker.getLatLng());
  if (positions.length === 0) {
    map.setView(BENGALURU, DEFAULT_ZOOM, { animate: false });
    return;
  }

  // `maxZoom` stops a single job — or several within one car park — from
  // filling the panel with one building at street level, which reads as a
  // broken map rather than a precise one.
  map.fitBounds(positions, { padding: [24, 24], maxZoom: 14, animate: false });
}

// Only jobs that have coordinates. A job whose location has not been captured
// yet is not placeable, and inventing a position for it — a zone centroid, say
// — would put a pin somewhere nobody is.
function mappableJobs(state) {
  return state.queue.jobs
    .map((queued) => ({ ...queued, ...(state.jobs[queued.id] ?? {}) }))
    .filter((job) => typeof job.lat === 'number' && typeof job.lng === 'number');
}

// Colour is never the only signal (docs/UI.md), so the popup names the safety
// level in words and the radius carries it too.
function styleFor(job) {
  return {
    color: SAFETY_COLOUR[job.safetyLevel] ?? SAFETY_COLOUR.NORMAL,
    fillColor: SAFETY_COLOUR[job.safetyLevel] ?? SAFETY_COLOUR.NORMAL,
    fillOpacity: job.safetyLevel === 'HIGH_RISK' ? 0.9 : 0.5,
    weight: job.safetyLevel === 'HIGH_RISK' ? 3 : 1,
  };
}

function popupFor(job) {
  return (
    `<div class="mono">${escapeHtml(job.id.slice(-8))}</div>` +
    `<div>${escapeHtml(job.safetyLevel ?? 'NORMAL')} · ${escapeHtml(job.status ?? '')}</div>` +
    `<div class="text-muted">${escapeHtml(job.zoneId ?? '')}</div>`
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
