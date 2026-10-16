// Slashbin patch (EM#629): protected Cases. Company policy lives in Cases, and
// upstream lets any company member write any Case. This module decides who may
// write a protected Case; routes/cases.ts calls it before every Case write.
//
// Which Cases are protected is fixed here, not in config: every Case whose type
// is in PROTECTED_CASE_TYPES, plus Case ids the config names. Removing the config
// therefore never unprotects anything; it leaves protected Cases with no editors.
//
// Editors come only from the server env PAPERCLIP_PROTECTED_CASES, outside every
// API, screen and document, so nobody can grant themselves edit rights:
//
//   {
//     "types": { "company-policy": { "users": ["<userId>"], "agents": ["<agentId>"] } },
//     "cases": { "<caseId>": { "users": [], "agents": ["<agentId>"] } }
//   }
//
// A "cases" entry replaces the type's editors for that Case. A user is an editor
// only through a signed-in session; board API keys act as their minting user, so
// they are refused even for a listed user. Config that is set but invalid refuses
// every Case write (503) until it is fixed; reads are never gated here.
import type { Request } from "express";
import { HttpError, conflict, forbidden, unprocessable } from "../errors.js";

export const PROTECTED_CASE_TYPES: readonly string[] = ["company-policy"];
export const PROTECTED_CASES_ENV = "PAPERCLIP_PROTECTED_CASES";

type Editors = { users: string[]; agents: string[] };
type ProtectionConfig = { types: Record<string, Editors>; cases: Record<string, Editors> };

export type CaseProtection =
  | { status: "ok"; config: ProtectionConfig }
  | { status: "invalid"; error: string };

type CaseLike = { id: string; caseType: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEditors(where: string, value: unknown): Editors {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object with users and agents`);
  }
  const extra = Object.keys(value).filter((k) => k !== "users" && k !== "agents");
  if (extra.length > 0) throw new Error(`${where} has unknown keys: ${extra.join(", ")}`);
  const out: Editors = { users: [], agents: [] };
  for (const kind of ["users", "agents"] as const) {
    const list = (value as Record<string, unknown>)[kind] ?? [];
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new Error(`${where}.${kind} must be an array of ids`);
    }
    if (kind === "agents" && list.some((id) => !UUID.test(id))) {
      throw new Error(`${where}.agents must be agent UUIDs`);
    }
    out[kind] = list as string[];
  }
  return out;
}

export function parseCaseProtection(raw: string | undefined): CaseProtection {
  const empty: ProtectionConfig = { types: {}, cases: {} };
  if (raw === undefined || raw.trim() === "") return { status: "ok", config: empty };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    const extra = Object.keys(parsed).filter((k) => k !== "types" && k !== "cases");
    if (extra.length > 0) throw new Error(`unknown keys: ${extra.join(", ")}`);
    const config: ProtectionConfig = { types: {}, cases: {} };
    const { types = {}, cases = {} } = parsed as Record<string, unknown>;
    if (!types || typeof types !== "object" || Array.isArray(types)) throw new Error("types must be an object");
    if (!cases || typeof cases !== "object" || Array.isArray(cases)) throw new Error("cases must be an object");
    for (const [type, editors] of Object.entries(types)) {
      // Config supplies editors for a protected type; it cannot add or remove a type.
      if (!PROTECTED_CASE_TYPES.includes(type)) throw new Error(`types.${type} is not a protected case type`);
      config.types[type] = parseEditors(`types.${type}`, editors);
    }
    for (const [caseId, editors] of Object.entries(cases)) {
      if (!UUID.test(caseId)) throw new Error(`cases key ${caseId} is not a case UUID`);
      config.cases[caseId.toLowerCase()] = parseEditors(`cases.${caseId}`, editors);
    }
    return { status: "ok", config };
  } catch (err) {
    return { status: "invalid", error: `${PROTECTED_CASES_ENV}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function isProtectedCase(protection: CaseProtection, row: CaseLike) {
  if (PROTECTED_CASE_TYPES.includes(row.caseType)) return true;
  return protection.status === "ok" && Object.hasOwn(protection.config.cases, row.id.toLowerCase());
}

function editorsFor(protection: CaseProtection, row: CaseLike): Editors | null {
  if (protection.status !== "ok") return null;
  return protection.config.cases[row.id.toLowerCase()] ?? protection.config.types[row.caseType] ?? null;
}

function isEditor(req: Request, editors: Editors | null) {
  if (!editors) return false;
  const actor = req.actor;
  if (actor.type === "board") {
    // Only a signed-in session counts. Board keys, local_implicit and tenant
    // tokens all authenticate as a user without that user being present.
    return actor.source === "session" && typeof actor.userId === "string" && editors.users.includes(actor.userId);
  }
  if (actor.type === "agent") {
    // A narrowed key (task_bridge, skill_test, comment_only) never edits policy.
    return (actor.source === "agent_key" || actor.source === "agent_jwt")
      && (!actor.keyScope || actor.keyScope.kind === "standard")
      && typeof actor.agentId === "string"
      && editors.agents.includes(actor.agentId);
  }
  return false;
}

/** Refuses every Case write while the config is invalid. Call before any Case write. */
export function assertCaseProtectionAvailable(protection: CaseProtection) {
  if (protection.status === "invalid") {
    throw new HttpError(503, "Case protection config is invalid; case writes are refused", {
      code: "case_protection_unavailable",
    });
  }
}

/** Refuses a write to `row` unless the caller is one of its configured editors. */
export function assertCaseWritable(protection: CaseProtection, req: Request, row: CaseLike) {
  assertCaseProtectionAvailable(protection);
  if (!isProtectedCase(protection, row)) return;
  if (!isEditor(req, editorsFor(protection, row))) {
    throw forbidden("Case is protected; only its configured editors may change it", {
      code: "case_protected",
      caseId: row.id,
    });
  }
}

/** Protected documents keep their history: nobody deletes them through the app. */
export function assertDocumentDeletable(protection: CaseProtection, row: CaseLike) {
  assertCaseProtectionAvailable(protection);
  if (isProtectedCase(protection, row)) {
    throw forbidden("Documents of a protected case cannot be deleted", { code: "case_protected", caseId: row.id });
  }
}

/** A protected document revision records why it was made. */
export function assertChangeSummary(protection: CaseProtection, row: CaseLike, changeSummary: string | null | undefined) {
  if (isProtectedCase(protection, row) && !changeSummary?.trim()) {
    throw unprocessable("A protected case document change requires changeSummary", { code: "change_summary_required" });
  }
}

/** A restore on a protected document must name the revision it replaces. */
export function assertRestoreBase(
  protection: CaseProtection,
  row: CaseLike,
  baseRevisionId: unknown,
  latest: { latestRevisionId: string | null; latestRevisionNumber: number },
) {
  if (!isProtectedCase(protection, row)) return;
  if (baseRevisionId !== latest.latestRevisionId) {
    throw conflict(
      baseRevisionId ? "Case document was updated by someone else" : "Protected case document restore requires baseRevisionId",
      {
        code: "stale_base_revision",
        latestRevisionId: latest.latestRevisionId,
        latestRevisionNumber: latest.latestRevisionNumber,
      },
    );
  }
}
