// THE LANDING PAGE'S FOOTER, in demo mode: name the three accounts the demo
// uses instead of promising the published dev password, which the deployed
// demo does not use. Outside demo mode the footer stays as the HTML wrote it.

import { fetchLoginAccounts } from '../loginHints.js';

const { demoMode, accounts } = await fetchLoginAccounts();
const footer = document.querySelector('.home-footer');

if (demoMode && footer) {
  const lines = accounts.map((account) => `<code>${account.email}</code> (${account.page})`);
  footer.innerHTML = `Demo accounts: ${lines.join(', ')}. Ask the presenter for the password.`;
}
