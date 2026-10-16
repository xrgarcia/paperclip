// Slashbin patch (EM#629): protected Cases. Company policy lives in Cases, and
// upstream lets any company member write any Case. This module decides who may
// write a protected Case; routes/cases.ts calls it before every Case write, and the
// task, label and project delete routes call it for the Cases a delete would unlink.
//
// Which Cases are protected is fixed here, not in config: every Case whose type
// is in PROTECTED_CASE_TYPES, plus Case ids the config names. Removing the config
// never unprotects a Case of a protected type; it leaves it with no editors. A
// Case protected only by its id in config is ordinary again without it.
//
// Editors come only from the server env PAPERCLIP_PROTECTED_CASES, outside every
// API, screen and document, so nobody can grant themselves edit rights:
//
//   {
//     "types": { "company-policy": { "users": ["<userId>"], "agentKeys": ["<agentApiKeyId>"] } },
//     "cases": { "<caseId>": { "users": [], "agentKeys": ["<agentApiKeyId>"] } }
//   }
//
// A "cases" entry replaces the type's editors for that Case. A user is an editor
// only through a signed-in session; board API keys act as their minting user, so
// they are refused even for a listed user. An agent is an editor only through one
// named standard API key, never by its agent id: a board key that may manage the
// agent can mint it a fresh key, or rewrite its adapter and collect a run JWT, and
// neither credential is on the list. Config that is set but invalid refuses
// every Case write (503) until it is fixed; reads are never gated here.
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { caseIssueLinks, caseLabels, cases, type Db } from "@paperclipai/db";
import { HttpError, conflict, forbidden, unprocessable } from "../errors.js";

export const PROTECTED_CASE_TYPES: readonly string[] = ["company-policy"];
export const PROTECTED_CASES_ENV = "PAPERCLIP_PROTECTED_CASES";

type Editors = { users: string[]; agentKeys: string[] };
type ProtectionConfig = { types: Record<string, Editors>; cases: Record<string, Editors> };

export type CaseProtection =
  | { status: "ok"; config: ProtectionConfig }
  | { status: "invalid"; error: string };

type CaseLike = { id: string; caseType: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEditors(where: string, value: unknown): Editors {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object with users and agentKeys`);
  }
  const extra = Object.keys(value).filter((k) => k !== "users" && k !== "agentKeys");
  if (extra.length > 0) throw new Error(`${where} has unknown keys: ${extra.join(", ")}`);
  const out: Editors = { users: [], agentKeys: [] };
  for (const kind of ["users", "agentKeys"] as const) {
    const list = (value as Record<string, unknown>)[kind] ?? [];
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new Error(`${where}.${kind} must be an array of ids`);
    }
    if (kind === "agentKeys" && list.some((id) => !UUID.test(id))) {
      throw new Error(`${where}.agentKeys must be agent API key UUIDs`);
    }
    out[kind] = kind === "agentKeys" ? (list as string[]).map((id) => id.toLowerCase()) : (list as string[]);
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
    // Only a listed standard API key. Run JWTs are refused: the server mints one
    // for whatever process the agent's adapter runs. A narrowed key (task_bridge,
    // skill_test, comment_only) never edits policy.
    return actor.source === "agent_key"
      && (!actor.keyScope || actor.keyScope.kind === "standard")
      && typeof actor.keyId === "string"
      && editors.agentKeys.includes(actor.keyId.toLowerCase());
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

/**
 * Protected Cases take no attachments, editors included: policy lives in
 * revisioned documents, and an attachment's asset can be deleted from outside
 * this router (a company logo swap deletes the asset it replaces), which would
 * remove the attachment with no Case write at all.
 */
export function assertAttachmentAllowed(protection: CaseProtection, row: CaseLike) {
  assertCaseProtectionAvailable(protection);
  if (isProtectedCase(protection, row)) {
    throw forbidden("Protected cases take no attachments; put policy in a document", { code: "case_protected", caseId: row.id });
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

/** Reads PAPERCLIP_PROTECTED_CASES; routers call it once, at boot, like routes/cases.ts. */
export function loadCaseProtection(): CaseProtection {
  return parseCaseProtection(process.env[PROTECTED_CASES_ENV]);
}

/**
 * Deleting a task, label or project removes its link to every Case that holds it
 * (ON DELETE CASCADE / SET NULL), with no Case route involved. Where one of those
 * Cases is protected, the delete is a change to the policy container and needs
 * that Case's editor.
 */
export async function assertDeleteKeepsProtectedCases(
  db: Db,
  protection: CaseProtection,
  req: Request,
  target: { issueId: string } | { labelId: string } | { projectId: string },
) {
  const caseCols = { id: cases.id, caseType: cases.caseType };
  const held = "issueId" in target
    ? await db.select(caseCols).from(caseIssueLinks)
      .innerJoin(cases, eq(caseIssueLinks.caseId, cases.id))
      .where(eq(caseIssueLinks.issueId, target.issueId))
    : "labelId" in target
      ? await db.select(caseCols).from(caseLabels)
        .innerJoin(cases, eq(caseLabels.caseId, cases.id))
        .where(eq(caseLabels.labelId, target.labelId))
      : await db.select(caseCols).from(cases).where(eq(cases.projectId, target.projectId));
  for (const row of held) assertCaseWritable(protection, req, row);
}
