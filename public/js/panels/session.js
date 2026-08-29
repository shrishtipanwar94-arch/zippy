// Login box and connection badge. Rendered from state like everything else, so
// "am I connected" has exactly one source of truth and cannot get stuck showing
// green after the socket has gone.

const CONNECTION_CLASS = {
  connected: 'bg-success',
  connecting: 'bg-warning text-dark',
  disconnected: 'bg-secondary',
};

export function render(state) {
  const badge = document.querySelector('[data-field="connection"]');
  if (badge) {
    if (badge.textContent !== state.connection) badge.textContent = state.connection;
    const className = `badge ${CONNECTION_CLASS[state.connection]}`;
    if (badge.className !== className) badge.className = className;
  }

  const who = document.querySelector('[data-field="session"]');
  if (who) {
    const text = state.session ? `${state.session.role} · ${state.session.userId}` : 'signed out';
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
