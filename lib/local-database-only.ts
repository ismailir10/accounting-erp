/**
 * Side-effect import for tooling that wipes, reseeds or tests a database. Import it after "dotenv/config" and before anything that
 * imports lib/db: lib/db builds its client when it is first imported, so a check inside main() runs after a client for the hosted URL
 * already exists. Refuses unless every database variable that is set is localhost (lib/db-url.ts); it imports nothing that connects.
 */
import path from "node:path";
import { assertLoopbackDatabase } from "./db-url";

assertLoopbackDatabase(process.env, process.env.VITEST ? "DB tests" : path.relative(process.cwd(), process.argv[1] ?? "") || "This command");
