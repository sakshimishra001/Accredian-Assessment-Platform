import type { Metadata } from "next";
import Link from "next/link";
import { StatusPage } from "@/components/shared/status-page";
import { buttonVariants } from "@/components/ui/button";
import { getHomePath } from "@/lib/auth/rbac";
import { getCurrentUser } from "@/server/auth/current-user";

export const metadata: Metadata = { title: "Access denied" };

/** Where requireRole() sends a signed-in user who lacks the role for an area. */
export default async function ForbiddenPage() {
  const user = await getCurrentUser();
  return (
    <StatusPage code="403" title="Access denied" description="Your account does not have permission to view that page.">
      <Link href={user ? getHomePath(user.role) : "/login"} className={buttonVariants()}>
        {user ? "Go to my dashboard" : "Sign in"}
      </Link>
    </StatusPage>
  );
}
