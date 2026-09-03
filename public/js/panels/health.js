// THE BANNER — what the system is doing right now, in a sentence the server
// wrote.
//
// NO TRANSLATION TABLE HERE. `message`, `label` and `fallback` all arrive
// already worded from GET /health (src/domain/healthLadder.ts). This file
// chooses a colour and renders strings. A second wording table in the browser
// is a second place for NORMAL/DEGRADED/CRITICAL to leak out at an operator,
// and the driver's page already learned that lesson.
//
// INVISIBLE WHEN NORMAL, deliberately. A permanent green bar is furniture that
// stops being read; a bar that only ever appears when something is wrong is
// read every time.

const CLASS_BY_MODE = {
  NORMAL: 'alert alert-success',
  DEGRADED: 'alert alert-warning',
  CRITICAL: 'alert alert-danger',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="health"]');
  if (!panel) return;

  const health = state.health;
  panel.hidden = !health || health.mode === 'NORMAL';
  if (panel.hidden) return;

  panel.className = `${CLASS_BY_MODE[health.mode] ?? 'alert alert-secondary'} py-2 px-3 mb-3`;

  const headline = panel.querySelector('[data-field="health-message"]');
  if (headline) headline.textContent = health.message;

  const list = panel.querySelector('[data-field="health-components"]');
  if (!list) return;

  // Only the components that are actually degraded. A list of six rows, five
  // of them saying "fine", buries the one that matters.
  const broken = health.components.filter((component) => component.state !== 'NORMAL');
  list.replaceChildren(
    ...broken.map((component) => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = `${component.label}: `;
      item.append(name, document.createTextNode(component.fallback));
      if (component.detail) {
        const detail = document.createElement('span');
        detail.className = 'text-muted small';
        detail.textContent = ` (${component.detail})`;
        item.append(detail);
      }
      if (component.component === 'PAYMENTS') item.append(paymentsDrillThrough(state));
      return item;
    }),
  );
}

// THE ONE DEGRADED STATE WITH A LIST BEHIND IT.
//
// "3 authorisations waiting on the provider" is a true sentence an operator can
// do nothing with. Invariant 8 says a degraded state must be visible to an
// operator; a count they cannot open is visible and not actionable, which is
// most of the way there and not all of it. The button fetches the rows the
// probe counted (GET /degraded/payments, same threshold) and lists them.
//
// FETCHED ON DEMAND, never on the poll. The banner refreshes every fifteen
// seconds and this panel is shut almost always, so polling the list too would
// be a request per tick for something nobody is reading.
function paymentsDrillThrough(state) {
  const box = document.createElement('div');
  box.className = 'mt-1';

  const button = document.createElement('button');
  button.className = 'btn btn-sm btn-outline-light py-0';
  button.dataset.action = 'show-stuck-payments';
  button.textContent = state.stuckPayments ? 'Hide' : 'Which ones?';
  box.append(button);

  if (!state.stuckPayments) return box;

  const list = document.createElement('ul');
  list.className = 'list-unstyled small mt-1 mb-0';
  if (state.stuckPayments.length === 0) {
    // The sweep cleared them between the probe and the click. Saying so beats
    // an empty box that reads as a broken panel.
    list.append(row('Nothing outstanding now — the retry sweep has cleared them.'));
  }
  for (const payment of state.stuckPayments) {
    list.append(
      row(
        `${payment.jobId} · ${payment.amount} · waiting ${payment.waitingMinutes} min · ` +
          `job ${payment.jobStatus} · zone ${payment.zoneId}`,
      ),
    );
  }
  box.append(list);
  return box;
}

function row(text) {
  const item = document.createElement('li');
  item.className = 'mono';
  item.textContent = text;
  return item;
}
