import type { Metadata } from "next";
import { DetailList, PageHeader, Panel } from "@/components/proto/page";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Settings" };

const EMAIL: Record<string, string> = { outbox: "Outbox only — emails are recorded in Communication History, not sent", test: "Test (in memory)" };
const STORAGE: Record<string, string> = { local: "Local disk on the server", memory: "In memory (tests)" };
const SCANNER: Record<string, string> = { none: "None — uploads are recorded as not scanned", test: "Test scanner" };

/**
 * The platform's effective configuration, read-only. These values come from the server's
 * environment (see .env.example) and are changed by whoever operates the deployment, not here.
 */
export default async function SettingsPage() {
  await requireRole(Role.ADMIN);
  const e = env();
  return (
    <>
      <PageHeader title="Settings" description="How this deployment is configured. Values are set in the server environment by its operator." />
      <div className="grid max-w-3xl gap-6">
        <Panel title="Sign-in & sessions">
          <DetailList
            className="grid-cols-[14rem_1fr]"
            items={[
              ["Staff session idle timeout", `${e.STAFF_SESSION_IDLE_MINUTES} minutes`],
              ["Staff session maximum length", `${e.STAFF_SESSION_MAX_HOURS} hours`],
              ["Learner session idle timeout", `${e.LEARNER_SESSION_IDLE_MINUTES} minutes`],
              ["Learner session maximum length", `${e.LEARNER_SESSION_MAX_HOURS} hours`],
              ["Results access after publication", `${e.RESULTS_ACCESS_DAYS} days (legacy exam passwords then expire)`],
              ["Staff passwords", "Set by each person through a one-time link; at least 12 characters"],
            ]}
          />
        </Panel>
        <Panel title="Services">
          <DetailList
            className="grid-cols-[14rem_1fr]"
            items={[
              ["Public address", e.APP_URL],
              ["Email delivery", EMAIL[e.EMAIL_PROVIDER]],
              ["File storage", STORAGE[e.STORAGE_DRIVER]],
              ["Malware scanning", SCANNER[e.MALWARE_SCANNER]],
              ["Proctoring", "Not available in this release"],
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
