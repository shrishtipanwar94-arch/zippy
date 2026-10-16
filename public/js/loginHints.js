// WHICH ACCOUNT THIS PAGE'S SIGN-IN FORM SHOULD OFFER.
//
// The HTML pre-fills the main seed's accounts and the published dev password,
// which is right for local development. On the deployed demo (DEMO_MODE) the
// server lists exactly three accounts at GET /login/accounts, one per page,
// and this swaps the email in and clears the password box: the demo's
// password is the deployment's SEED_PASSWORD, and pre-filling the dev one
// would only produce a confusing "invalid credentials".
//
// Fails quietly: if the request fails, the page keeps what the HTML had.

export async function fetchLoginAccounts() {
  try {
    const response = await fetch('/login/accounts');
    if (!response.ok) return { demoMode: false, accounts: [] };
    return await response.json();
  } catch {
    return { demoMode: false, accounts: [] };
  }
}

export async function applyLoginHints(page) {
  const { demoMode, accounts } = await fetchLoginAccounts();
  if (!demoMode) return;

  const account = accounts.find((candidate) => candidate.page === page);
  const email = document.querySelector('#email');
  const password = document.querySelector('#password');
  if (account && email) email.value = account.email;
  if (password) {
    password.value = '';
    password.placeholder = 'the demo password';
  }
}
