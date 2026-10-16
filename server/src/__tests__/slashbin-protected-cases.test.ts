// Slashbin patch (EM#629): only configured editors write a protected Case.
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  assets,
  caseAttachments,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  companies,
  companyLogos,
  createDb,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  documentRevisions,
  heartbeatRuns,
  instanceSettings,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { PROTECTED_CASES_ENV, parseCaseProtection } from "../slashbin/protected-cases.js";
import type { StorageService } from "../storage/types.js";

type Actor = Express.Request["actor"];

describe("parseCaseProtection", () => {
  it("treats unset config as protected cases with no editors", () => {
    expect(parseCaseProtection(undefined)).toEqual({ status: "ok", config: { types: {}, cases: {} } });
    expect(parseCaseProtection("  ")).toEqual({ status: "ok", config: { types: {}, cases: {} } });
  });

  it("refuses config that would add or drop a protected type, or is malformed", () => {
    for (const raw of [
      "{",
      "[]",
      JSON.stringify({ types: { bug: { users: [], agentKeys: [] } } }),
      JSON.stringify({ cases: { "SLA-C1": { users: [], agentKeys: [] } } }),
      JSON.stringify({ types: { "company-policy": { users: "ray", agentKeys: [] } } }),
      JSON.stringify({ types: { "company-policy": { users: [], agentKeys: ["not-a-uuid"] } } }),
      JSON.stringify({ types: { "company-policy": { users: [], agentKeys: [], admins: [] } } }),
      JSON.stringify({ editors: {} }),
      // Agents are named by API key id only; an agent id would admit every key it is ever issued.
      JSON.stringify({ types: { "company-policy": { users: [], agents: [randomUUID()] } } }),
    ]) {
      expect(parseCaseProtection(raw).status, raw).toBe("invalid");
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("protected cases routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousConfig = process.env[PROTECTED_CASES_ENV];

  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    },
    async getObject() {
      throw new Error("not used");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-protected-cases-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(caseAttachments);
    await db.delete(caseLabels);
    await db.delete(caseDocuments);
    await db.delete(caseIssueLinks);
    await db.delete(caseEvents);
    await db.delete(cases);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companyLogos);
    await db.delete(assets);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousConfig === undefined) delete process.env[PROTECTED_CASES_ENV];
    else process.env[PROTECTED_CASES_ENV] = previousConfig;
  });

  // The config is read when the router is built, as at server boot.
  function app(actor: Actor, config: string | undefined) {
    if (config === undefined) delete process.env[PROTECTED_CASES_ENV];
    else process.env[PROTECTED_CASES_ENV] = config;
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", caseRoutes(db, storage));
    instance.use(errorHandler);
    return request(instance);
  }

  const RAY = "ray-user-id";

  async function seed() {
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const [company] = await db.insert(companies).values({
      name: "Policy Co",
      issuePrefix: `POL${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    const mkAgent = async (name: string) => (await db.insert(agents).values({
      companyId: company!.id,
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning())[0]!;
    const po = await mkAgent("PO");
    const reader = await mkAgent("Reader");
    const poRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: poRunId, companyId: company!.id, agentId: po.id, status: "running" });
    const [policy] = await db.insert(cases).values({
      companyId: company!.id,
      caseNumber: 1,
      identifier: `${company!.issuePrefix}-C1`,
      caseType: "company-policy",
      key: "company-policies",
      title: "Company policies",
    }).returning();
    const [fixture] = await db.insert(cases).values({
      companyId: company!.id,
      caseNumber: 2,
      identifier: `${company!.issuePrefix}-C2`,
      caseType: "policy-gate-fixture",
      title: "Fixture",
    }).returning();
    const [plain] = await db.insert(cases).values({
      companyId: company!.id,
      caseNumber: 3,
      identifier: `${company!.issuePrefix}-C3`,
      caseType: "bug",
      title: "Ordinary",
    }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Task", status: "todo" }).returning();
    const poKeyId = randomUUID();
    const editors = { users: [RAY], agentKeys: [poKeyId] };
    const config = JSON.stringify({
      types: { "company-policy": editors },
      cases: { [fixture!.id]: editors },
    });
    const companyIds = [company!.id];
    const actors = {
      raySession: { type: "board", userId: RAY, source: "session", companyIds, isInstanceAdmin: true },
      rayBoardKey: { type: "board", userId: RAY, source: "board_key", keyId: "k", companyIds, isInstanceAdmin: true },
      adminSession: { type: "board", userId: "other-admin", source: "session", companyIds, isInstanceAdmin: true },
      localImplicit: { type: "board", userId: RAY, source: "local_implicit", isInstanceAdmin: true },
      poKey: {
        type: "agent", agentId: po.id, companyId: company!.id, source: "agent_key", keyId: poKeyId,
        keyScope: { kind: "standard" },
      },
      // What a board key can obtain for the PO: a freshly minted standard key, or a
      // run JWT from a heartbeat after rewriting the PO's adapter.
      poMintedKey: {
        type: "agent", agentId: po.id, companyId: company!.id, source: "agent_key", keyId: randomUUID(),
        keyScope: { kind: "standard" },
      },
      poJwt: { type: "agent", agentId: po.id, companyId: company!.id, source: "agent_jwt", runId: poRunId },
      poBridgeKey: {
        type: "agent", agentId: po.id, companyId: company!.id, source: "agent_key", keyId: poKeyId,
        keyScope: { kind: "task_bridge", projectId: randomUUID() },
      },
      reader: { type: "agent", agentId: reader.id, companyId: company!.id, source: "agent_key", keyScope: { kind: "standard" } },
    } satisfies Record<string, Actor>;
    // A document on each protected case, written by an editor.
    const docs: Record<string, { revisionId: string; firstRevisionId: string }> = {};
    for (const row of [policy!, fixture!]) {
      const http = app(actors.raySession, config);
      const r1 = await http.put(`/api/cases/${row.id}/documents/body`)
        .send({ body: "v1", changeSummary: "first" }).expect(200);
      const r2 = await http.put(`/api/cases/${row.id}/documents/body`)
        .send({ body: "v2", changeSummary: "second", baseRevisionId: r1.body.revision.id }).expect(200);
      docs[row.id] = { revisionId: r2.body.revision.id, firstRevisionId: r1.body.revision.id };
    }
    return { company: company!, po, reader, policy: policy!, fixture: fixture!, plain: plain!, issue: issue!, config, actors, docs };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  // A reader's proposal: an annotation thread on the latest "v2" body.
  function proposal(s: Seeded, caseId: string, body: string) {
    return {
      baseRevisionId: s.docs[caseId]!.revisionId,
      baseRevisionNumber: 2,
      selector: {
        quote: { exact: "v2", prefix: "", suffix: "" },
        position: { normalizedStart: 0, normalizedEnd: 2, markdownStart: 0, markdownEnd: 2 },
      },
      body,
    };
  }

  // Every write route in routes/cases.ts, against one case.
  function writes(s: Seeded, caseRow: { id: string; caseType: string; key?: string | null }) {
    const doc = s.docs[caseRow.id];
    return {
      "PATCH case": (h: ReturnType<typeof app>) => h.patch(`/api/cases/${caseRow.id}`).send({ title: "Hijacked" }),
      "PUT document": (h: ReturnType<typeof app>) => h.put(`/api/cases/${caseRow.id}/documents/body`)
        .send({ body: "hijacked", changeSummary: "x", baseRevisionId: doc?.revisionId }),
      "PUT new document": (h: ReturnType<typeof app>) => h.put(`/api/cases/${caseRow.id}/documents/extra`)
        .send({ body: "new", changeSummary: "x" }),
      "lock": (h: ReturnType<typeof app>) => h.post(`/api/cases/${caseRow.id}/documents/body/lock`),
      "unlock": (h: ReturnType<typeof app>) => h.post(`/api/cases/${caseRow.id}/documents/body/unlock`),
      "restore": (h: ReturnType<typeof app>) => h
        .post(`/api/cases/${caseRow.id}/documents/body/revisions/${doc?.firstRevisionId ?? randomUUID()}/restore`)
        .send({ baseRevisionId: doc?.revisionId }),
      "DELETE document": (h: ReturnType<typeof app>) => h.delete(`/api/cases/${caseRow.id}/documents/body`),
      "link issue": (h: ReturnType<typeof app>) => h.post(`/api/cases/${caseRow.id}/links`)
        .send({ issueId: s.issue.id, role: "work" }),
      "attach file": (h: ReturnType<typeof app>) => h.post(`/api/cases/${caseRow.id}/attachments`)
        .attach("file", Buffer.from("x"), "x.txt"),
      "create child": (h: ReturnType<typeof app>) => h.post(`/api/companies/${s.company.id}/cases`)
        .send({ caseType: "bug", title: "Child", parentCaseId: caseRow.id }),
      "upsert by type+key": (h: ReturnType<typeof app>) => h.post(`/api/companies/${s.company.id}/cases`)
        .send({ caseType: caseRow.caseType, key: caseRow.key ?? null, title: "Hijacked" }),
    };
  }

  async function snapshot(caseId: string) {
    const [row] = await db.select().from(cases).where(eq(cases.id, caseId));
    const links = await db.select().from(caseDocuments).where(eq(caseDocuments.caseId, caseId));
    const docRows = await Promise.all(links.map(async (l) => {
      const [d] = await db.select().from(documents).where(eq(documents.id, l.documentId));
      const revs = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, l.documentId));
      return { key: l.key, body: d!.latestBody, rev: d!.latestRevisionId, lockedAt: d!.lockedAt, revs: revs.length };
    }));
    const children = await db.select({ id: cases.id }).from(cases).where(eq(cases.parentCaseId, caseId));
    const issueLinks = await db.select().from(caseIssueLinks).where(eq(caseIssueLinks.caseId, caseId));
    const attachments = await db.select().from(caseAttachments).where(eq(caseAttachments.caseId, caseId));
    return {
      title: row!.title, status: row!.status, caseType: row!.caseType, key: row!.key,
      docs: docRows, children: children.length, links: issueLinks.length, attachments: attachments.length,
    };
  }

  it("refuses every write route to everyone but the editors, and changes nothing", async () => {
    const s = await seed();
    for (const target of [s.policy, s.fixture]) {
      const before = await snapshot(target.id);
      for (const name of ["rayBoardKey", "adminSession", "localImplicit", "poMintedKey", "poJwt", "poBridgeKey", "reader"] as const) {
        const http = app(s.actors[name], s.config);
        for (const [route, call] of Object.entries(writes(s, target))) {
          const res = await call(http);
          expect(res.status, `${name} ${route} on ${target.caseType}`).toBe(403);
          expect(res.body.details?.code, `${name} ${route}`).toBe("case_protected");
        }
      }
      expect(await snapshot(target.id)).toEqual(before);
    }
  });

  it("refuses creating a new policy case to a non-editor and allows an editor", async () => {
    const s = await seed();
    const body = { caseType: "company-policy", key: "second-policy", title: "Second" };
    await app(s.actors.reader, s.config).post(`/api/companies/${s.company.id}/cases`).send(body).expect(403);
    await app(s.actors.rayBoardKey, s.config).post(`/api/companies/${s.company.id}/cases`).send(body).expect(403);
    await app(s.actors.poKey, s.config).post(`/api/companies/${s.company.id}/cases`).send(body).expect(201);
  });

  it("lets Ray's session and the PO's listed key edit, with history kept", async () => {
    const s = await seed();
    for (const name of ["raySession", "poKey"] as const) {
      const http = app(s.actors[name], s.config);
      const current = await http.get(`/api/cases/${s.policy.id}/documents/body`).expect(200);
      const put = await http.put(`/api/cases/${s.policy.id}/documents/body`)
        .send({ body: `by ${name}`, changeSummary: `edit by ${name}`, baseRevisionId: current.body.latestRevisionId })
        .expect(200);
      expect(put.body.revision.revisionNumber).toBe(current.body.latestRevisionNumber + 1);
      expect(put.body.revision.changeSummary).toBe(`edit by ${name}`);
      expect(put.body.document.key).toBe("body");
      expect(put.body.document.body).toBe(`by ${name}`);
      await http.patch(`/api/cases/${s.policy.id}`).send({ summary: `touched by ${name}` }).expect(200);
      await http.post(`/api/cases/${s.policy.id}/documents/body/lock`).expect(200);
      await http.post(`/api/cases/${s.policy.id}/documents/body/unlock`).expect(200);
    }
    const revisions = await app(s.actors.reader, s.config).get(`/api/cases/${s.policy.id}/documents/body/revisions`).expect(200);
    const list = Array.isArray(revisions.body) ? revisions.body : revisions.body.revisions;
    expect(list).toHaveLength(4);
  });

  it("keeps a protected Case's attachment when its asset is swapped out as the company logo", async () => {
    const s = await seed();
    const mkAsset = async (name: string) => (await db.insert(assets).values({
      companyId: s.policy.companyId, provider: "local_disk", objectKey: `case/${name}`,
      contentType: "image/png", byteSize: 1, sha256: name,
    }).returning())[0]!;
    // An attachment that predates protection: the route no longer takes new ones.
    const held = await mkAsset("held");
    await db.insert(caseAttachments).values({ companyId: s.policy.companyId, caseId: s.policy.id, assetId: held.id });
    const companiesSvc = companyService(db);
    for (const next of [await mkAsset("replacement"), null]) {
      await companiesSvc.update(s.policy.companyId, { logoAssetId: held.id });
      await companiesSvc.update(s.policy.companyId, { logoAssetId: next?.id ?? null });
      expect(await db.select().from(assets).where(eq(assets.id, held.id))).toHaveLength(1);
      expect(await db.select().from(caseAttachments).where(eq(caseAttachments.assetId, held.id))).toHaveLength(1);
    }
  });

  it("needs the protected parent's editor to take a child out from under it", async () => {
    const s = await seed();
    const editor = app(s.actors.raySession, s.config);
    const child = await editor.post(`/api/companies/${s.policy.companyId}/cases`)
      .send({ caseType: "bug", key: "child", title: "Child", parentCaseId: s.policy.id })
      .expect(201);
    const childId = child.body.id as string;
    const intruder = app(s.actors.rayBoardKey, s.config);
    await intruder.patch(`/api/cases/${childId}`).send({ parentCaseId: null }).expect(403);
    await intruder.patch(`/api/cases/${childId}`).send({ parentCaseId: s.plain.id }).expect(403);
    await intruder.post(`/api/companies/${s.policy.companyId}/cases`)
      .send({ caseType: "bug", key: "child", title: "Child", parentCaseId: s.plain.id })
      .expect(403);
    const [row] = await db.select().from(cases).where(eq(cases.id, childId));
    expect(row!.parentCaseId).toBe(s.policy.id);
    // Edits that leave the parent alone stay open on the ordinary child.
    await intruder.patch(`/api/cases/${childId}`).send({ summary: "still mine" }).expect(200);
    // The editor can move it out.
    await editor.patch(`/api/cases/${childId}`).send({ parentCaseId: null }).expect(200);
  });

  it("needs a protected Case's editor to delete the task, label or project it holds", async () => {
    const s = await seed();
    const companyId = s.policy.companyId;
    const [task] = await db.insert(issues).values({ companyId, title: "Policy task", status: "todo" }).returning();
    await db.insert(caseIssueLinks).values({ companyId, caseId: s.policy.id, issueId: task!.id, role: "work" });
    const [label] = await db.insert(labels).values({ companyId, name: "policy", color: "#000000" }).returning();
    await db.insert(caseLabels).values({ companyId, caseId: s.policy.id, labelId: label!.id });
    const [loose] = await db.insert(labels).values({ companyId, name: "loose", color: "#ffffff" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Policy project" }).returning();
    await db.update(cases).set({ projectId: project!.id }).where(eq(cases.id, s.policy.id));

    // Built after the env is set, as at boot.
    const deleter = (actor: Actor) => {
      process.env[PROTECTED_CASES_ENV] = s.config;
      const instance = express();
      instance.use(express.json());
      instance.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      instance.use("/api", issueRoutes(db, storage));
      instance.use("/api", projectRoutes(db));
      instance.use(errorHandler);
      return request(instance);
    };
    const intruder = deleter(s.actors.rayBoardKey);
    for (const path of [`/api/issues/${task!.id}`, `/api/labels/${label!.id}`, `/api/projects/${project!.id}`]) {
      const res = await intruder.delete(path);
      expect(res.status, path).toBe(403);
      expect(res.body.details?.code ?? res.body.code, path).toBe("case_protected");
    }
    expect(await db.select().from(caseIssueLinks).where(eq(caseIssueLinks.issueId, task!.id))).toHaveLength(1);
    expect(await db.select().from(caseLabels).where(eq(caseLabels.labelId, label!.id))).toHaveLength(1);
    const [policy] = await db.select().from(cases).where(eq(cases.id, s.policy.id));
    expect(policy!.projectId).toBe(project!.id);
    // A label no protected Case holds is still anyone's to delete; the editor may delete the held one.
    await intruder.delete(`/api/labels/${loose!.id}`).expect(200);
    await deleter(s.actors.raySession).delete(`/api/labels/${label!.id}`).expect(200);
  });

  it("tells the Case page which Cases are protected", async () => {
    const s = await seed();
    const http = app(s.actors.reader, s.config);
    for (const [row, expected] of [[s.policy, true], [s.fixture, true], [s.plain, false]] as const) {
      const res = await http.get(`/api/cases/${row.id}`).expect(200);
      expect(res.body.protected, row.caseType).toBe(expected);
    }
    const patched = await app(s.actors.raySession, s.config).patch(`/api/cases/${s.policy.id}`).send({ summary: "s" }).expect(200);
    expect(patched.body.protected).toBe(true);
  });

  it("holds editors to the history rules: summary, fresh restore base, no delete", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    const doc = s.docs[s.policy.id]!;
    const noSummary = await http.put(`/api/cases/${s.policy.id}/documents/body`)
      .send({ body: "x", baseRevisionId: doc.revisionId }).expect(422);
    expect(noSummary.body.details?.code).toBe("change_summary_required");
    await http.put(`/api/cases/${s.policy.id}/documents/body`)
      .send({ body: "x", changeSummary: "   ", baseRevisionId: doc.revisionId }).expect(422);

    const restoreUrl = `/api/cases/${s.policy.id}/documents/body/revisions/${doc.firstRevisionId}/restore`;
    const noBase = await http.post(restoreUrl).send({}).expect(409);
    expect(noBase.body.details?.code).toBe("stale_base_revision");
    await http.post(restoreUrl).send({ baseRevisionId: doc.firstRevisionId }).expect(409);
    const restored = await http.post(restoreUrl).send({ baseRevisionId: doc.revisionId }).expect(200);
    expect(restored.body.revision.revisionNumber).toBe(3);
    // The base is now stale: a second restore from the old view is refused.
    await http.post(restoreUrl).send({ baseRevisionId: doc.revisionId }).expect(409);

    const del = await http.delete(`/api/cases/${s.policy.id}/documents/body`).expect(403);
    expect(del.body.details?.code).toBe("case_protected");
    const fixtureDel = await app(s.actors.poKey, s.config).delete(`/api/cases/${s.fixture.id}/documents/body`).expect(403);
    expect(fixtureDel.body.details?.code).toBe("case_protected");

    // No attachments either: an asset can be deleted from outside the case router.
    const attach = await http.post(`/api/cases/${s.policy.id}/attachments`)
      .attach("file", Buffer.from("x"), "x.txt").expect(403);
    expect(attach.body.details?.code).toBe("case_protected");
  });

  it("keeps reads and annotation threads open to readers", async () => {
    const s = await seed();
    const http = app(s.actors.reader, s.config);
    await http.get(`/api/cases/${s.policy.id}`).expect(200);
    await http.get(`/api/cases/${s.policy.id}/documents/body`).expect(200);
    await http.get(`/api/cases/${s.policy.id}/events`).expect(200);
    await http.post(`/api/cases/${s.policy.id}/documents/body/annotations`)
      .send(proposal(s, s.policy.id, "Proposal: say v3"))
      .expect(201);
  });

  it("leaves ordinary cases writable by any company member", async () => {
    const s = await seed();
    const http = app(s.actors.reader, s.config);
    await http.patch(`/api/cases/${s.plain.id}`).send({ title: "Renamed" }).expect(200);
    await http.put(`/api/cases/${s.plain.id}/documents/body`).send({ body: "free" }).expect(200);
    await http.delete(`/api/cases/${s.plain.id}/documents/body`).expect(200);
  });

  it("refuses everyone when the config is unset, so removing it never unprotects", async () => {
    const s = await seed();
    for (const name of ["raySession", "poKey", "reader"] as const) {
      const http = app(s.actors[name], undefined);
      await http.patch(`/api/cases/${s.policy.id}`).send({ title: "x" }).expect(403);
      await http.put(`/api/cases/${s.policy.id}/documents/body`)
        .send({ body: "x", changeSummary: "x", baseRevisionId: s.docs[s.policy.id]!.revisionId }).expect(403);
      // A UUID-listed fixture without config is just its own type again.
      await http.patch(`/api/cases/${s.plain.id}`).send({ title: "ok" }).expect(200);
    }
    const emptyEditors = JSON.stringify({ types: { "company-policy": { users: [], agentKeys: [] } } });
    await app(s.actors.raySession, emptyEditors).patch(`/api/cases/${s.policy.id}`).send({ title: "x" }).expect(403);
  });

  it("refuses every case write with 503 when the config is invalid, and keeps reads", async () => {
    const s = await seed();
    for (const name of ["raySession", "poKey", "reader"] as const) {
      const http = app(s.actors[name], "{not json");
      for (const target of [s.policy, s.plain]) {
        for (const [route, call] of Object.entries(writes(s, target))) {
          const res = await call(http);
          expect(res.status, `${name} ${route} on ${target.caseType}`).toBe(503);
          expect(res.body.details?.code).toBe("case_protection_unavailable");
        }
      }
      await http.post(`/api/cases/${s.policy.id}/documents/body/annotations`)
        .send(proposal(s, s.policy.id, "x")).expect(503);
      await http.get(`/api/cases/${s.policy.id}`).expect(200);
      await http.get(`/api/cases/${s.policy.id}/documents/body`).expect(200);
    }
  });
});
