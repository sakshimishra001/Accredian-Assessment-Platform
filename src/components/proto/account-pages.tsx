"use client";

import { useState } from "react";
import { BookOpen, LifeBuoy, Mail, MessageSquare } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { initials } from "@/prototype/lib/format";
import { DEMO_USERS, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Role } from "@/prototype/types";
import { ROLE_LABEL } from "./app-shell";
import { Field, SelectField } from "./controls";
import { PageHeader, Panel } from "./page";

export function ProfilePage({ role }: { role: Role }) {
  const { session } = useProto();
  const { signIn } = useProtoActions();
  const toast = useToast();
  const user = session ?? DEMO_USERS[role];
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState("+91 98765 43210");
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
        <Panel title="Personal details">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full name" htmlFor="pn">
              <Input id="pn" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="pe" hint="Managed by your administrator">
              <Input id="pe" value={user.email} disabled />
            </Field>
            <Field label="Phone" htmlFor="pp">
              <Input id="pp" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Role">
              <Input value={ROLE_LABEL[role]} disabled />
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              disabled={name.trim().length < 2}
              onClick={() => {
                signIn({ ...user, name: name.trim() });
                toast.success("Profile updated");
              }}
            >
              Save profile
            </Button>
            <Button variant="outline" onClick={() => toast.info("Prototype mode", "Passwords are not used in this prototype.")}>
              Change password
            </Button>
          </div>
        </Panel>
      </div>
    </>
  );
}

export function HelpPage() {
  const toast = useToast();
  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const articles = [
    "Importing a question paper from Excel",
    "Setting section attempt rules (any N, best N)",
    "Creating and scheduling an assessment",
    "Assigning examiners to subjective answers",
    "Publishing results to learners",
  ];
  return (
    <>
      <PageHeader title="Help & Support" description="Guides and contact options for the assessment operations team." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel title="Popular guides">
          <ul className="divide-y">
            {articles.map((a) => (
              <li key={a}>
                <button type="button" onClick={() => toast.comingSoon("The help centre")} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:text-primary">
                  <BookOpen className="size-4 text-muted-foreground" /> {a}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="grid content-start gap-6">
          <Panel title="Contact support">
            <div className="grid gap-3">
              <Field label="Topic" htmlFor="ht">
                <SelectField id="ht" value={topic} onChange={setTopic} placeholder="Choose a topic" options={["Question papers", "Assessments", "Learners & batches", "Results", "Other"].map((x) => ({ value: x, label: x }))} />
              </Field>
              <Field label="Message" htmlFor="hm" error={error}>
                <Textarea id="hm" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
              <Button
                onClick={() => {
                  if (!topic || message.trim().length < 10) {
                    setError("Choose a topic and describe the issue (at least 10 characters).");
                    return;
                  }
                  setError(null);
                  setTopic("");
                  setMessage("");
                  toast.success("Request submitted", "Ticket #AP-2041 created (simulated). The team replies within one working day.");
                }}
              >
                <MessageSquare /> Submit request
              </Button>
            </div>
          </Panel>
          <Panel>
            <ul className="grid gap-2 text-sm">
              <li className="flex items-center gap-2">
                <Mail className="size-4 text-muted-foreground" /> support@example.com
              </li>
              <li className="flex items-center gap-2">
                <LifeBuoy className="size-4 text-muted-foreground" /> Mon–Sat, 9:00 AM – 7:00 PM IST
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
