/* ============================================================
   Recruit Pro — "Sign in with Google / Outlook"
   Shared account find-or-create logic for OAuth sign-in (as
   opposed to connecting a mailbox for an already-logged-in
   user, which is a separate, existing flow).
   ============================================================ */

const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');

// Finds an existing user by the OAuth provider's verified email, or creates
// a brand-new account for a first-time sign-in. Matching by email is safe
// here specifically because the OAuth provider has ALREADY verified
// ownership of that exact address — stronger proof of ownership than this
// app's own password-reset flow requires. A returning user who originally
// signed up with a password can sign in with Google/Outlook later and lands
// on the same account (their password keeps working too).
async function findOrCreateUserForSignIn({ email, name }) {
  if (!email) throw new Error('OAuth provider did not return an email address');
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await storage.getUserByEmail(normalizedEmail);
  if (existing) return { user: existing, isNewUser: false };

  const user = {
    id:       uuidv4(),
    name:     (name || normalizedEmail.split('@')[0]).trim(),
    email:    normalizedEmail,
    password: null, // OAuth-only account — no password set; password login is rejected (see routes/auth.js)
    userType: 'recruiter_company',
    gmail:    { connected: false, tokens: null, address: '' },
    style:    { tone: 'warm', notes: '', use: [], avoid: [] },
    createdAt: new Date().toISOString()
  };
  await storage.saveUser(user);
  return { user, isNewUser: true };
}

module.exports = { findOrCreateUserForSignIn };
