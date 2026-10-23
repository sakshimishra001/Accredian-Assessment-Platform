import { redirect } from "next/navigation";

/** The proctor portal moved to /proctor. */
export default function ReviewerHelp() {
  redirect("/proctor/help");
}
