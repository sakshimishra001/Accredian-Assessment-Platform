"use server";

import { redirect } from "next/navigation";
import { EXAM_LOGIN_ERRORS, LEARNER_LOGIN_ERRORS, LEARNER_LOGIN_PATH, LOGIN_ERRORS } from "@/lib/auth/constants";
import { resolvePostLoginPath, Role } from "@/lib/auth/rbac";
import { LEARNER_DASHBOARD } from "@/lib/learner/landing";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { loginSchema } from "@/lib/validation/auth";
import { examLoginSchema, learnerLoginSchema } from "@/lib/validation/learner";
import { formatDateTime } from "@/lib/format";
import { formToObject, runAction, type ActionResult, type FormState } from "../action-result";
import { AuditAction, recordAudit } from "../audit";
import { clearSessionCookie, getCurrentUser, getRequestMeta, readSessionToken, setSessionCookie } from "./current-user";
import { loginRetryAfter, recordLoginFailure, recordLoginSuccess, type LoginKind } from "../security/login-throttle";
import { getLearnerLandingPath } from "../services/learner-home";
import { authenticateExamCredential, authenticateLearner, burnExamLoginWork } from "./exam-login";
import { verifyAgainstDummy } from "./password";
import { login } from "./service";
import { invalidateSession } from "./session";

/**
 * Is this sign-in paused by the throttle? If so, do the same (dummy) hashing work as a real attempt
 * so the response time doesn't reveal the pause, and audit it. The caller answers with the usual
 * "incorrect" message: a lockout must not reveal whether the account exists.
 */
async function throttled(kind: LoginKind, email: string, ip: string | null | undefined, burn: () => Promise<unknown>) {
  const retryAfterMs = loginRetryAfter(kind, email, ip);
  if (retryAfterMs === 0) return false;
  await burn();
  await recordAudit({
    actorId: null,
    action: AuditAction.LOGIN_THROTTLED,
    entityType: "User",
    metadata: { kind, email: email.trim().toLowerCase(), retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    ipAddress: ip ?? null,
  });
  return true;
}

/**
 * Sign in with email + password. On success the opaque session token is set as an httpOnly
 * cookie and the browser is redirected to the role's area (or a safe `next` path).
 */
export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await runAction(async () => {
    const parsed = loginSchema.safeParse(formToObject(formData));
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Enter your email and password.");

    const meta = await getRequestMeta();
    if (await throttled("staff", parsed.data.email, meta.ipAddress, () => verifyAgainstDummy(parsed.data.password))) {
      throw new ValidationError(LOGIN_ERRORS.invalid_credentials);
    }
    const outcome = await login(parsed.data.email, parsed.data.password, meta);
    if (!outcome.ok) {
      // Unknown email and wrong password share one message so accounts can't be discovered.
      if (outcome.reason === "account_disabled") throw new ForbiddenError(LOGIN_ERRORS.account_disabled);
      recordLoginFailure("staff", parsed.data.email, meta.ipAddress);
      throw new ValidationError(LOGIN_ERRORS.invalid_credentials);
    }
    recordLoginSuccess("staff", parsed.data.email, meta.ipAddress);

    await setSessionCookie(outcome.token, outcome.expiresAt);
    return resolvePostLoginPath(outcome.user.role, parsed.data.next);
  });

  if (!result.ok) return result;
  // redirect() throws, so it must stay outside runAction's try/catch.
  redirect(result.data!);
}

/**
 * Legacy learner sign-in with email + assessment-specific exam password (the learner page uses
 * learnerLoginAction, which accepts these too while a learner has no password). The session is scoped to the
 * assessment the credential was issued for; the code itself is never stored client-side.
 */
