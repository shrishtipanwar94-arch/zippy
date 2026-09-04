// THE ICON SET. Concrete objects, drawn once, used everywhere.
//
// Inline SVG rather than emoji, and the difference is not taste. An emoji is a
// font glyph: it renders as Apple's drawing on one phone, Google's on another
// and a hollow box on a cheap Android with a partial font — and this product is
// read on cheap Android phones at the side of a road. These are paths. They
// look the same everywhere and they take `currentColor`, so a status icon is
// the colour of the status without a second definition.
//
// CONCRETE OBJECTS ONLY on the driver and technician surfaces. A tow truck, a
// spanner, a phone, a rupee note, a pin. Somebody who reads English slowly
// recognises a picture of a thing much faster than they decode an abstract
// glyph, and much faster than they read the label beside it.
//
// 24px and 1.75 stroke come from tokens.css. Nothing here sets a size: the
// class does, so a panel cannot quietly introduce a nineteenth icon size.

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  // A handset. The call affordance, both directions.
  phone: '<path d="M6.5 3h3l1.5 4-2 1.4a12 12 0 0 0 5.6 5.6l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3z" />',
  // A speech bubble. Chat, which is the fallback channel and looks like one.
  message: '<path d="M20 12.5A7.5 7.5 0 0 1 12.5 20H4l2-3.2A7.5 7.5 0 1 1 20 12.5z" />',
  // A tow truck.
  tow: '<path d="M2 15.5h11V9H8L5.5 12H2z" /><path d="M13 15.5h3.5M13 9h3l3 3.5v3h-2" /><circle cx="6" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /><path d="M15 6.5 20 4" />',
  // A service van.
  van: '<path d="M2 15.5V7.5h10.5l3.5 4h4a2 2 0 0 1 2 2v2h-2.5" /><path d="M13 15.5H8.5" /><circle cx="6.5" cy="17.5" r="2" /><circle cx="17.5" cy="17.5" r="2" />',
  // A spanner.
  spanner: '<path d="M15.6 3.5a5.2 5.2 0 0 0-6.1 6.7L3.6 16a2 2 0 0 0 2.8 2.8l5.8-5.8a5.2 5.2 0 0 0 6.7-6.1l-3 3-2.6-.7-.7-2.6z" />',
  // A car battery.
  battery: '<path d="M3 9h18v9H3z" /><path d="M7 9V6.5h3V9M14 9V6.5h3V9M7 13.5h3M15.5 12v3M14 13.5h3" />',
  // A rupee note.
  rupee: '<path d="M2.5 6h19v12h-19z" /><path d="M9 9.5h6M9 12h6M13.5 9.5c1.6 0 2.4 1 2.4 2.2 0 1.3-1 2.3-2.6 2.3H9l4 3.2" />',
  // A navigation arrow. The hand-off to the device's maps app.
  navigate: '<path d="M21 3 3 10.5l8 2.6 2.6 8z" />',
  // A map pin.
  pin: '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" />',
  // A camera.
  camera: '<path d="M3 8h3.5L8 5.8h8L17.5 8H21v11H3z" /><circle cx="12" cy="13" r="3.5" />',
  // A clock.
  clock: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />',
  // A tick in a circle. Confirmation only, never decoration.
  check: '<circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.5 2.5 4.5-5" />',
  // A warning triangle.
  warning: '<path d="M12 4.5 21 19H3z" /><path d="M12 10v4M12 16.5v.5" />',
  // An inbox, for an empty list.
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8v5h-17z" /><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5" />',
};

// One element, built the same way every time. Returns a STRING because the two
// field panels build their markup as template literals; `iconNode` is here for
// the panels that build DOM.
export function icon(name, className = 'icon') {
  const path = PATHS[name];
  if (!path) return '';
  return `<svg class="${className}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true">${path}</svg>`;
}

export function iconNode(name, className = 'icon') {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = icon(name, className);
  return wrapper.firstElementChild;
}
