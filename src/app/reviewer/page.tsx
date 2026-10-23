import { redirect } from "next/navigation";

/** The proctor portal moved to /proctor. */
export default function ReviewerHome() {
  redirect("/proctor");
}
