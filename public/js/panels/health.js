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
      return item;
    }),
  );
}
