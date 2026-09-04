// ASKING THE PHONE WHERE IT IS, once, properly.
//
// WHY THIS FILE EXISTS. Both callers used `navigator.geolocation
// .getCurrentPosition(onOk, onFail)` with NO OPTIONS, and that has a failure
// mode people do not expect: if the permission prompt is DISMISSED rather than
// answered — the driver taps outside it, or the notification slides away —
// neither callback is ever called. Not late. Never.
//
// On the intake step that was worse than doing nothing. Pressing "Use my
// current location" set `locating: true`, which disables the "Send for help"
// button, and nothing ever cleared it. A driver who tapped the location button
// and dismissed the prompt could no longer ask for help at all, with nothing on
// screen explaining why. The one button that must always work was disabled by
// the button next to it.
//
// So: an explicit timeout, and a promise that ALWAYS settles.
//
// WHY THE FAILURE REASONS ARE SEPARATED. "We could not get your location" is
// true for all of them and useful for none. A driver who denied permission
// needs to know it is fixable in their browser; a driver on a hotel wifi with
// no GPS needs to be told to type a landmark instead; a driver on a page served
// over plain http cannot fix it at all and should not be sent hunting through
// settings. Different problems, different sentences.

// Long enough for a cold GPS fix on a cheap handset, short enough that a driver
// does not conclude the app has frozen. A fix that takes longer than this is
// one we should stop waiting for and ask them to describe where they are.
const FIX_TIMEOUT_MS = 12_000;

// A fix this old is still worth having — a car that has broken down is not
// moving — and reusing one avoids a second cold start.
const ACCEPTABLE_AGE_MS = 30_000;

// Past this the fix is a district rather than a place. Still worth sending, but
// the screen says so and asks for a landmark instead of pretending.
export const ROUGH_ACCURACY_METRES = 100;

export function geolocationAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
}

// SECURE CONTEXT IS THE ONE FAILURE NOBODY CAN ACT ON. Browsers refuse
// geolocation on plain http, and the API reports it as an ordinary permission
// denial — so a driver reached over a LAN address or a plain-http tunnel is
// told to check their permissions, where they will find nothing wrong. Checked
// up front so that case gets its own sentence.
export function inSecureContext() {
  return typeof window === 'undefined' || window.isSecureContext !== false;
}

// Always settles. Resolves { ok: true, position } or { ok: false, reason }.
// Never rejects: a caller that has to remember a try/catch to avoid disabling
// its own submit button is the bug this file was written to remove.
export function readPosition() {
  return new Promise((resolve) => {
    if (!geolocationAvailable()) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    if (!inSecureContext()) {
      resolve({ ok: false, reason: 'insecure' });
      return;
    }

    // BELT AND BRACES. `timeout` in the options covers a lookup that runs long;
    // this covers the case the options cannot — a prompt that is dismissed, on
    // browsers that then never call either callback.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const guard = setTimeout(() => finish({ ok: false, reason: 'timeout' }), FIX_TIMEOUT_MS + 1_000);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(guard);
        finish({ ok: true, position: describe(position) });
      },
      (error) => {
        clearTimeout(guard);
        finish({ ok: false, reason: reasonFor(error) });
      },
      {
        // A roadside location is useless at city-block resolution, and the
        // driver is stationary, so the battery cost of the good fix is worth
        // paying once.
        enableHighAccuracy: true,
        timeout: FIX_TIMEOUT_MS,
        maximumAge: ACCEPTABLE_AGE_MS,
      },
    );
  });
}

// EVERYTHING THE PHONE KNOWS, not just the two numbers.
//
// `accuracy` is the field that changes what anyone can do with this. A fix good
// to 8 metres puts a van at the right car; a fix good to 900 metres puts it in
// the right neighbourhood, and the difference has to travel with the
// coordinates rather than being assumed away by whoever reads them.
//
// Heading and speed are kept when the phone reports them, because a driver who
// is still moving when they share is a different situation from one parked on a
// verge — and on a divided highway the direction of travel decides which
// carriageway a van has to be on.
function describe(position) {
  const { latitude, longitude, accuracy, heading, speed } = position.coords;
  return {
    lat: Number(latitude.toFixed(5)),
    lng: Number(longitude.toFixed(5)),
    accuracyMetres: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    headingDegrees: Number.isFinite(heading) ? Math.round(heading) : null,
    // Below walking pace is noise from a stationary phone, not movement.
    movingMetresPerSecond: Number.isFinite(speed) && speed > 1 ? Number(speed.toFixed(1)) : null,
    at: new Date(position.timestamp ?? Date.now()).toISOString(),
  };
}

function reasonFor(error) {
  if (error?.code === 1) return 'denied';
  if (error?.code === 3) return 'timeout';
  return 'unavailable';
}

// The sentence a driver reads. One per reason, and each one says what they can
// do next rather than what went wrong internally.
const REASON_TEXT = {
  unsupported: 'This phone cannot share its location. Tell us a landmark instead.',
  insecure: 'Location sharing needs a secure connection. Tell us a landmark instead.',
  denied: 'Location is switched off for this page. You can turn it on in your browser, or just tell us a landmark.',
  timeout: 'We could not get a fix. Try again in the open, or tell us a landmark.',
  unavailable: 'Your phone could not find a signal. Tell us a landmark instead.',
};

export function explainFailure(reason) {
  return REASON_TEXT[reason] ?? REASON_TEXT.unavailable;
}

// HOW GOOD IS THIS FIX, in words rather than a number with a unit nobody reads.
//
// The point is not precision, it is whether a landmark is still needed. Under
// about 30 metres a van arrives at the car; past 100 the driver has to describe
// something the technician can see.
export function describeAccuracy(accuracyMetres) {
  if (!Number.isFinite(accuracyMetres)) {
    return { text: 'We have your position.', rough: false };
  }
  if (accuracyMetres <= 30) {
    return { text: `Accurate to about ${Math.round(accuracyMetres)} metres.`, rough: false };
  }
  if (accuracyMetres <= ROUGH_ACCURACY_METRES) {
    return { text: `Accurate to about ${Math.round(accuracyMetres)} metres.`, rough: false };
  }
  return {
    text: `This is only accurate to about ${Math.round(accuracyMetres)} metres. Please add a landmark.`,
    rough: true,
  };
}
