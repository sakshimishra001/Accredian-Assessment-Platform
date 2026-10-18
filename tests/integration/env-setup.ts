import { getTestDatabaseUrl } from "./test-database";

// Point the app's db client at the test database before any app module is imported.
process.env.DATABASE_URL = getTestDatabaseUrl();
// Files stay in memory and emails are captured, never sent.
process.env.STORAGE_DRIVER = "memory";
process.env.EMAIL_PROVIDER = "test";
// Uploads go through the deterministic test scanner (EICAR test signature = infected).
process.env.MALWARE_SCANNER = "test";
// Tests set X-Forwarded-For themselves to act as different clients.
process.env.TRUST_PROXY = "true";
