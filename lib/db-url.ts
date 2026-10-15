/**
 * Database-URL rules. No env reads of its own and nothing that connects, so tests and guards can check them with fictional values.
 * The host check follows node-postgres, the driver behind PrismaPg: pg-connection-string is the parser pg itself requires
 * (pg/lib/connection-parameters.js), so a `?host=` override or an empty host falling back to PGHOST is judged as the driver would dial it.
 */
import { parse } from "pg-connection-string";

type Env = Record<string, string | undefined>;

/** Every variable that can point Buku at a database (scripts/vercel-build.sh reads the last two for migrations and seeds). */
export const DATABASE_URL_VARS = ["POSTGRES_PRISMA_URL", "POSTGRES_URL", "DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"] as const;

/** The URL createPrisma connects to: the Supabase ↔ Vercel integration's pooled URL wins over a stale DATABASE_URL; empty counts as unset. */
export function databaseUrl(env: Env): string | undefined {
  return env.POSTGRES_PRISMA_URL || env.POSTGRES_URL || env.DATABASE_URL;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Query parameters that move the connection elsewhere in pg, libpq or Prisma's engines. Refused outright rather than modelled. */
const HOST_PARAMS = new Set(["host", "hostaddr", "service", "servicefile", "socket"]);

/** The host node-postgres would dial: the string's host (a `?host=` wins), else PGHOST, else localhost. Undefined if unparseable. */
export function driverHost(url: string, env: Env = {}): string | undefined {
  try {
    return parse(url).host || env.PGHOST || "localhost";
  } catch {
    return undefined;
  }
}

/**
 * True only for a postgres URL that every parser reads as this machine: no host-moving query parameter, and both the WHATWG hostname
 * and the driver's host are a loopback name. Sockets, host lists, other schemes and strings that are not URLs are refused.
 */
export function isLoopbackDatabaseUrl(url: string, env: Env = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return false;
  if ([...parsed.searchParams.keys()].some((key) => HOST_PARAMS.has(key.toLowerCase()))) return false;
  const host = driverHost(url, env);
  return LOOPBACK.has(parsed.hostname || "localhost") && host !== undefined && LOOPBACK.has(host);
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The variables that would send this process's database or Auth writes off this machine, or that it does not model (PGSERVICE).
 * Names only, never values.
 */
export function nonLocalTargets(env: Env): string[] {
  const out: string[] = DATABASE_URL_VARS.filter((name) => env[name] && !isLoopbackDatabaseUrl(env[name]!, env));
  for (const name of ["PGHOST", "PGHOSTADDR"]) if (env[name] && !LOOPBACK.has(env[name]!)) out.push(name);
  for (const name of ["PGSERVICE", "PGSERVICEFILE"]) if (env[name]) out.push(name);
  if (env.NEXT_PUBLIC_SUPABASE_URL && !isLoopbackHttpUrl(env.NEXT_PUBLIC_SUPABASE_URL)) out.push("NEXT_PUBLIC_SUPABASE_URL");
  return out;
}

/**
 * Throws unless the database createPrisma would use, every other database variable that is set, and the Auth URL are on this machine.
 * Destructive tooling calls it before anything connects (lib/local-database-only.ts). The message names variables, never their values.
 */
export function assertLoopbackDatabase(env: Env, purpose: string): void {
  if (!databaseUrl(env)) throw new Error(`${purpose}: no database URL is set.`);
  const remote = nonLocalTargets(env);
  if (remote.length) throw new Error(`${purpose} refused: only a localhost database and Auth are allowed; not localhost or not supported: ${remote.join(", ")}.`);
}
