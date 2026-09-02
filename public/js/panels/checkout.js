// THE CALLOUT FEE, PAID FROM THE DRIVER'S PHONE — Razorpay's test-mode
// checkout, and nothing else on this page changes because of it.
//
// THE JOB IS ALREADY UNDER WAY BY THE TIME THIS APPEARS. Payment is never on
// the dispatch path (invariant 8): somebody is already driving out, and this
// panel is how the driver settles the callout fee while they wait. If the
// gateway is unconfigured or unreachable the panel simply stays hidden and the
// server's retry sweep chases the money later — a driver at the roadside is
// never blocked by a card.
//
// THE WIDGET RUNS ON RAZORPAY'S ORIGIN. This file passes it an order id and a
// publishable key; the card number is typed into their iframe and never touches
// this page, this server, or this project's database.
//
// WHAT COMES BACK IS A HINT. Razorpay hands us a payment id and a signature and
// we post them to the server, which verifies the signature and then goes and
// asks Razorpay itself what happened. The panel does not mark anything paid —
// it re-reads the driver view like every other action here does.

import * as api from '../api.js';

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

let opening = false;

function panelRoot() {
  return document.querySelector('[data-panel="checkout"]');
}

export function render(state) {
  const panel = panelRoot();
  if (!panel) return;

  // Shown only when the server said there is something to pay AND a gateway to
  // pay it through. Every other answer — a fleet job, a covered consumer, an
  // unconfigured gateway — hides it, which is the honest thing: an unpayable
  // button is worse than no button.
  const checkout = state.checkout;
  panel.hidden = !checkout || checkout.status !== 'READY';
  if (panel.hidden) return;

  const amount = panel.querySelector('[data-field="checkout-amount"]');
  const text = `₹${(checkout.amountPaise / 100).toFixed(2)}`;
  if (amount && amount.textContent !== text) amount.textContent = text;
}

// Loaded on demand rather than in driver.html, so a driver whose job never
// needs a card never fetches a third-party script at all.
function loadCheckoutScript() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${CHECKOUT_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('could not load the payment window')));
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('could not load the payment window'));
    document.head.appendChild(script);
  });
}

// One tap: open the order, load the widget, and hand it over. `opening` guards
// a double tap, which would otherwise stack two widgets over each other — the
// server side is idempotent regardless, so the worst case is cosmetic.
export async function openCheckout(jobId, onFinished) {
  if (opening) return;
  opening = true;
  try {
    const checkout = await api.startCheckout(jobId);
    if (checkout.status !== 'READY') return;

    await loadCheckoutScript();

    const razorpay = new window.Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderRef,
      amount: checkout.amountPaise,
      currency: checkout.currency,
      name: 'Zippy',
      description: 'Callout fee',
      handler: async (response) => {
        await api.confirmCheckout(jobId, {
          orderRef: response.razorpay_order_id,
          paymentRef: response.razorpay_payment_id,
          signature: response.razorpay_signature,
        });
        await onFinished();
      },
    });
    razorpay.open();
  } finally {
    opening = false;
  }
}

// Asked once when a job becomes active, so the panel knows whether to appear.
export async function loadCheckout(jobId) {
  return api.startCheckout(jobId);
}
