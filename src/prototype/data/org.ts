import { at, seeded } from "../lib/random";
import type { Batch, Course, Examiner, Learner, PlatformUser } from "../types";

export const courses: Course[] = [
  { id: "c-pm", name: "Product Management", code: "PM" },
  { id: "c-spm", name: "Strategic Project Management", code: "SPM" },
  { id: "c-ds", name: "Data Science", code: "DS" },
  { id: "c-gai", name: "Generative AI", code: "GAI" },
  { id: "c-ail", name: "AI for Leaders", code: "AIL" },
];

const BATCH_SPECS: { id: string; code: string; courseId: string; start: number; status: Batch["status"]; size: number }[] = [
  { id: "b-pm01", code: "PM-01", courseId: "c-pm", start: -120, status: "Active", size: 186 },
  { id: "b-pm02", code: "PM-02", courseId: "c-pm", start: -45, status: "Active", size: 204 },
  { id: "b-spm01", code: "SPM-01", courseId: "c-spm", start: -90, status: "Active", size: 142 },
  { id: "b-ds01", code: "DS-01", courseId: "c-ds", start: -200, status: "Active", size: 238 },
  { id: "b-ds02", code: "DS-02", courseId: "c-ds", start: 12, status: "Upcoming", size: 176 },
  { id: "b-gai01", code: "GAI-01", courseId: "c-gai", start: -30, status: "Active", size: 162 },
  { id: "b-ail01", code: "AIL-01", courseId: "c-ail", start: -300, status: "Completed", size: 140 },
];

const FIRST = [
  "Aarav", "Ananya", "Vihaan", "Diya", "Arjun", "Isha", "Kabir", "Meera", "Rohan", "Sanya", "Aditya", "Kavya",
  "Rahul", "Priya", "Nikhil", "Sneha", "Karan", "Pooja", "Siddharth", "Neha", "Varun", "Aditi", "Harsh", "Riya",
  "Manish", "Tanvi", "Yash", "Shreya", "Akash", "Nandini", "Deepak", "Ritika", "Gaurav", "Swati", "Abhishek", "Lavanya",
];
const LAST = [
  "Sharma", "Iyer", "Reddy", "Nair", "Gupta", "Menon", "Patel", "Kulkarni", "Singh", "Rao", "Desai", "Bose",
  "Joshi", "Chatterjee", "Pillai", "Verma", "Mehta", "Banerjee", "Kapoor", "Agarwal", "Shetty", "Mishra", "Das", "Srinivasan",
];

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

function buildLearners(): { learners: Learner[]; batches: Batch[] } {
  const learners: Learner[] = [];
  const batches: Batch[] = [];
  for (const spec of BATCH_SPECS) {
    const rand = seeded(spec.id);
    const ids: string[] = [];
    for (let i = 0; i < spec.size; i++) {
      const first = FIRST[Math.floor(rand() * FIRST.length)];
      const last = LAST[Math.floor(rand() * LAST.length)];
      const id = `${spec.id}-l${i + 1}`;
      const roll = rand();
      learners.push({
        id,
        name: `${first} ${last}`,
        email: `${first}.${last}${i + 1}@learner.example.com`.toLowerCase(),
        batchId: spec.id,
        status: spec.status === "Upcoming" ? (roll < 0.7 ? "Invited" : "Active") : roll < 0.04 ? "Inactive" : "Active",
      });
      ids.push(id);
    }
    const course = courses.find((c) => c.id === spec.courseId)!;
    batches.push({
      id: spec.id,
      label: spec.code,
      name: `${course.name} — ${MONTH.format(new Date(at(spec.start, 9)))} — Batch ${spec.code.split("-")[1]}`,
      courseId: spec.courseId,
      createdAt: at(spec.start - 14, 11),
      startDate: at(spec.start, 9),
      status: spec.status,
      learnerIds: ids,
    });
  }
  // The demo learner account sits in PM-01.
  learners[0] = { ...learners[0], name: "Aarav Sharma", email: "learner@example.com", status: "Active" };
  return { learners, batches };
}

const built = buildLearners();
export const learners = built.learners;
export const batches = built.batches;

export const examiners: Examiner[] = [
  { id: "e-priya", name: "Dr. Priya Nair", email: "examiner@example.com", specialization: "Product Management", status: "Active" },
  { id: "e-rahul", name: "Rahul Menon", email: "rahul.menon@example.com", specialization: "Product Strategy", status: "Active" },
  { id: "e-kavita", name: "Dr. Kavita Rao", email: "kavita.rao@example.com", specialization: "Project Management", status: "Active" },
  { id: "e-sameer", name: "Sameer Kulkarni", email: "sameer.kulkarni@example.com", specialization: "Data Science", status: "Active" },
  { id: "e-anjali", name: "Dr. Anjali Iyer", email: "anjali.iyer@example.com", specialization: "Machine Learning", status: "Active" },
  { id: "e-vikram", name: "Vikram Desai", email: "vikram.desai@example.com", specialization: "Generative AI", status: "Invited" },
  { id: "e-meenakshi", name: "Meenakshi Pillai", email: "meenakshi.pillai@example.com", specialization: "Leadership & Strategy", status: "Active" },
  { id: "e-arvind", name: "Arvind Joshi", email: "arvind.joshi@example.com", specialization: "Statistics", status: "Inactive" },
];

export const platformUsers: PlatformUser[] = [
  { id: "u-admin", name: "Neha Kapoor", email: "admin@example.com", role: "Administrator", status: "Active", lastActive: at(0, 9, 12) },
  { id: "u-ops", name: "Rohit Agarwal", email: "rohit.agarwal@example.com", role: "Administrator", status: "Active", lastActive: at(-1, 17, 40) },
  { id: "u-acad", name: "Sunita Banerjee", email: "sunita.banerjee@example.com", role: "Administrator", status: "Invited", lastActive: "" },
  ...examiners.map<PlatformUser>((e, i) => ({
    id: `u-${e.id}`,
    name: e.name,
    email: e.email,
    role: "Examiner",
    status: e.status === "Inactive" ? "Suspended" : e.status,
    lastActive: e.status === "Invited" ? "" : at(-(i % 4), 11 + i, 5),
  })),
  { id: "u-doc1", name: "Dr. Ramesh Srinivasan", email: "doctor@example.com", role: "Doctor / Reviewer", status: "Active", lastActive: at(-2, 15, 20) },
  { id: "u-doc2", name: "Dr. Farah Siddiqui", email: "farah.siddiqui@example.com", role: "Doctor / Reviewer", status: "Active", lastActive: at(-5, 10, 0) },
  { id: "u-doc3", name: "Dr. Mohan Shetty", email: "mohan.shetty@example.com", role: "Doctor / Reviewer", status: "Invited", lastActive: "" },
];
