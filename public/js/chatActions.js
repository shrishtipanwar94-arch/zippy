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

function wireLocationShare() {
  const button = document.querySelector('[data-action="send-location"]');
  if (!button) return;

  button.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setError('This browser cannot share your location.');
      render();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        // A REPORT, NOT A MOVE. The coordinates are recorded as something the
        // driver said; whether the JOB moves to them is a promotion an
        // operator confirms. Sending a location cannot silently redirect a van.
        await post({
          body: 'I have shared my exact location.',
          kind: 'LOCATION',
          coordinates: {
            lat: Number(position.coords.latitude.toFixed(5)),
            lng: Number(position.coords.longitude.toFixed(5)),
          },
        });
      },
      () => {
        setError('We could not read your location. You can describe where you are instead.');
        render();
      },
    );
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

async function post(payload) {
  const jobId = getState().activeJobId;
  if (!jobId) return;
  try {
    await api.sendMessage(jobId, payload);
    setError(null);
    // The message and any cards it raised come back over the socket. Refetching
    // here would race that and briefly show the thread twice.
  } catch (error) {
    setError(error.message);
  }
  render();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
