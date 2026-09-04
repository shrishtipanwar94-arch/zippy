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

// WHO IS SIGNED IN — and only who.
//
// This used to read "Dispatcher · user-dispatcher", which is two problems in
// one line. The role was already the page's own <h1> on both surfaces that
// carry this field, so the header said "DISPATCHER … Dispatcher"; and
// `user-dispatcher` is a database primary key, which identifies the row rather
// than the person. A header that repeats the page title and then prints an
// internal id is furniture.
//
// The email's local part is the shortest thing here that is genuinely about a
// person, and the full address goes on the title for anyone who needs to be
// sure which account they are on. The role word is gone entirely, which also
// closes the leak the old map existed to patch: a fleet manager cannot read
// FLEET_MANAGER in their own header if the header never prints a role.
function describeSession(session) {
  if (!session) return { text: 'signed out', title: '' };
  const email = session.email ?? '';
  const localPart = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
  // Falls back to the id only when a caller did not pass an email — visible and
  // ugly on purpose rather than blank.
  return { text: localPart || session.userId, title: email };
}

export function render(state) {
  renderConnection(state);

  const who = document.querySelector('[data-field="session"]');
  if (who) {
    const { text, title } = describeSession(state.session);
    if (who.textContent !== text) who.textContent = text;
    if (who.title !== title) who.title = title;
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

  // NO CONNECTION INDICATOR BEFORE THERE IS A SESSION.
  //
  // A sign-in form under a grey badge reading "No connection" tells somebody
  // who has not signed in yet that the software is broken — and they are right
  // to read it that way, because at that moment the badge is reporting a socket
  // nobody has opened rather than a network that has failed. It becomes real
  // information the moment there is a session it could interrupt.
  const spoken = document.querySelector('[data-field="connection-text"]');
  node.hidden = !state.session;
  if (spoken) spoken.hidden = !state.session;
  if (!state.session) return;

  const words = CONNECTION_WORDS[state.connection] ?? state.connection;

  if (node.classList.contains('conn-dot')) {
    if (node.title !== words) node.title = words;
    node.classList.toggle('is-down', state.connection !== 'connected');
    if (spoken && spoken.textContent !== words) spoken.textContent = words;
    return;
  }

  if (node.textContent !== words) node.textContent = words;
  const className = `badge ${CONNECTION_CLASS[state.connection]}`;
  if (node.className !== className) node.className = className;
}