export async function examLoginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await runAction(async () => {
    const parsed = examLoginSchema.safeParse(formToObject(formData));
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Enter your email and exam password.");

    const meta = await getRequestMeta();
    if (await throttled("exam", parsed.data.email, meta.ipAddress, () => burnExamLoginWork(parsed.data.code))) {
      throw new ValidationError(EXAM_LOGIN_ERRORS.invalid_credentials);
    }
    const outcome = await authenticateExamCredential(parsed.data.email, parsed.data.code, meta);
    if (!outcome.ok && outcome.reason === "invalid_credentials") recordLoginFailure("exam", parsed.data.email, meta.ipAddress);
    if (outcome.ok) recordLoginSuccess("exam", parsed.data.email, meta.ipAddress);
    if (!outcome.ok) {
      if (outcome.reason === "account_disabled") throw new ForbiddenError(EXAM_LOGIN_ERRORS.account_disabled);
      if (outcome.reason === "not_yet_valid" && outcome.validFrom) {
        throw new ValidationError(`${EXAM_LOGIN_ERRORS.not_yet_valid} It works from ${formatDateTime(outcome.validFrom)} IST.`);
      }
      throw new ValidationError(EXAM_LOGIN_ERRORS[outcome.reason]);
    }

    await setSessionCookie(outcome.token, outcome.expiresAt);
    return resolvePostLoginPath(outcome.user.role, parsed.data.next);
  });

  if (!result.ok) return result;
  redirect(result.data!);
}

/**
 * Learner sign-in at /learner/login: email + the learner's own password (or, for a learner who has
 * none yet, a still-valid exam password — see authenticateLearner). Then, decided on the server from
 * the learner's assignments, attempts and the server clock: straight to an active, unfinished
 * assessment; otherwise a requested learner page (`next`), or the dashboard.
 *
 * Returns that path rather than redirecting: the form opens it with a full page load, because the
 * exam page's own security headers (camera permission; WebAssembly for face detection) apply only
 * to a document loaded from it — an in-app navigation would keep the sign-in page's.
 */
export async function learnerLoginAction(_prev: ActionResult<string> | null, formData: FormData): Promise<ActionResult<string>> {
  return runAction(async () => {
    const parsed = learnerLoginSchema.safeParse(formToObject(formData));
    if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Enter your email and password.");

    const meta = await getRequestMeta();
    if (await throttled("exam", parsed.data.email, meta.ipAddress, () => burnExamLoginWork(parsed.data.password))) {
      throw new ValidationError(LEARNER_LOGIN_ERRORS.invalid_credentials);
    }
    const outcome = await authenticateLearner(parsed.data.email, parsed.data.password, meta);
    if (!outcome.ok && outcome.reason === "invalid_credentials") recordLoginFailure("exam", parsed.data.email, meta.ipAddress);
    if (!outcome.ok) {
      if (outcome.reason === "account_disabled") throw new ForbiddenError(LEARNER_LOGIN_ERRORS.account_disabled);
      if (outcome.reason === "not_yet_valid" && outcome.validFrom) {
        throw new ValidationError(`${LEARNER_LOGIN_ERRORS.not_yet_valid} It works from ${formatDateTime(outcome.validFrom)} IST.`);
      }
      throw new ValidationError(LEARNER_LOGIN_ERRORS[outcome.reason]);
    }
    recordLoginSuccess("exam", parsed.data.email, meta.ipAddress);

    await setSessionCookie(outcome.token, outcome.expiresAt);
    const landing = await getLearnerLandingPath(outcome.user);
    if (landing !== LEARNER_DASHBOARD) return landing;
    const next = resolvePostLoginPath(Role.LEARNER, parsed.data.next);
    return next.startsWith(LEARNER_LOGIN_PATH) ? LEARNER_DASHBOARD : next;
  });
}

/** Revoke the current session, clear the cookie and return to the sign-in page (learners: /learner/login). */
export async function logoutAction() {
  const token = await readSessionToken();
  let learner = false;
  if (token) {
    const user = await getCurrentUser();
    learner = user?.role === Role.LEARNER;
    await invalidateSession(token);
    if (user) {
      await recordAudit({
        actorId: user.id,
        action: AuditAction.LOGOUT,
        entityType: "User",
        entityId: user.id,
        ipAddress: (await getRequestMeta()).ipAddress,
      });
    }
  }
  await clearSessionCookie();
  redirect(learner ? LEARNER_LOGIN_PATH : "/login");
}
