// THE CHAT SURFACE, WIRED ONCE FOR BOTH PAGES.
//
// The driver and the technician talk in the same conversation and answer the
// same kind of card, so the handlers are the same handlers. What differs is
// what each can DO: only the driver can share coordinates or a photo, so those
// two are wired only if the page has the controls, rather than by giving each
// page its own copy of everything.
//
// Every handler here does what every other handler in this codebase does: call
// the API, write to state, call render(). None of them touches the DOM —
// reading an input's value is not touching it; setting one would be.
//
// THE CONFIRM BUTTON IS THE ONLY THING IN THE CLIENT THAT CAN TURN A MESSAGE
// INTO A DISPATCH CHANGE, and it does it by asking the server, which asks the
// policy table. The browser never applies anything.

import {
  getState,
  registerPanel,
  removePromotion,
  render,
  setChatMessages,
  setError,
  setPromotions,
} from './state.js';
import * as api from './api.js';
import { describeAccuracy, explainFailure, readPosition } from './geolocation.js';
import { render as renderChat } from './panels/chat.js';
import { render as renderPromotions } from './panels/promotions.js';

// A photo is read in the browser and sent as a data URI. There is no object
// store in this project, so this is the honest limit rather than a design: big
// enough for a phone photo scaled down, small enough not to make a chat row a
// megabyte of Postgres. See this phase's weaknesses.
const MAX_PHOTO_BYTES = 400_000;

export function registerChatPanels() {
  registerPanel(renderChat);
  registerPanel(renderPromotions);
}

// Called after sign-in and whenever the active job changes. Chat history and
// flagged cards are server state, so they are fetched rather than derived —
// the socket keeps them current afterwards.
export async function loadChat(jobId) {
  if (!jobId) return;
  try {
    const [messages, promotions] = await Promise.all([
      api.listMessages(jobId),
      api.listPromotions(jobId),
    ]);
    setChatMessages(messages.messages);
    setPromotions(promotions.promotions);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
}

// THE DISPATCHER'S HALF, WITHOUT THE CONVERSATION. A console has no chat panel
// and no business pulling a driver's messages into memory to render nothing
// with them — but it does confirm promotions, so it needs the cards on their
// own. Same setter, same socket, one fewer request.
export async function loadPromotions(jobId) {
  if (!jobId) return;
  try {
    const promotions = await api.listPromotions(jobId);
    setPromotions(promotions.promotions);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
}

export function wireChatActions() {
  wireSend();
  wireConfirmations();
  // Driver-only. Absent on the technician's page, and asking for them there
  // would be wiring a button that does not exist.
  wireLocationShare();
  wirePhoto();
}

function wireSend() {
  const button = document.querySelector('[data-action="send-message"]');
  if (!button) return;

  button.addEventListener('click', async () => {
    const input = document.querySelector('#chat-input');
    const body = input.value.trim();
    if (body.length === 0) return;

    await post({ body });
    // Clearing the box the driver just emptied by sending is the one place a
    // handler legitimately writes to the DOM: the input is not state, it is
    // the thing state is read FROM.
    input.value = '';
  });
}

// SHARING A POSITION IS A CONVERSATION, NOT A TAP.
//
// WHAT WAS WRONG. The old handler called getCurrentPosition with no options and
// posted two numbers. Three separate failures came out of that:
//
//   1. NO TIMEOUT. A dismissed permission prompt calls neither callback, so the
//      button did nothing, forever, with no way to tell that from a slow fix.
//   2. NO FEEDBACK. Nothing said "finding you", nothing confirmed it had been
//      sent, so the only sensible thing a driver could do was press it again.
//   3. TWO NUMBERS AND NOTHING ELSE. The phone knows how good the fix is, and
//      LocationEvent has had an `accuracy_metres` column since Phase 6 that
//      nothing ever wrote. A fix good to eight metres and one good to nine
//      hundred arrived looking identical, and a technician sent to the second
//      one has no idea they are looking for a car somewhere in a square
//      kilometre.
//
// SO THE FLOW IS: find → show how good it is → let them add the landmark that
// is frequently worth more than the coordinates → send on confirmation. The
// landmark matters most exactly when the fix is worst, which is why the panel
// asks for it in the same breath as admitting the accuracy.
//
// Held in module state rather than app state: this is a half-finished
// interaction inside one panel, it is discarded on cancel, and nothing else on
// the page renders from it.
let pendingPosition = null;

function shareNodes() {
  return {
    panel: document.querySelector('[data-panel="share-location"]'),
    status: document.querySelector('[data-field="share-status"]'),
    detail: document.querySelector('[data-field="share-detail"]'),
    landmark: document.querySelector('#share-landmark'),
  };
}

function showShare({ status, rough = false, detail = false }) {
  const nodes = shareNodes();
  if (!nodes.panel) return;
  nodes.panel.hidden = false;
  if (nodes.status) {
    nodes.status.textContent = status;
    nodes.status.classList.toggle('is-rough', rough);
  }
  if (nodes.detail) nodes.detail.hidden = !detail;
}

function hideShare() {
  const nodes = shareNodes();
  pendingPosition = null;
  if (nodes.panel) nodes.panel.hidden = true;
  if (nodes.landmark) nodes.landmark.value = '';
}

function wireLocationShare() {
  const button = document.querySelector('[data-action="send-location"]');
  if (!button) return;

  button.addEventListener('click', async () => {
    // Said before the browser prompt appears, so the prompt is explained rather
    // than arriving out of nowhere.
    showShare({ status: 'Finding where you are…' });

    const result = await readPosition();
    if (!result.ok) {
      // Specific to what actually failed. "We could not get your location" is
      // true of every reason and useful for none of them.
      showShare({ status: explainFailure(result.reason), rough: true });
      return;
    }

    pendingPosition = result.position;
    const accuracy = describeAccuracy(result.position.accuracyMetres);
    showShare({ status: accuracy.text, rough: accuracy.rough, detail: true });

    // Pre-filled from what they already told us at intake, so the common case
    // is confirming rather than typing.
    const nodes = shareNodes();
    const known = getState().driverView?.landmark;
    if (nodes.landmark && known && !nodes.landmark.value) nodes.landmark.value = known;
  });

  document.querySelector('[data-action="cancel-location"]')?.addEventListener('click', hideShare);

  document.querySelector('[data-action="confirm-location"]')?.addEventListener('click', async () => {
    if (!pendingPosition) return;
    const nodes = shareNodes();
    const landmark = nodes.landmark?.value.trim() ?? '';
    const position = pendingPosition;

    showShare({ status: 'Sending…' });

    // A REPORT, NOT A MOVE. The coordinates are recorded as something the
    // driver said; whether the JOB moves to them is a promotion an operator
    // confirms. Sending a location cannot silently redirect a van.
    const sent = await post({
      // The landmark goes in the body because that is the part a human reads in
      // the thread; the numbers go in the structured fields because that is the
      // part the system acts on.
      body: landmark
        ? `I have shared where I am. Look for: ${landmark}`
        : 'I have shared where I am.',
      kind: 'LOCATION',
      coordinates: { lat: position.lat, lng: position.lng },
      accuracyMetres: position.accuracyMetres ?? undefined,
      headingDegrees: position.headingDegrees ?? undefined,
    });

    // The panel stays open on a failure, with the fix still held, so a driver
    // can press again without hunting for their location a second time.
    if (sent) hideShare();
    else showShare({ status: 'That did not send. Try again.', rough: true, detail: true });
  });
}

function wirePhoto() {
  const input = document.querySelector('#chat-photo');
  if (!input) return;

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const dataUrl = await readAsDataUrl(file);
      if (dataUrl.length > MAX_PHOTO_BYTES) {
        setError('That photo is too large. Please send a smaller one.');
        render();
        return;
      }
      await post({ body: 'Photo', kind: 'PHOTO', photoUrl: dataUrl });
    } catch {
      setError('We could not read that photo.');
      render();
    }
    input.value = '';
  });
}

