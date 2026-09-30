import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn roughly the same time as a real password check. Used when the email is unknown so
 * response timing does not reveal which accounts exist.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= bcrypt.hash("dummy-password-for-timing", BCRYPT_COST);
  await bcrypt.compare(plain, await dummyHash);
  return false;
}
