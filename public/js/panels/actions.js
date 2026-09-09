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

// Kinds, in words — and ONLY in words now.
//
// This card used to print the sentence and the raw kind beside it, on the
// argument that an operator who has seen REASSIGN_AFTER_DIAGNOSIS_CHANGE three
// times this week knows more than the sentence tells them. That argument holds
// for the escalation card's FEASIBILITY CODE, which is a reason a specific
// option was rejected and has no plain-English equivalent. It does not hold
// here: "Two jobs want the same crew" already says everything
// APPROVE_CROSS_TENANT_CONTENTION says, in fewer characters, so the raw kind
// was pure duplication sitting under well-written copy.
//
// The truncated job id went with it. A cuid wrapped across four lines in a
// 3rem column identifies nothing — it was neither readable nor clickable, and
// the reason line underneath already names what the action is about.
//
// ONE ENTRY PER KIND IN src/domain/actionTiers.ts, INCLUDING THE AUTO ONES.
// Two of the four keys this map opened with — `SLA_BREACH_FOLLOW_UP` and
// `CONTENTION_REVIEW` — were names nothing in the system has ever raised, so
// five of the seven kinds a dispatcher can actually be shown fell through to
// the raw enum and rendered ESCALATE_SLA_WINDOW_CLOSED as the card's title.
// tests/consolePanels.test.ts now asserts this map against ACTION_KINDS so the
// two cannot drift again.
//
// The AUTO kinds are here even though `GET /actions` only returns rows still
// waiting on a person: an AUTO action resolves the moment it is requested, but
// a slow write or a future change that surfaces resolved rows should not put an
// enum on screen to announce it.
const KIND_LABEL = {
  NOTIFY_ETA_CHANGED: 'Told the driver their arrival time moved',
  RELEASE_EXPIRED_HOLD: 'Released a hold that had already expired',
  NOTIFY_DIAGNOSIS_CONFIRMED: 'Told the driver the diagnosis was confirmed',

  REASSIGN_AFTER_DIAGNOSIS_CHANGE: 'Reassign — the diagnosis changed',
  REASSIGN_AFTER_TRIGGER: 'Reassign — a re-plan trigger fired',
  RELEASE_TECHNICIAN_NO_LONGER_NEEDED: 'Release a crew this job no longer needs',
  ESCALATE_SLA_WINDOW_CLOSED: 'SLA window closed — commercial follow-up',
  ESCALATE_NO_FEASIBLE_PLAN: 'No crew can take this job',

  ESCALATE_THRASHING_JOB: 'This job keeps being re-planned',
  CANCEL_JOB: 'Cancel this job',
  APPROVE_CROSS_TENANT_CONTENTION: 'Two jobs want the same crew',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="actions"]');
  if (!panel) return;

  const actions = state.actions ?? [];
  // TWO LISTS, NOT ONE SORTED LIST. Sorting would still put fourteen SLA
  // follow-ups between a dispatcher and the card that dispatches somebody as
  // soon as a fifteenth arrives; a heading is what makes "there is nothing for
  // me right now" readable at a glance. The server decides which is which —
  // see needsDecision in domain/actionTiers.ts — so there is one answer rather
  // than a browser one and a server one.
  const decide = actions.filter((action) => action.needsDecision);
  const noted = actions.filter((action) => !action.needsDecision);

  const markup = `
    <div data-panel="actions" class="card mt-3">
      <div class="card-header d-flex justify-content-between">
        <span>Action queue</span>
        <span>${decide.length} to decide${noted.length ? ` · ${noted.length} noted` : ''}</span>
      </div>
      <div class="card-body p-2">
        ${
          actions.length === 0
            ? '<p class="text-muted small mb-0">Nothing waiting on a person.</p>'
            : `
              <div class="text-uppercase small text-muted mb-1">Needs a decision</div>
              ${
                decide.length === 0
                  ? '<p class="text-muted small mb-2">Nothing is waiting on you. Nobody is stranded without a plan.</p>'
                  : decide.map(cardMarkup).join('')
              }
              ${
                noted.length === 0
                  ? ''
                  : `<details class="mt-2">
                       <summary class="text-uppercase small text-muted">
                         For the record — ${noted.length}
                       </summary>
                       <p class="small text-muted mt-1 mb-1">
                         Real work, and none of it blocks a van. Commercial
                         follow-up on jobs that are already being dispatched
                         normally.
                       </p>
                       ${noted.map(cardMarkup).join('')}
                     </details>`
              }`
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
        </div>
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
