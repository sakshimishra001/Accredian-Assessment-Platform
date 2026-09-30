"use client";

// In-memory prototype state. Nothing is persisted: a browser refresh restores the mock data.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { activity, assessments, evaluations, notifications, results } from "./data/activity";
import { batches, courses, examiners, learners, platformUsers } from "./data/org";
import { commHistory, commTemplates } from "./data/communication";
import { questionPapers } from "./data/papers";
import type {
  AppNotification,
  Assessment,
  CommHistoryEntry,
  CommTemplate,
  Batch,
  Course,
  Evaluation,
  Examiner,
  Learner,
  PlatformUser,
  QuestionPaper,
  ResultRow,
  Role,
  SessionUser,
} from "./types";

export interface OrgSettings {
  organizationName: string;
  supportEmail: string;
  timezone: string;
  defaultDuration: number;
  defaultAttempts: number;
  defaultNegativeMarking: boolean;
  defaultNegativeMarks: number;
  defaultShowResults: boolean;
  notifyOnSchedule: boolean;
  reminderHours: number;
  notifyExaminers: boolean;
  weeklyDigest: boolean;
  sessionTimeoutMinutes: number;
  enforceStrongPasswords: boolean;
  twoFactorForAdmins: boolean;
  dateFormat: string;
  language: string;
}

export interface PrototypeState {
  session: SessionUser | null;
  courses: Course[];
  batches: Batch[];
  learners: Learner[];
  examiners: Examiner[];
  users: PlatformUser[];
  papers: QuestionPaper[];
  assessments: Assessment[];
  results: ResultRow[];
  evaluations: Evaluation[];
  notifications: AppNotification[];
  templates: CommTemplate[];
  commHistory: CommHistoryEntry[];
  settings: OrgSettings;
}

const initialState = (): PrototypeState => ({
  session: null,
  courses,
  batches,
  learners,
  examiners,
  users: platformUsers,
  papers: questionPapers,
  assessments,
  results,
  evaluations,
  notifications,
  templates: commTemplates,
  commHistory,
  settings: {
    organizationName: "Accredian Learning",
    supportEmail: "support@example.com",
    timezone: "Asia/Kolkata",
    defaultDuration: 90,
    defaultAttempts: 1,
    defaultNegativeMarking: false,
    defaultNegativeMarks: 0.25,
    defaultShowResults: false,
    notifyOnSchedule: true,
    reminderHours: 24,
    notifyExaminers: true,
    weeklyDigest: false,
    sessionTimeoutMinutes: 60,
    enforceStrongPasswords: true,
    twoFactorForAdmins: false,
    dateFormat: "DD MMM YYYY",
    language: "English (India)",
  },
});

export const DEMO_USERS: Record<Role, SessionUser> = {
  admin: { name: "Neha Kapoor", email: "admin@example.com", role: "admin" },
  examiner: { name: "Dr. Priya Nair", email: "examiner@example.com", role: "examiner" },
  reviewer: { name: "Dr. Ramesh Srinivasan", email: "doctor@example.com", role: "reviewer" },
  learner: { name: "Aarav Sharma", email: "learner@example.com", role: "learner" },
};

let counter = 0;
export function newId(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter}`;
}

function useActions(set: React.Dispatch<React.SetStateAction<PrototypeState>>) {
  return useMemo(() => {
    const patchList = <K extends keyof PrototypeState>(key: K, fn: (list: PrototypeState[K]) => PrototypeState[K]) =>
      set((s) => ({ ...s, [key]: fn(s[key]) }));

    return {
      signIn: (user: SessionUser) => set((s) => ({ ...s, session: user })),
      signOut: () => set((s) => ({ ...s, session: null })),

      saveAssessment: (a: Assessment) =>
        patchList("assessments", (list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list])),
      updateAssessment: (id: string, patch: Partial<Assessment>) =>
        patchList("assessments", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),

      savePaper: (p: QuestionPaper) =>
        patchList("papers", (list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [p, ...list])),
      updatePaper: (id: string, patch: Partial<QuestionPaper>) =>
        patchList("papers", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),

      addUser: (u: PlatformUser) => patchList("users", (list) => [u, ...list]),
      updateUser: (id: string, patch: Partial<PlatformUser>) => patchList("users", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),

      addExaminer: (e: Examiner) => patchList("examiners", (list) => [e, ...list]),
      updateExaminer: (id: string, patch: Partial<Examiner>) =>
        patchList("examiners", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),

      addBatch: (b: Batch, newLearners: Learner[]) =>
        set((s) => ({ ...s, batches: [b, ...s.batches], learners: [...s.learners, ...newLearners] })),
      addLearners: (batchId: string, newLearners: Learner[]) =>
        set((s) => ({
          ...s,
          learners: [...s.learners, ...newLearners],
          batches: s.batches.map((b) => (b.id === batchId ? { ...b, learnerIds: [...b.learnerIds, ...newLearners.map((l) => l.id)] } : b)),
        })),
      updateLearner: (id: string, patch: Partial<Learner>) => patchList("learners", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),

      updateEvaluation: (id: string, patch: Partial<Evaluation>) =>
        patchList("evaluations", (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x))),
      addEvaluations: (evs: Evaluation[]) => patchList("evaluations", (list) => [...list, ...evs]),

      markNotificationRead: (id: string) => patchList("notifications", (list) => list.map((n) => (n.id === id ? { ...n, read: true } : n))),
      markAllNotificationsRead: () => patchList("notifications", (list) => list.map((n) => ({ ...n, read: true }))),

      updateSettings: (patch: Partial<OrgSettings>) => set((s) => ({ ...s, settings: { ...s.settings, ...patch } })),

      saveTemplate: (t: CommTemplate) =>
        patchList("templates", (list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list])),
      updateTemplate: (id: string, patch: Partial<CommTemplate>) =>
        patchList("templates", (list) => list.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: new Date().toISOString() } : x))),
      addCommHistory: (entries: CommHistoryEntry[]) => patchList("commHistory", (list) => [...entries, ...list]),
    };
  }, [set]);
}

type Actions = ReturnType<typeof useActions>;

const StateContext = createContext<PrototypeState | null>(null);
const ActionsContext = createContext<Actions | null>(null);

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const actions = useActions(setState);
  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useProto() {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useProto must be used inside PrototypeProvider");
  return ctx;
}

export function useProtoActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useProtoActions must be used inside PrototypeProvider");
  return ctx;
}

/** Lookup helpers bound to current state. */
export function useLookups() {
  const s = useProto();
  const course = useCallback((id: string) => s.courses.find((c) => c.id === id), [s.courses]);
  const batch = useCallback((id: string) => s.batches.find((b) => b.id === id), [s.batches]);
  const paper = useCallback((id: string | null) => (id ? s.papers.find((p) => p.id === id) : undefined), [s.papers]);
  const learner = useCallback((id: string) => s.learners.find((l) => l.id === id), [s.learners]);
  const examiner = useCallback((id: string) => s.examiners.find((e) => e.id === id), [s.examiners]);
  const assessment = useCallback((id: string) => s.assessments.find((a) => a.id === id), [s.assessments]);
  return { course, batch, paper, learner, examiner, assessment };
}

export { activity };
