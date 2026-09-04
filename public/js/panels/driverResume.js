// "WHICH CAR ARE YOU ASKING ABOUT?" — shown only when a driver signs in with
// more than one job still open.
//
// One open job never reaches this panel: pages/driver.js restores it silently,
// because asking somebody a question whose answer you already know is a worse
// experience than not asking. Two is rare — a fleet driver with two cars off
// the road — but real, and guessing between them would be worse than asking.
//
// The plate is the whole row. It is what a driver recognises, and the worded
// status underneath comes from the server (src/api/driver.ts) so this panel
// owns no vocabulary of its own.

export function render(state) {
  const panel = document.querySelector('[data-panel="resume"]');
  if (!panel) return;

  const jobs = state.openJobs ?? [];
  panel.hidden = jobs.length === 0;
  if (panel.hidden) return;

  const list = panel.querySelector('[data-field="resume-list"]');
  if (!list) return;

  // Built with createElement, not an HTML string: a registration is
  // user-supplied text, and this panel would otherwise interpolate it into
  // markup — the same rule the vehicle picker follows.
  list.replaceChildren(
    ...jobs.map((job) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.dataset.resumeJob = job.jobId;

      const plate = document.createElement('span');
      plate.className = 'resume-plate';
      plate.textContent = job.registration;

      const status = document.createElement('span');
      status.className = 'resume-status';
      status.textContent = job.status;

      const stack = document.createElement('span');
      stack.append(plate, status);
      button.append(stack);
      return button;
    }),
  );
}
