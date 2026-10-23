import { redirect } from "next/navigation";

/** The proctor portal moved to /proctor. */
export default function ReviewerProfile() {
  redirect("/proctor/profile");
}
