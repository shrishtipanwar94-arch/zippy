// THE CONVERSATION, on whichever surface registered this panel.
//
// One panel serves the driver and the technician. They see the same thread —
// there is only one conversation per job — and the only difference is which
// side of it is "mine", which the server decides and sends as a flag rather
// than the browser comparing ids it should not have.
//
// NO TYPING INDICATORS AND NO READ RECEIPTS. The brief rules both out and so
// does this file: there is nothing here that reports back what the reader did.
// They are also where messaging balloons — a typing indicator is a write per
// keystroke on a phone with no signal — and neither changes a dispatch
// decision, which is the only thing this chat exists to inform.
//
// morphdom, because the thread grows and reshapes: messages append, a refetch
// replaces the lot, and hand-diffing would mean writing a small diff algorithm.
// It also keeps the scroll position, which matters when a message arrives while
// somebody is reading back through the thread.

// WHOSE MESSAGE IS THIS? Derived from the reader's own role, never sent by the
// server. A room fan-out cannot stamp "yours" per recipient, so a server-side
// flag would exist on the fetched copy and not on the pushed one — and the
// driver would watch their own message change its name a second after sending
// it. A conversation has one driver and one technician, so the role is enough.
function isMine(message, state) {
  return message.senderRole === state.session?.role;
}

export function render(state) {
  const panel = document.querySelector('[data-panel="chat"]');
  if (!panel) return;

  panel.hidden = !state.activeJobId;
  if (panel.hidden) return;

  const list = panel.querySelector('[data-field="chat-messages"]');
  if (!list) return;

  const messages = state.chat.messages;
  const markup = `
    <div class="chat-thread" data-field="chat-messages">
      ${
        messages.length === 0
          ? '<p class="text-muted small mb-0">No messages yet.</p>'
          : messages.map((message) => messageMarkup(message, state)).join('')
      }
    </div>`;

  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  // eslint-disable-next-line no-undef
  morphdom(list, markup);

  // Follow the conversation only if the reader was already at the bottom.
  // Yanking somebody who is scrolled up back down because a message arrived is
  // the same mistake the dispatcher's timeline exists to avoid.
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

function messageMarkup(message, state) {
  const mine = isMine(message, state) ? 'chat-mine' : 'chat-theirs';
  return `
    <div class="chat-bubble ${mine}" data-message-id="${escapeText(message.messageId)}">
      <div class="small text-muted">${escapeText(whoSent(message, state))} · ${escapeText(clockOf(message.at))}</div>
      ${message.photoUrl ? `<img class="chat-photo" src="${escapeAttribute(message.photoUrl)}" alt="Photo sent in this conversation" />` : ''}
      <div>${escapeText(message.body)}</div>
    </div>`;
}

// A person, not a role enum. The driver's surface never shows SCREAMING_CASE
// (Phase 15), and "Technician" reads better than TECHNICIAN on the
// technician's own screen too.
const SENDER_LABEL = {
  DRIVER: 'Driver',
  TECHNICIAN: 'Technician',
  DISPATCHER: 'Zippy',
  FLEET_MANAGER: 'Fleet office',
};

function whoSent(message, state) {
  if (isMine(message, state)) return 'You';
  return SENDER_LABEL[message.senderRole] ?? 'Zippy';
}

function clockOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

// A photo arrives as a data URI the sender's own browser produced. Escaping the
// quotes is what stops a crafted value closing the attribute and adding others
// — the same reason every other value here goes through textContent first.
function escapeAttribute(value) {
  return String(value ?? '').replace(/"/g, '&quot;');
}
