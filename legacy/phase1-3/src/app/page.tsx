import { redirect } from "next/navigation";
import { getHomePath } from "@/lib/auth/rbac";
import { getCurrentUser } from "@/server/auth/current-user";

export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? getHomePath(user.role) : "/login");
}
