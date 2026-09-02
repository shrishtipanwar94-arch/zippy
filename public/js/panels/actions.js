// THE ACTION QUEUE — what the system would like to do, and who says yes.
//
// Phase 13 built the whole tier model: an ActionRequest carries a TIER, a
// reason, and a computed impact, and the two tiers mean genuinely different
// things about authority:
//
//   RECOMMEND  the system is confident and is asking to get on with it. A
//              dispatcher executes it. One button.
//   APPROVE    the system explicitly refused to decide. Nothing happens until
//              a person signs it off, and the sign-off is RECORDED against
//              them (ApprovalRecord) — that record is the entire point of the
//              tier, which is why approving and rejecting are separate routes
//              from executing.
//
// UNTIL PHASE 22b'S AUDIT NONE OF THIS HAD A UI. `GET /actions` returned rows,
// `POST /actions/:id/execute` and `/approve` worked, and the dispatcher console
// rendered none of them — a queue nobody could see is a queue nobody works.
//
// REASON AND IMPACT ARE SHOWN TOGETHER, always. A recommendation without its
// impact is an instruction, and the phase brief's whole argument for the tier
// model is that a dispatcher should be able to disagree with the machine. They
// cannot disagree with a row that only says what it wants.

const TIER_LABEL = {
  RECOMMEND: 'Recommended',
  APPROVE: 'Needs sign-off',
};

// Kinds, in words. The raw kind is shown too — an operator who has seen
// REASSIGN_AFTER_DIAGNOSIS_CHANGE three times this week knows more about their
// fleet than the sentence alone tells them, exactly as the escalation card
// shows its feasibility code.
const KIND_LABEL = {
  REASSIGN_AFTER_DIAGNOSIS_CHANGE: 'Reassign — the diagnosis changed',
  REASSIGN_AFTER_TRIGGER: 'Reassign — a re-plan trigger fired',
  SLA_BREACH_FOLLOW_UP: 'SLA breach — follow up',
  CONTENTION_REVIEW: 'Two jobs want the same crew',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="actions"]');
  if (!panel) return;

  const actions = state.actions ?? [];
  const markup = `
    <div data-panel="actions" class="card mt-3">
      <div class="card-header d-flex justify-content-between">
        <span>Action queue</span>
        <span>${actions.length}</span>
      </div>
      <div class="card-body p-2">
        ${
          actions.length === 0
            ? '<p class="text-muted small mb-0">Nothing waiting on a person.</p>'
            : actions.map(cardMarkup).join('')
        }
      </div>
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

function cardMarkup(action) {
  const approve = action.tier === 'APPROVE';
  return `
    <div class="action-row ${approve ? 'action-approve' : 'action-recommend'}" data-action-id="${escapeHtml(action.id)}">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div>
          <span class="badge ${approve ? 'text-bg-danger' : 'text-bg-warning'}">
            ${escapeHtml(TIER_LABEL[action.tier] ?? action.tier)}
          </span>
          <strong class="ms-1">${escapeHtml(KIND_LABEL[action.kind] ?? action.kind)}</strong>
          <div class="reason-code d-inline-block ms-1">${escapeHtml(action.kind)}</div>
        </div>
        <span class="mono">${escapeHtml(action.jobId ?? '—')}</span>
      </div>

      <p class="small mb-1 mt-1">${escapeHtml(action.reason)}</p>
      ${impactMarkup(action.computedImpact)}

      <div class="d-flex gap-1 mt-2">
        ${
          approve
            ? `<button class="btn btn-sm btn-outline-light" data-approve="${escapeHtml(action.id)}">Sign off</button>
               <button class="btn btn-sm btn-outline-danger" data-reject="${escapeHtml(action.id)}">Reject</button>`
            : `<button class="btn btn-sm btn-warning" data-execute="${escapeHtml(action.id)}">Execute</button>`
        }
      </div>
    </div>`;
}

// WHAT IT WOULD COST, from the row the server computed. Rendered as whatever
// keys are actually there rather than against a fixed shape: `computed_impact`
// is JSON written by several different callers (redispatch, contention, SLA
// escalation) and a panel that assumed one of their shapes would silently show
// nothing for the others.
function impactMarkup(impact) {
  if (!impact || typeof impact !== 'object') return '';
  const rows = Object.entries(impact)
    .filter(([, value]) => value !== null && typeof value !== 'object')
    .map(
      ([key, value]) =>
        `<li class="d-flex justify-content-between gap-3">
           <span class="text-muted">${escapeHtml(inWords(key))}</span>
           <span class="mono">${escapeHtml(String(value))}</span>
         </li>`,
    );
  if (rows.length === 0) return '';
  return `<ul class="list-unstyled small mb-0 impact-list">${rows.join('')}</ul>`;
}

// `etaDeltaSeconds` reads as "eta delta seconds". Not perfect English, and far
// better than a camelCase key on an operator's screen.
function inWords(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function escapeHtml(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
