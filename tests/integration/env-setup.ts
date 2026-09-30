import { getTestDatabaseUrl } from "./test-database";

// Point the app's db client at the test database before any app module is imported.
process.env.DATABASE_URL = getTestDatabaseUrl();
