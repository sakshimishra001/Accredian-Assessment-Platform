import "server-only";
import { env } from "../env";

/*
 * Email provider abstraction: the communication service hands an EmailMessage to whichever
 * provider is configured and records the outcome the provider reports. No vendor is wired in
 * yet — a real one (SES, SendGrid, Resend, SMTP…) is another implementation of this interface.
 *
 *   outbox (default) — sends nothing; each email is recorded as NOT_DELIVERED.
 *   test             — the same, and keeps the messages in memory for tests to inspect.
 */

export interface EmailMessage {
  to: string;
  from: { name: string; email: string };
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
}

export type DeliveryOutcome = { status: "SENT"; messageId: string } | { status: "FAILED"; error: string } | { status: "NOT_DELIVERED"; reason: string };

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<DeliveryOutcome>;
}

const NO_SERVICE = "No email service is configured; the email was recorded but not sent.";

/** Records nothing externally and sends nothing. */
export class OutboxEmailProvider implements EmailProvider {
  readonly name = "outbox";
  async send(): Promise<DeliveryOutcome> {
    return { status: "NOT_DELIVERED", reason: NO_SERVICE };
  }
}

/** For tests: never sends; keeps every message so tests can assert on content and count. */
export class TestEmailProvider implements EmailProvider {
  readonly name = "test";
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<DeliveryOutcome> {
    this.messages.push(message);
    return { status: "NOT_DELIVERED", reason: NO_SERVICE };
  }
}

let provider: EmailProvider | undefined;

/** The configured email provider (EMAIL_PROVIDER), created once per process. */
export function emailProvider(): EmailProvider {
  provider ??= env().EMAIL_PROVIDER === "test" ? new TestEmailProvider() : new OutboxEmailProvider();
  return provider;
}
