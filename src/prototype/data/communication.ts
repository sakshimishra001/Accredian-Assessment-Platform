import { at } from "../lib/random";
import type { CommHistoryEntry, CommTemplate } from "../types";

const SENDER = { fromName: "Accredian Assessments", fromEmail: "assessments@example.com", replyTo: "support@example.com" };

export const commTemplates: CommTemplate[] = [
  {
    id: "t-assignment",
    name: "Exam Assignment",
    type: "Assessment",
    trigger: "Assessment assigned",
    subject: "Your assessment {{assessment_name}} has been assigned",
    body: `Hello {{learner_name}},

You have been assigned the following assessment:

- **Assessment:** {{assessment_name}}
- **Course:** {{course_name}}
- **Batch:** {{batch_name}}
- **Date:** {{assessment_start_date}}
- **Time:** {{assessment_start_time}} – {{assessment_end_time}} IST
- **Duration:** {{assessment_duration}}

[Start Assessment]({{assessment_link}})

Please complete the assessment within the scheduled window. If you have questions, write to {{support_email}}.

Regards,
{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-6, 15, 20),
  },
  {
    id: "t-details",
    name: "Exam Details",
    type: "Assessment",
    trigger: "Assessment published",
    subject: "Details for {{assessment_name}}",
    body: `Hello {{learner_name}},

Here are the details for **{{assessment_name}}**:

- Opens: {{assessment_start_date}}, {{assessment_start_time}} IST
- Closes: {{assessment_end_date}}, {{assessment_end_time}} IST
- Duration: {{assessment_duration}}

Make sure you have a stable internet connection before you start.

[View Assessment]({{assessment_link}})

Regards,
{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-20, 11, 5),
  },
  {
    id: "t-reminder",
    name: "Exam Reminder",
    type: "Reminder",
    trigger: "Scheduled reminder",
    subject: "Reminder: {{assessment_name}} starts on {{assessment_start_date}}",
    body: `Hello {{learner_name}},

This is a reminder that **{{assessment_name}}** starts on {{assessment_start_date}} at {{assessment_start_time}} IST.

- Duration: {{assessment_duration}}
- Window closes: {{assessment_end_date}}, {{assessment_end_time}} IST

[Open Assessment]({{assessment_link}})

Good luck!
{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-9, 10, 0),
  },
  {
    id: "t-starting-soon",
    name: "Exam Starting Soon",
    type: "Reminder",
    trigger: "Before assessment start",
    subject: "{{assessment_name}} starts in 1 hour",
    body: `Hello {{learner_name}},

**{{assessment_name}}** starts at {{assessment_start_time}} IST — in about an hour.

[Open Assessment]({{assessment_link}})

{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-30, 16, 45),
  },
  {
    id: "t-rescheduled",
    name: "Exam Rescheduled",
    type: "Assessment Update",
    trigger: "Assessment schedule changed",
    subject: "Updated schedule: {{assessment_name}}",
    body: `Hello {{learner_name}},

The schedule for **{{assessment_name}}** has changed.

- New date: {{assessment_start_date}}
- New time: {{assessment_start_time}} – {{assessment_end_time}} IST

We apologise for any inconvenience. Contact {{support_email}} if you have questions.

{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-41, 12, 30),
  },
  {
    id: "t-cancelled",
    name: "Exam Cancelled",
    type: "Assessment Update",
    trigger: "Assessment cancelled",
    subject: "{{assessment_name}} has been cancelled",
    body: `Hello {{learner_name}},

**{{assessment_name}}**, scheduled for {{assessment_start_date}}, has been cancelled. You don’t need to take any action. We will share a new date soon.

{{company_name}} Assessments`,
    status: "Draft",
    ...SENDER,
    updatedAt: at(-3, 18, 10),
  },
  {
    id: "t-result",
    name: "Result Published",
    type: "Results",
    trigger: "Results released",
    subject: "Your result for {{assessment_name}} is available",
    body: `Hello {{learner_name}},

Your result for **{{assessment_name}}** has been published.

[View Result]({{assessment_link}})

Regards,
{{company_name}} Assessments`,
    status: "Active",
    ...SENDER,
    updatedAt: at(-14, 9, 40),
  },
  {
    id: "t-evaluation",
    name: "Evaluation Completed",
    type: "Results",
    trigger: "Evaluation completed",
    subject: "Evaluation completed for {{assessment_name}}",
    body: `Hello {{learner_name}},

Evaluation for **{{assessment_name}}** is complete. Results will be published shortly.

{{company_name}} Assessments`,
    status: "Disabled",
    ...SENDER,
    updatedAt: at(-60, 14, 0),
  },
];

export const commHistory: CommHistoryEntry[] = [
  { id: "h1", date: at(0, 9, 5), templateId: "t-assignment", communication: "Exam Assignment", assessmentId: "a-ds01-final", assessmentName: "Data Science – Final Assessment", batchName: "DS-01", recipients: 238, status: "Scheduled", subject: "Your assessment Data Science – Final Assessment has been assigned" },
  { id: "h2", date: at(5, 10, 0), templateId: "t-reminder", communication: "Exam Reminder", assessmentId: "a-ds01-final", assessmentName: "Data Science – Final Assessment", batchName: "DS-01", recipients: 238, status: "Scheduled", subject: "Reminder: Data Science – Final Assessment starts soon" },
  { id: "h3", date: at(-1, 16, 30), templateId: "t-result", communication: "Result Published", assessmentId: "a-pm01-quiz2", assessmentName: "Product Management – Quiz 2", batchName: "PM-01", recipients: 176, status: "Sent", subject: "Your result for Product Management – Quiz 2 is available" },
  { id: "h4", date: at(-2, 11, 0), templateId: "t-assignment", communication: "Exam Assignment", assessmentId: "a-pm01-mt1", assessmentName: "Product Management – Mid Term 1", batchName: "PM-01", recipients: 186, status: "Sent", subject: "Your assessment Product Management – Mid Term 1 has been assigned" },
  { id: "h5", date: at(1, 10, 0), templateId: "t-reminder", communication: "Exam Reminder", assessmentId: "a-pm01-mt1", assessmentName: "Product Management – Mid Term 1", batchName: "PM-01", recipients: 186, status: "Scheduled", subject: "Reminder: Product Management – Mid Term 1 starts tomorrow" },
  { id: "h6", date: at(-4, 9, 0), templateId: "t-assignment", communication: "Exam Assignment", assessmentId: "a-spm01-mt", assessmentName: "Strategic Project Management – Mid Term", batchName: "SPM-01", recipients: 142, status: "Sent", subject: "Your assessment Strategic Project Management – Mid Term has been assigned" },
  { id: "h7", date: at(-4, 9, 2), templateId: "t-assignment", communication: "Exam Assignment", assessmentId: "a-spm01-mt", assessmentName: "Strategic Project Management – Mid Term", batchName: "SPM-01", recipients: 3, status: "Failed", subject: "Your assessment Strategic Project Management – Mid Term has been assigned" },
  { id: "h8", date: at(0, 7, 55), templateId: "t-starting-soon", communication: "Exam Starting Soon", assessmentId: "a-gai01-mt", assessmentName: "Generative AI – Mid Term", batchName: "GAI-01", recipients: 162, status: "Sent", subject: "Generative AI – Mid Term starts in 1 hour" },
  { id: "h9", date: at(0, 12, 0), templateId: "t-rescheduled", communication: "Exam Rescheduled", assessmentId: "a-gai01-case", assessmentName: "Generative AI – RAG Design Case", batchName: "GAI-01", recipients: 162, status: "Draft", subject: "Updated schedule: Generative AI – RAG Design Case" },
];
