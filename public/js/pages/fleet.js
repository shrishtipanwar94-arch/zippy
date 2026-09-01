// The fleet manager page. One panel: sign in, then the dashboard.
//
// NO SOCKET. Every other page connects because a driver or a dispatcher needs
// to see something change while they watch it. A fleet manager's monthly
// numbers do not need that — the phase brief is explicit that fleet
// notifications are a coalesced SUMMARY, not a live feed, and this page
// matches that by fetching once and offering a manual refresh rather than
// wiring up a socket only to ignore most of what it would say.

import { registerPanel, render, setError, setFleetDashboard, setSession } from '../state.js';
import * as api from '../api.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderFleetDashboard } from '../panels/fleetDashboard.js';

registerPanel(renderSession);
registerPanel(renderFleetDashboard);

function value(selector) {
  return document.querySelector(selector).value.trim();
}

async function refreshDashboard() {
  try {
    setFleetDashboard(await api.getFleetDashboard());
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
}

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, { role: result.user.role, userId: result.user.id });
    render();
    await refreshDashboard();
    return;
  } catch (error) {
    setError(error.message);
  }
  render();
});

document.querySelector('[data-action="refresh"]').addEventListener('click', refreshDashboard);

render();
