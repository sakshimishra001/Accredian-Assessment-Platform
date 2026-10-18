import { redirect } from "next/navigation";

/** The entry point is the sign-in page (which sends a signed-in user on to their area). */
export default function Home() {
  redirect("/login");
}
