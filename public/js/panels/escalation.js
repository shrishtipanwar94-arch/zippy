// THE HUMAN ESCALATION CARD — what a dispatcher sees instead of a blank
// screen when the system has no plan.
//
// FIVE FIELDS AND THREE BUTTONS, all of them the server's words: the reason,
// its feasibility code, the option that came closest and why it was refused,
// the alternative, and a recommendation. src/domain/escalationCard.ts builds
// every sentence; this file puts them on screen and sends back which button
// was pressed.
//
// THE CODE IS SHOWN, not hidden behind the plain-language reason. An operator
// who has seen CAPABILITY_MISSING three times this week knows more about their
// fleet than the sentence alone tells them, and it is the string they will
// quote when they ask why.

export function render(state) {
  const panel = document.querySelector('[data-panel="escalation"]');
  if (!panel) return;

  const card = state.escalation;
  panel.hidden = !card;
  if (!card) return;

  setText(panel, 'escalation-reason', card.reason);
  setText(panel, 'escalation-code', `Reason code: ${card.reasonCode}`);
  setText(
    panel,
    'escalation-closest',
    card.closestExplanation ?? 'No unit was even considered for this job.',
  );
  setText(panel, 'escalation-alternative', `Alternative: ${card.alternative}`);
  setText(panel, 'escalation-recommendation', card.recommendation);

  const decided = panel.querySelector('[data-field="escalation-decided"]');
  if (decided) {
    decided.hidden = !state.escalationDecision;
    if (state.escalationDecision) decided.textContent = state.escalationDecision;
  }
}

function setText(panel, field, text) {
  const node = panel.querySelector(`[data-field="${field}"]`);
  if (node) node.textContent = text;
}