// Delegated, because the cards are created and removed as messages are flagged
// and answered, and a listener bound to a removed element is a leak.
function wireConfirmations() {
  const panel = document.querySelector('[data-panel="promotions"]');
  if (!panel) return;

  panel.addEventListener('click', async (clicked) => {
    const button = clicked.target.closest('button[data-confirm], button[data-dismiss]');
    if (!button) return;

    const promotionId = button.dataset.confirm ?? button.dataset.dismiss;
    const decision = button.dataset.confirm ? 'CONFIRMED' : 'REJECTED';

    try {
      await api.confirmPromotion(promotionId, decision);
      // Removed on the answer rather than waiting for the socket, so the card
      // cannot be answered twice by somebody tapping through a slow response.
      // The server refuses a second answer regardless — the conditional update
      // in eventPromotions.ts is the real arbiter.
      removePromotion(promotionId);
      setError(null);
    } catch (error) {
      setError(error.message);
    }
    render();
  });
}

// Returns whether it landed. It used to swallow the failure entirely, which was
// fine while every caller was fire-and-forget — but the location share has to
// keep its confirmation panel open when the send fails, and it cannot know to
// do that from a function that always looks like it worked.
async function post(payload) {
  const jobId = getState().activeJobId;
  if (!jobId) return false;
  let sent = false;
  try {
    await api.sendMessage(jobId, payload);
    setError(null);
    sent = true;
    // The message and any cards it raised come back over the socket. Refetching
    // here would race that and briefly show the thread twice.
  } catch (error) {
    setError(error.message);
  }
  render();
  return sent;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
