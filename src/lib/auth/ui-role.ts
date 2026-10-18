import type { Role } from "@/generated/prisma/enums";
import type { Role as UiRole } from "@/prototype/types";

/** Database role → the lower-case role key the UI (navigation, labels, areas) uses. */
export const UI_ROLE: Record<Role, UiRole> = {
  ADMIN: "admin",
  EXAMINER: "examiner",
  REVIEWER: "reviewer",
  LEARNER: "learner",
};

/** The only user fields sent to the browser. */
export interface AuthUser {
  name: string;
  email: string;
  role: UiRole;
}
