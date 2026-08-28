// Password hashing, isolated so the rest of the code never touches the argon2
// API directly. @node-rs/argon2 defaults to the argon2id variant, which is the
// one we want (resistant to both GPU and side-channel attacks); the default
// cost parameters are the library's current OWASP-aligned recommendation.

import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

// Returns false on a wrong password AND on a malformed stored hash — a caller
// should treat both the same way (deny), never branch on which it was.
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
