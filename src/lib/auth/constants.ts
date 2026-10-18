/**
 * Name of the httpOnly cookie that carries the opaque session token. In production it has the
 * `__Host-` prefix: browsers then only accept it when it is Secure, Path=/ and has no Domain, so a
 * sibling subdomain or a plain-http response can't plant or overwrite it. Development (plain http)
 * keeps an unprefixed name, because some browsers refuse Secure cookies on http://localhost.
 */
export const SESSION_COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-aap_session" : "aap_session";

/** User-facing login failures. Unknown email and wrong password deliberately share one message. */
export const LOGIN_ERRORS = {
  // Also the response while sign-in is paused (throttled), so a lockout reveals nothing.
  invalid_credentials: "Incorrect email or password. After several failed attempts, sign-in is paused for a few minutes.",
  account_disabled: "Your account has been disabled. Please contact an administrator.",
} as const;

/**
 * Learner sign-in failures (email + the learner's password). The specific reasons after "incorrect"
 * only come from the legacy exam-password path, and only once a correct exam password was supplied.
 */
export const LEARNER_LOGIN_ERRORS = {
  invalid_credentials: "Incorrect email or password. After several failed attempts, sign-in is paused for a few minutes.",
  account_disabled: LOGIN_ERRORS.account_disabled,
  not_yet_valid: "This exam password isn’t active yet.",
  expired: "This exam password has expired. Please contact your administrator for your learner password.",
  assessment_unavailable: "This assessment isn’t open right now. Please contact your administrator.",
} as const;

/** Where learners sign in (staff use /login). */
export const LEARNER_LOGIN_PATH = "/learner/login";

/**
 * Legacy learner exam sign-in failures. Anything short of a correct email + exam password gets the
 * generic message; the specific reasons are only shown to someone who supplied a valid code.
 */
export const EXAM_LOGIN_ERRORS = {
  invalid_credentials: "Incorrect email or exam password. After several failed attempts, sign-in is paused for a few minutes.",
  account_disabled: LOGIN_ERRORS.account_disabled,
  not_yet_valid: "This exam password isn’t active yet.",
  expired: "This exam password has expired. Please contact your administrator.",
  assessment_unavailable: "This assessment isn’t open right now. Please contact your administrator.",
} as const;
