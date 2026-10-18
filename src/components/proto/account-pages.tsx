"use client";

import { LifeBuoy, Mail } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuthUser } from "@/components/auth/session-provider";
import { initials } from "@/prototype/lib/format";
import type { Role } from "@/prototype/types";
import { ROLE_LABEL } from "./app-shell";
import { DetailList, PageHeader, Panel } from "./page";

/** The signed-in account (read-only: names, roles and passwords are managed by an administrator). */
export function ProfilePage({ role }: { role: Role }) {
  const user = useAuthUser();
  return (
    <>
      <PageHeader title="Profile" description="Your account details." />
      <div className="grid max-w-3xl gap-6">
        <Panel>
          <div className="flex items-center gap-4">
            <Avatar size="lg">
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold">{user.name}</p>
              <p className="text-sm text-muted-foreground">
                {ROLE_LABEL[role]} · {user.email}
              </p>
            </div>
          </div>
        </Panel>
        <Panel title="Account">
          <DetailList
            items={[
              ["Full name", user.name],
              ["Email", user.email],
              ["Role", ROLE_LABEL[role]],
            ]}
          />
          <p className="mt-4 text-sm text-muted-foreground">
            {role === "learner"
              ? "You sign in with your email and your learner password, for all your assessments. Contact your administrator if your details are wrong or you need a new password."
              : "To change your name or email, or to get a password reset link, contact an administrator."}
          </p>
        </Panel>
      </div>
    </>
  );
}

export function HelpPage() {
  return (
    <>
      <PageHeader title="Help & Support" description="Contact options for the assessment operations team." />
      <Panel className="max-w-xl" title="Contact support">
        <ul className="grid gap-2 text-sm">
          <li className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" /> support@example.com
          </li>
          <li className="flex items-center gap-2">
            <LifeBuoy className="size-4 text-muted-foreground" /> Mon–Sat, 9:00 AM – 7:00 PM IST
          </li>
        </ul>
      </Panel>
    </>
  );
}
