// Question content pools per course, used to build realistic mock question papers.

export interface McqSpec {
  text: string;
  options: string[];
  correct: number[];
}

export interface Pool {
  subject: string;
  mcq: McqSpec[];
  multi: McqSpec[];
  trueFalse: { text: string; answer: boolean }[];
  short: string[];
  long: string[];
  caseStudy: { title: string; passage: string; parts: string[] };
  comprehension: { passage: string; parts: McqSpec[] };
}

const m = (text: string, options: string[], ...correct: number[]): McqSpec => ({ text, options, correct });

export const POOLS: Record<string, Pool> = {
  "c-pm": {
    subject: "Product Strategy",
    mcq: [
      m("Which framework prioritises features by Reach, Impact, Confidence and Effort?", ["MoSCoW", "RICE", "Kano", "HEART"], 1),
      m("A product's North Star Metric should primarily reflect:", ["Revenue this quarter", "The core value customers receive", "Number of features shipped", "Team velocity"], 1),
      m("What is the main purpose of a Minimum Viable Product?", ["Launch with every planned feature", "Validate key assumptions with minimum effort", "Replace user research", "Maximise first-month revenue"], 1),
      m("In the Kano model, features that users expect and notice only when absent are:", ["Delighters", "Performance attributes", "Basic (must-be) attributes", "Indifferent attributes"], 2),
      m("Which metric best measures product stickiness?", ["DAU / MAU", "Customer acquisition cost", "Gross margin", "Net promoter score"], 0),
      m("A product roadmap is best described as:", ["A fixed list of release dates", "A strategic communication of direction and priorities", "A sprint backlog", "A technical architecture diagram"], 1),
      m("Jobs-to-be-Done focuses on:", ["Demographic segments", "The progress a customer is trying to make", "Competitor feature lists", "Internal KPIs"], 1),
      m("Which experiment design compares two variants on a single change?", ["Cohort analysis", "A/B test", "Card sorting", "Conjoint analysis"], 1),
      m("Product-market fit is most commonly signalled by:", ["High marketing spend", "Strong retention and organic demand", "A large feature set", "Positive press coverage"], 1),
      m("The primary output of a discovery sprint is:", ["Production code", "Validated learning about a problem", "A pricing sheet", "A hiring plan"], 1),
      m("Which pricing strategy sets price based on value perceived by customers?", ["Cost-plus", "Value-based", "Penetration", "Skimming"], 1),
      m("OKRs consist of:", ["Objectives and Key Results", "Outputs and KPIs", "Opportunities and Risks", "Owners and Resources"], 0),
      m("A persona in product management represents:", ["A single real customer", "An archetype of a target user segment", "A sales territory", "A marketing campaign"], 1),
      m("Technical debt is best managed by:", ["Ignoring it until a rewrite", "Making it visible and prioritising it alongside features", "Only fixing it during outages", "Outsourcing it"], 1),
      m("Which is a leading indicator for a subscription product?", ["Annual revenue", "Trial-to-activation rate", "Last year's churn", "Total funding raised"], 1),
    ],
    multi: [
      m("Select all qualitative research methods.", ["User interviews", "A/B testing", "Contextual inquiry", "Funnel analysis", "Diary studies"], 0, 2, 4),
      m("Which of the following are prioritisation frameworks?", ["RICE", "MoSCoW", "SWOT", "Kano", "PESTLE"], 0, 1, 3),
      m("Select the components of a good problem statement.", ["Who is affected", "The proposed solution", "The impact of the problem", "Evidence the problem exists"], 0, 2, 3),
      m("Which metrics belong to the AARRR (pirate) funnel?", ["Acquisition", "Activation", "Amortisation", "Retention", "Referral"], 0, 1, 3, 4),
      m("Select stakeholders a PM typically aligns with before launch.", ["Engineering", "Sales", "Customer support", "External auditors"], 0, 1, 2),
      m("Which are valid ways to reduce churn?", ["Improve onboarding", "Increase price without notice", "Proactive customer success outreach", "Fix top reported pain points"], 0, 2, 3),
      m("Select artefacts commonly produced in product discovery.", ["Opportunity solution tree", "Assumption map", "Payroll report", "Prototype"], 0, 1, 3),
      m("Which are characteristics of a good user story?", ["Independent", "Negotiable", "Vague", "Testable"], 0, 1, 3),
    ],
    trueFalse: [
      { text: "A product manager is directly responsible for writing production code.", answer: false },
      { text: "Retention is generally a stronger signal of product-market fit than acquisition.", answer: true },
      { text: "A roadmap should never change once it has been published.", answer: false },
      { text: "Qualitative research can uncover the 'why' behind quantitative trends.", answer: true },
      { text: "Vanity metrics are the best basis for product decisions.", answer: false },
      { text: "An MVP should test the riskiest assumption first.", answer: true },
    ],
    short: [
      "Define a North Star Metric and give one example for an EdTech platform.",
      "What is the difference between output and outcome in product management?",
      "Explain the purpose of a product requirements document (PRD).",
      "List two ways to validate a problem before building a solution.",
      "What is feature creep and how can it be prevented?",
      "Explain the difference between a leading and a lagging indicator.",
      "What is a go-to-market strategy?",
      "Describe one limitation of the RICE framework.",
    ],
    long: [
      "Design a product strategy for launching a mobile learning app for working professionals in Tier-2 Indian cities. Cover target users, value proposition, MVP scope and success metrics.",
      "Your product's weekly active users have dropped 18% over two months. Describe how you would investigate the cause and decide what to do.",
      "Compare three prioritisation frameworks and recommend one for an early-stage B2B SaaS team, justifying your choice.",
      "Explain how you would run a discovery process for a new feature requested by your largest customer.",
      "Describe how you would define and track success for an AI-powered assessment feature.",
    ],
    caseStudy: {
      title: "UpSkill India — subscription stagnation",
      passage:
        "UpSkill India is an online learning platform offering certificate programmes to working professionals. After strong growth in its first two years, monthly subscriptions have plateaued at around 42,000. Customer interviews reveal that learners find courses valuable but struggle to complete them alongside work. Completion rates sit at 23%, and 61% of cancellations happen in the first 45 days. Leadership wants a plan to restart growth within two quarters without significantly increasing marketing spend.",
      parts: [
        "Identify the core problem UpSkill India should solve first, and justify your choice using the data in the case.",
        "Propose two product initiatives to address the problem and explain how you would prioritise between them.",
        "Define the metrics you would use to measure the success of your chosen initiative over the next two quarters.",
      ],
    },
    comprehension: {
      passage:
        "A product team at a fintech start-up ran a four-week A/B test on a redesigned onboarding flow. Variant B reduced the number of onboarding screens from seven to four. Activation (completing the first transaction within 7 days) rose from 31% in the control group to 36% in Variant B. Support tickets per 1,000 new users fell from 48 to 35. However, fraud flags increased slightly, from 0.8% to 1.1%.",
      parts: [
        m("What was the relative increase in activation for Variant B?", ["5%", "About 16%", "36%", "About 31%"], 1),
        m("Which result is a potential risk the team should investigate before full rollout?", ["Lower support tickets", "Higher activation", "Higher fraud flags", "Fewer onboarding screens"], 2),
        m("What is the most appropriate next step?", ["Roll out immediately to all users", "Investigate fraud impact, then roll out with monitoring", "Revert to the control", "Add three more screens"], 1),
      ],
    },
  },
  "c-spm": {
    subject: "Project Governance",
    mcq: [
      m("The critical path in a project schedule is:", ["The shortest sequence of tasks", "The longest sequence of dependent tasks", "The most expensive tasks", "Tasks owned by the sponsor"], 1),
      m("Earned Value (EV) represents:", ["Budgeted cost of work performed", "Actual cost incurred", "Planned value to date", "Total project budget"], 0),
      m("A RACI matrix is used to define:", ["Risk probability", "Roles and responsibilities", "Resource costs", "Quality standards"], 1),
      m("Which document formally authorises a project?", ["Project charter", "Risk register", "Lessons learned log", "Status report"], 0),
      m("A CPI of 0.8 indicates the project is:", ["Under budget", "Over budget", "Ahead of schedule", "Behind schedule"], 1),
      m("Scope creep is best controlled through:", ["Integrated change control", "Adding more resources", "Ignoring minor requests", "Extending the deadline"], 0),
      m("Which is a qualitative risk analysis tool?", ["Monte Carlo simulation", "Probability–impact matrix", "Decision tree with EMV", "Sensitivity analysis"], 1),
      m("The primary purpose of a stage gate is to:", ["Celebrate milestones", "Decide whether to continue, change or stop", "Assign new team members", "Close contracts"], 1),
    ],
    multi: [
      m("Select the triple constraint elements.", ["Scope", "Time", "Cost", "Morale"], 0, 1, 2),
      m("Which are valid risk response strategies for threats?", ["Avoid", "Transfer", "Mitigate", "Exploit"], 0, 1, 2),
      m("Select agile ceremonies.", ["Sprint planning", "Daily stand-up", "Gantt review", "Retrospective"], 0, 1, 3),
      m("Which belong in a project charter?", ["Objectives", "High-level risks", "Detailed test cases", "Sponsor"], 0, 1, 3),
    ],
    trueFalse: [
      { text: "A project has a defined start and end.", answer: true },
      { text: "Stakeholder engagement is only needed at project initiation.", answer: false },
      { text: "Float on the critical path is zero.", answer: true },
      { text: "A risk register is created once and never updated.", answer: false },
    ],
    short: [
      "Differentiate between a programme and a portfolio.",
      "What is a work breakdown structure (WBS)?",
      "Explain schedule variance with an example.",
      "What is the role of a project sponsor?",
      "Define 'benefits realisation'.",
    ],
    long: [
      "A government digitisation project in Maharashtra is 3 months behind schedule and 20% over budget. As the new programme manager, describe your recovery plan.",
      "Compare predictive and agile delivery approaches and recommend one for a hospital ERP rollout.",
      "Explain how you would build a governance framework for a multi-vendor infrastructure programme.",
    ],
    caseStudy: {
      title: "Metro Rail Phase II — delayed commissioning",
      passage:
        "The Phase II extension of a city metro network was planned for commissioning in 30 months with a budget of ₹4,200 crore. At month 22, civil works are 68% complete, signalling integration has not started, and two contractors have raised claims for design changes. The state government has announced the inauguration date publicly. The steering committee has asked for an independent assessment and a recovery recommendation.",
      parts: [
        "Assess the current project health using the information provided.",
        "Identify the top three risks to the commissioning date and propose responses for each.",
        "Recommend how the steering committee should communicate with the state government.",
        "Propose governance changes to prevent similar issues in Phase III.",
        "Outline a revised high-level schedule with key milestones.",
      ],
    },
    comprehension: {
      passage:
        "A software project has a Planned Value of ₹50 lakh, Earned Value of ₹40 lakh and Actual Cost of ₹45 lakh at the end of month six.",
      parts: [
        m("What is the Schedule Variance?", ["₹10 lakh", "−₹10 lakh", "−₹5 lakh", "₹5 lakh"], 1),
        m("What is the Cost Performance Index?", ["0.89", "1.13", "0.80", "1.25"], 0),
        m("What does this indicate?", ["Ahead and under budget", "Behind and over budget", "Ahead and over budget", "Behind and under budget"], 1),
      ],
    },
  },
  "c-ds": {
    subject: "Applied Statistics & ML",
    mcq: [
      m("Which measure of central tendency is least affected by outliers?", ["Mean", "Median", "Range", "Standard deviation"], 1),
      m("Overfitting typically shows as:", ["High training and test error", "Low training error, high test error", "High training error, low test error", "Equal errors"], 1),
      m("Which algorithm is used for classification?", ["Linear regression", "Logistic regression", "K-means", "PCA"], 1),
      m("A p-value of 0.03 at α = 0.05 means:", ["Fail to reject H0", "Reject H0", "Accept H1 with certainty", "The test is invalid"], 1),
      m("Which metric is most suitable for imbalanced classification?", ["Accuracy", "F1 score", "R²", "MAE"], 1),
      m("Cross-validation is used to:", ["Speed up training", "Estimate generalisation performance", "Remove outliers", "Encode categories"], 1),
      m("Which SQL clause filters grouped results?", ["WHERE", "HAVING", "ORDER BY", "LIMIT"], 1),
      m("Regularisation primarily helps to:", ["Increase variance", "Reduce overfitting", "Increase features", "Improve data quality"], 1),
    ],
    multi: [
      m("Select supervised learning algorithms.", ["Random forest", "K-means", "SVM", "Linear regression"], 0, 2, 3),
      m("Which are valid ways to handle missing data?", ["Imputation", "Dropping rows", "Ignoring the column in all cases", "Model-based estimation"], 0, 1, 3),
      m("Select dimensionality reduction techniques.", ["PCA", "t-SNE", "Gradient boosting", "UMAP"], 0, 1, 3),
      m("Which are classification metrics?", ["Precision", "Recall", "RMSE", "ROC-AUC"], 0, 1, 3),
    ],
    trueFalse: [
      { text: "Correlation implies causation.", answer: false },
      { text: "Standardisation rescales features to zero mean and unit variance.", answer: true },
      { text: "A larger training set always removes bias.", answer: false },
      { text: "K-means requires the number of clusters to be specified.", answer: true },
    ],
    short: [
      "Explain the bias–variance trade-off.",
      "What is the difference between bagging and boosting?",
      "Define precision and recall.",
      "What is a confusion matrix?",
      "Explain what a p-value represents.",
    ],
    long: [
      "Describe an end-to-end approach to predicting customer churn for a telecom operator, from data collection to deployment.",
      "Explain how you would evaluate and compare three models for credit-risk scoring.",
      "Discuss ethical risks in deploying ML models for loan approvals in India and how to mitigate them.",
    ],
    caseStudy: {
      title: "QuickCart — delivery-time prediction",
      passage:
        "QuickCart, a grocery delivery start-up in Bengaluru, wants to predict delivery times to improve customer trust. It has 14 months of order data including store location, distance, time of day, weather, rider ID and actual delivery time. Current estimates are off by an average of 11 minutes.",
      parts: [
        "Frame this as a machine learning problem and choose an evaluation metric.",
        "Identify three features you would engineer and why.",
        "Describe how you would validate the model before launch.",
        "Explain how you would monitor the model after deployment.",
        "Discuss one fairness concern relevant to riders.",
      ],
    },
    comprehension: {
      passage:
        "A classifier for detecting fraudulent transactions produced 90 true positives, 10 false negatives, 30 false positives and 870 true negatives on a test set of 1,000 transactions.",
      parts: [
        m("What is the recall?", ["0.75", "0.90", "0.97", "0.87"], 1),
        m("What is the precision?", ["0.75", "0.90", "0.97", "0.30"], 0),
        m("What is the accuracy?", ["0.90", "0.96", "0.87", "0.75"], 1),
      ],
    },
  },
  "c-gai": {
    subject: "Prompt Engineering",
    mcq: [
      m("Few-shot prompting means:", ["Giving the model no examples", "Including a few worked examples in the prompt", "Fine-tuning on a small dataset", "Limiting output length"], 1),
      m("Retrieval-augmented generation (RAG) primarily helps to:", ["Speed up inference", "Ground answers in external knowledge", "Reduce model size", "Remove the need for prompts"], 1),
      m("A 'hallucination' in LLMs refers to:", ["Slow responses", "Confident but incorrect or fabricated output", "Refusing to answer", "Formatting errors"], 1),
      m("Temperature controls:", ["Response length", "Randomness of sampling", "Context window size", "Training speed"], 1),
      m("Which technique asks a model to reason step by step?", ["Chain-of-thought prompting", "Tokenisation", "Quantisation", "Distillation"], 0),
      m("Embeddings are best described as:", ["Compressed model weights", "Numeric vectors representing meaning", "Prompt templates", "Output filters"], 1),
    ],
    multi: [
      m("Select practices that reduce hallucinations.", ["Grounding with retrieved sources", "Asking for citations", "Raising temperature", "Constraining output format"], 0, 1, 3),
      m("Which are risks when deploying LLMs in enterprises?", ["Data leakage", "Prompt injection", "Deterministic outputs", "Bias"], 0, 1, 3),
      m("Select components of a RAG pipeline.", ["Chunking", "Vector store", "Retriever", "Payroll engine"], 0, 1, 2),
    ],
    trueFalse: [
      { text: "LLMs always return the same answer for the same prompt.", answer: false },
      { text: "System prompts can set behaviour and constraints for a model.", answer: true },
      { text: "Fine-tuning is always required to adapt an LLM to a task.", answer: false },
    ],
    short: ["Explain prompt injection with an example.", "What is a context window?", "Differentiate fine-tuning and RAG.", "Why evaluate LLM outputs with human reviewers?"],
    long: [
      "Design a GenAI assistant for an Indian bank's customer support team. Cover use cases, guardrails and evaluation.",
      "Discuss how you would measure the quality of an LLM-based summarisation feature.",
    ],
    caseStudy: {
      title: "LegalEase — contract summaries",
      passage:
        "LegalEase wants to use an LLM to summarise commercial contracts for SME clients. Early pilots show fast summaries but occasional missing clauses and invented dates.",
      parts: ["Identify the main risks.", "Propose a mitigation architecture.", "Define evaluation criteria.", "Recommend a rollout plan.", "Describe human-in-the-loop controls."],
    },
    comprehension: {
      passage: "An LLM application answers HR policy questions using a RAG pipeline over 400 policy documents. Users report outdated answers about leave policy.",
      parts: [
        m("The most likely cause is:", ["Model too small", "Stale documents in the index", "Low temperature", "Short prompts"], 1),
        m("The best fix is:", ["Re-index updated documents regularly", "Increase temperature", "Remove retrieval", "Use a longer system prompt"], 0),
        m("Which metric tracks this issue?", ["Latency", "Answer freshness / accuracy vs source", "Token count", "GPU usage"], 1),
      ],
    },
  },
  "c-ail": {
    subject: "AI Strategy",
    mcq: [
      m("An AI strategy should begin with:", ["Choosing a model vendor", "Business problems and value", "Hiring data scientists", "Buying GPUs"], 1),
      m("Which is a responsible-AI principle?", ["Opacity", "Fairness", "Maximum automation", "Speed over safety"], 1),
      m("Build vs buy decisions depend most on:", ["Brand preference", "Strategic differentiation and capability", "Office location", "Team size only"], 1),
      m("A proof of concept primarily tests:", ["Feasibility", "Final ROI", "Regulatory approval", "Brand awareness"], 0),
      m("Model drift means:", ["Model weights are deleted", "Performance degrades as data changes", "Model runs faster", "Model is retrained daily"], 1),
    ],
    multi: [
      m("Select elements of AI governance.", ["Model inventory", "Risk assessment", "Ad-hoc approvals", "Monitoring"], 0, 1, 3),
      m("Which are common barriers to AI adoption?", ["Data quality", "Change management", "Too much budget", "Skills gaps"], 0, 1, 3),
    ],
    trueFalse: [
      { text: "AI initiatives need executive sponsorship to scale.", answer: true },
      { text: "Every business process should be automated with AI.", answer: false },
    ],
    short: ["What is an AI centre of excellence?", "Define model governance.", "What is the ROI of an AI pilot?", "Explain 'human in the loop'."],
    long: ["Develop a two-year AI roadmap for a mid-sized Indian insurance company.", "Discuss the leadership role in managing AI-driven workforce change."],
    caseStudy: {
      title: "RetailCo — scaling AI pilots",
      passage: "RetailCo has run 14 AI pilots in two years; only two reached production. Leadership wants to understand why and how to scale.",
      parts: ["Diagnose why pilots stall.", "Propose an operating model.", "Define success metrics.", "Recommend governance.", "Outline a talent plan."],
    },
    comprehension: {
      passage: "A bank's AI loan-screening model approved 12% fewer applications from women with comparable credit profiles.",
      parts: [
        m("This indicates a potential:", ["Latency issue", "Fairness issue", "Cost issue", "UI issue"], 1),
        m("First response should be:", ["Ignore it", "Audit data and model for bias", "Launch more widely", "Remove monitoring"], 1),
        m("Who should own the decision?", ["Only the data team", "A cross-functional governance group", "The vendor", "Marketing"], 1),
      ],
    },
  },
};
