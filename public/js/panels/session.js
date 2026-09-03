// Login box and connection badge. Rendered from state like everything else, so
// "am I connected" has exactly one source of truth and cannot get stuck showing
// green after the socket has gone.

const CONNECTION_CLASS = {
  connected: 'text-bg-success',
  connecting: 'text-bg-warning',
  disconnected: 'text-bg-secondary',
};

// The same three states, in the words a person reads rather than the lowercase
// keys the socket uses.
const CONNECTION_WORDS = {
  connected: 'Connected',
  connecting: 'Reconnecting…',
  disconnected: 'No connection',
};

// WHO IS SIGNED IN, in words. `state.session.role` is a Prisma enum, and this
// header sits on all four surfaces — including the fleet manager's, who is a
// customer and was reading FLEET_MANAGER in their own page header. One map here
// rather than a per-page one: the header markup is identical everywhere, so the
// leak was too.
const ROLE_WORDS = {
  DRIVER: 'Driver',
  TECHNICIAN: 'Technician',
  DISPATCHER: 'Dispatcher',
  FLEET_MANAGER: 'Fleet manager',
};

export function render(state) {
  renderConnection(state);

  const who = document.querySelector('[data-field="session"]');
  if (who) {
    const role = state.session ? (ROLE_WORDS[state.session.role] ?? state.session.role) : null;
    const text = state.session ? `${role} · ${state.session.userId}` : 'signed out';
    if (who.textContent !== text) who.textContent = text;
  }

  // The login form disappears once there is a session, and the working area
  // appears. Both are driven by state, never toggled from a click handler.
  const loginForm = document.querySelector('[data-panel="login"]');
  if (loginForm) loginForm.hidden = Boolean(state.session);

  const workspace = document.querySelector('[data-panel="workspace"]');
  if (workspace) workspace.hidden = !state.session;

  const error = document.querySelector('[data-field="error"]');
  if (error) {
    const text = state.error ?? '';
    if (error.textContent !== text) error.textContent = text;
    error.hidden = !state.error;
  }
}

// TWO SHAPES FOR ONE FACT, and the difference is not decorative.
//
// The console shows a BADGE that spells the state out: an operator is watching
// many things and "disconnected" has to be legible without interpretation. The
// two field surfaces show a DOT, because a phone header that permanently reads
// "connected" in the same weight as everything else trains a driver to ignore
// the one time it matters. The dot still carries the word in its title and in
// visually hidden text, so a screen reader and a hover both get the sentence
// and colour is never the only signal.
function renderConnection(state) {
  const node = document.querySelector('[data-field="connection"]');
  if (!node) return;

  const words = CONNECTION_WORDS[state.connection] ?? state.connection;

  if (node.classList.contains('conn-dot')) {
    if (node.title !== words) node.title = words;
    node.classList.toggle('is-down', state.connection !== 'connected');
    const spoken = document.querySelector('[data-field="connection-text"]');
    if (spoken && spoken.textContent !== words) spoken.textContent = words;
    return;
  }

  if (node.textContent !== words) node.textContent = words;
  const className = `badge ${CONNECTION_CLASS[state.connection]}`;
  if (node.className !== className) node.className = className;
}
