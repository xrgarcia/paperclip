// Slashbin patch (EM#642): published-document state, publish and withdraw behind the editor gate.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseDocuments,
  caseEvents,
  cases,
  companies,
  createDb,
  documentPublications,
  documentRevisions,
  documents,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { PROTECTED_CASES_ENV } from "../slashbin/protected-cases.js";
import type { StorageService } from "../storage/types.js";

type Actor = Express.Request["actor"];

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("document publications routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousConfig = process.env[PROTECTED_CASES_ENV];
  const storage = {} as StorageService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-document-publications-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(caseDocuments);
    await db.delete(caseEvents);
    await db.delete(cases);
    await db.delete(documentRevisions);
    await db.delete(documents);
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
    const [policy] = await db.insert(cases).values({
      companyId: company!.id,
      caseNumber: 1,
      identifier: `${company!.issuePrefix}-C1`,
      caseType: "company-policy",
      key: "company-policies",
      title: "Company policies",
    }).returning();
    const [plain] = await db.insert(cases).values({
      companyId: company!.id,
      caseNumber: 2,
      identifier: `${company!.issuePrefix}-C2`,
      caseType: "bug",
      title: "Ordinary",
    }).returning();
    const config = JSON.stringify({ types: { "company-policy": { users: [RAY], agentKeys: [] } } });
    const companyIds = [company!.id];
    const actors = {
      raySession: { type: "board", userId: RAY, source: "session", companyIds, isInstanceAdmin: true },
      rayBoardKey: { type: "board", userId: RAY, source: "board_key", keyId: "k", companyIds, isInstanceAdmin: true },
      adminSession: { type: "board", userId: "other-admin", source: "session", companyIds, isInstanceAdmin: true },
      otherCompany: { type: "board", userId: RAY, source: "session", companyIds: [randomUUID()], isInstanceAdmin: false },
      anonymous: { type: "none", source: "none" },
    } satisfies Record<string, Actor>;
    const editor = app(actors.raySession, config);
    // A policy document with two revisions, written by the editor.
    const r1 = await editor.put(`/api/cases/${policy!.id}/documents/handbook`)
      .send({ body: "v1", changeSummary: "first" }).expect(200);
    const r2 = await editor.put(`/api/cases/${policy!.id}/documents/handbook`)
      .send({ body: "v2", changeSummary: "second", baseRevisionId: r1.body.revision.id }).expect(200);
    const documentId = r2.body.document.id as string;
    // A document on an ordinary Case (Cases that are not protected take any writer).
    await app(actors.raySession, config).put(`/api/cases/${plain!.id}/documents/notes`)
      .send({ body: "n1" }).expect(200);
    return {
      company: company!, policy: policy!, plain: plain!, config, actors, documentId,
      r1: r1.body.revision.id as string, r2: r2.body.revision.id as string,
    };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const publishUrl = (s: Seeded, key = "handbook") => `/api/cases/${s.policy.id}/documents/${key}/publish`;
  const withdrawUrl = (s: Seeded, key = "handbook") => `/api/cases/${s.policy.id}/documents/${key}/withdraw`;
  const listUrl = (s: Seeded) => `/api/companies/${s.company.id}/published-documents`;

  async function edit(s: Seeded, body: string, baseRevisionId: string) {
    const res = await app(s.actors.raySession, s.config).put(`/api/cases/${s.policy.id}/documents/handbook`)
      .send({ body, changeSummary: "edit", baseRevisionId }).expect(200);
    return res.body.revision.id as string;
  }

  async function publicationRow(documentId: string) {
    return db.select().from(documentPublications).where(eq(documentPublications.documentId, documentId))
      .then((rows) => rows[0]!);
  }

  it("creates every Case document as a draft that the list does not show", async () => {
    const s = await seed();
    const rows = await db.select().from(documentPublications);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "draft" && r.publishedRevisionId === null && r.publishedAt === null)).toBe(true);
    const list = await app(s.actors.raySession, s.config).get(listUrl(s)).expect(200);
    expect(list.body.companyId).toBe(s.company.id);
    expect(list.body.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(list.body.documents).toEqual([]);
  });

  it("lets a listed editor publish and serves the published revision's body and sha256", async () => {
    const s = await seed();
    const res = await app(s.actors.raySession, s.config).post(publishUrl(s))
      .send({ baseRevisionId: s.r2, changeSummary: "ship v2" }).expect(200);
    expect(res.body).toMatchObject({
      documentId: s.documentId,
      caseId: s.policy.id,
      key: "handbook",
      state: "published",
      revisionId: s.r2,
      revisionNumber: 2,
      withdrawnAt: null,
    });
    expect(new Date(res.body.publishedAt).toISOString()).toBe(res.body.publishedAt);
    const row = await publicationRow(s.documentId);
    expect(row).toMatchObject({ state: "published", publishedRevisionId: s.r2, publishedRevisionNumber: 2, publishedBy: RAY });

    const list = await app(s.actors.adminSession, s.config).get(listUrl(s)).expect(200);
    expect(list.body.documents).toEqual([{
      documentId: s.documentId,
      caseId: s.policy.id,
      caseIdentifier: s.policy.identifier,
      key: "handbook",
      title: "handbook",
      format: "markdown",
      revisionId: s.r2,
      revisionNumber: 2,
      sha256: sha("v2"),
      publishedAt: res.body.publishedAt,
      body: "v2",
    }]);
  });

  it("refuses a non-listed caller, a board key and an unprotected Case with 403", async () => {
    const s = await seed();
    const body = { baseRevisionId: s.r2, changeSummary: "ship" };
    await app(s.actors.adminSession, s.config).post(publishUrl(s)).send(body).expect(403);
    await app(s.actors.rayBoardKey, s.config).post(publishUrl(s)).send(body).expect(403);
    await app(s.actors.raySession, s.config).post(`/api/cases/${s.plain.id}/documents/notes/publish`)
      .send({ baseRevisionId: randomUUID(), changeSummary: "ship" }).expect(403);
    await app(s.actors.adminSession, s.config).post(withdrawUrl(s)).send({ changeSummary: "x" }).expect(403);
    await app(s.actors.raySession, s.config).post(`/api/cases/${s.plain.id}/documents/notes/withdraw`)
      .send({ changeSummary: "x" }).expect(403);
    const rows = await db.select().from(documentPublications);
    expect(rows.every((r) => r.state === "draft")).toBe(true);
  });

  it("rejects a bad body, an unknown key and an unknown case", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    await http.post(publishUrl(s)).send({ baseRevisionId: s.r2 }).expect(400);
    await http.post(publishUrl(s)).send({ baseRevisionId: "nope", changeSummary: "x" }).expect(400);
    await http.post(withdrawUrl(s)).send({}).expect(400);
    await http.post(publishUrl(s, "missing")).send({ baseRevisionId: s.r2, changeSummary: "x" }).expect(404);
    await http.post(`/api/cases/${randomUUID()}/documents/handbook/publish`)
      .send({ baseRevisionId: s.r2, changeSummary: "x" }).expect(404);
  });

  it("answers a stale baseRevisionId with 409 and changes nothing", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    const res = await http.post(publishUrl(s)).send({ baseRevisionId: s.r1, changeSummary: "old" }).expect(409);
    expect(res.body.details).toMatchObject({ code: "stale_base_revision", latestRevisionId: s.r2 });
    expect((await publicationRow(s.documentId)).state).toBe("draft");

    await http.post(publishUrl(s)).send({ baseRevisionId: s.r2, changeSummary: "ok" }).expect(200);
    const r3 = await edit(s, "v3", s.r2);
    const before = await publicationRow(s.documentId);
    await http.post(publishUrl(s)).send({ baseRevisionId: s.r2, changeSummary: "stale" }).expect(409);
    expect(await publicationRow(s.documentId)).toEqual(before);
    expect(before.publishedRevisionId).toBe(s.r2);
    expect(r3).not.toBe(s.r2);
  });

  it("publishes and withdraws twice with the same result", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    const body = { baseRevisionId: s.r2, changeSummary: "ship" };
    const p1 = await http.post(publishUrl(s)).send(body).expect(200);
    const p2 = await http.post(publishUrl(s)).send(body).expect(200);
    expect(p2.body).toEqual(p1.body);

    const w1 = await http.post(withdrawUrl(s)).send({ changeSummary: "pull" }).expect(200);
    const w2 = await http.post(withdrawUrl(s)).send({ changeSummary: "pull" }).expect(200);
    expect(w2.body).toEqual(w1.body);
    expect(w1.body).toMatchObject({ state: "withdrawn", revisionId: s.r2, revisionNumber: 2, publishedAt: p1.body.publishedAt });
    expect(w1.body.withdrawnAt).toEqual(expect.any(String));
  });

  it("drops a withdrawn document from the list and keeps its published revision as history", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    await http.post(publishUrl(s)).send({ baseRevisionId: s.r2, changeSummary: "ship" }).expect(200);
    await http.post(withdrawUrl(s)).send({ changeSummary: "pull" }).expect(200);
    expect((await http.get(listUrl(s)).expect(200)).body.documents).toEqual([]);
    const row = await publicationRow(s.documentId);
    expect(row).toMatchObject({ state: "withdrawn", publishedRevisionId: s.r2, publishedRevisionNumber: 2 });
    expect(row.withdrawnAt).not.toBeNull();

    // Re-publish takes the then-latest revision.
    const r3 = await edit(s, "v3", s.r2);
    const again = await http.post(publishUrl(s)).send({ baseRevisionId: r3, changeSummary: "again" }).expect(200);
    expect(again.body).toMatchObject({ state: "published", revisionId: r3, revisionNumber: 3, withdrawnAt: null });
    expect((await http.get(listUrl(s)).expect(200)).body.documents[0]).toMatchObject({ body: "v3", sha256: sha("v3") });
  });

  it("refuses to withdraw a draft", async () => {
    const s = await seed();
    await app(s.actors.raySession, s.config).post(withdrawUrl(s)).send({ changeSummary: "x" }).expect(409);
    expect((await publicationRow(s.documentId)).state).toBe("draft");
  });

  it("leaves the list unchanged by an edit of a draft, and serves the earlier revision after a post-publish edit", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    const emptyBefore = (await http.get(listUrl(s)).expect(200)).body.documents;
    await edit(s, "draft edit", s.r2);
    expect((await http.get(listUrl(s)).expect(200)).body.documents).toEqual(emptyBefore);

    const latest = (await db.select().from(documents).where(eq(documents.id, s.documentId)))[0]!.latestRevisionId!;
    await http.post(publishUrl(s)).send({ baseRevisionId: latest, changeSummary: "ship" }).expect(200);
    const published = (await http.get(listUrl(s)).expect(200)).body.documents[0];
    expect(published).toMatchObject({ body: "draft edit", sha256: sha("draft edit"), revisionId: latest });

    const newer = await edit(s, "after publish", latest);
    const after = (await http.get(listUrl(s)).expect(200)).body.documents[0];
    expect(after).toMatchObject({ body: "draft edit", sha256: sha("draft edit"), revisionId: latest });
    expect((await publicationRow(s.documentId)).publishedRevisionId).toBe(latest);

    // A restore moves the latest revision too, and also leaves the published one alone.
    await http.post(`/api/cases/${s.policy.id}/documents/handbook/revisions/${s.r1}/restore`)
      .send({ baseRevisionId: newer }).expect(200);
    expect((await publicationRow(s.documentId)).publishedRevisionId).toBe(latest);
    expect((await http.get(listUrl(s)).expect(200)).body.documents[0].body).toBe("draft edit");
  });

  it("returns 503 on publish and withdraw while the protection config is invalid, and still lists", async () => {
    const s = await seed();
    await app(s.actors.raySession, s.config).post(publishUrl(s))
      .send({ baseRevisionId: s.r2, changeSummary: "ship" }).expect(200);
    const broken = app(s.actors.raySession, "{not json");
    await broken.post(publishUrl(s)).send({ baseRevisionId: s.r2, changeSummary: "ship" }).expect(503);
    await broken.post(withdrawUrl(s)).send({ changeSummary: "pull" }).expect(503);
    const list = await broken.get(listUrl(s)).expect(200);
    expect(list.body.documents).toHaveLength(1);
    expect((await publicationRow(s.documentId)).state).toBe("published");
  });

  it("keeps DELETE at 403 on a protected Case, published or not", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    await http.post(publishUrl(s)).send({ baseRevisionId: s.r2, changeSummary: "ship" }).expect(200);
    await http.delete(`/api/cases/${s.policy.id}/documents/handbook`).expect(403);
    expect((await publicationRow(s.documentId)).state).toBe("published");
    expect((await http.get(listUrl(s)).expect(200)).body.documents).toHaveLength(1);
  });

  it("limits the list to the caller's company and orders it by case identifier then key", async () => {
    const s = await seed();
    const http = app(s.actors.raySession, s.config);
    for (const key of ["zeta", "alpha"]) {
      const created = await http.put(`/api/cases/${s.policy.id}/documents/${key}`)
        .send({ body: key, changeSummary: "new" }).expect(200);
      await http.post(publishUrl(s, key))
        .send({ baseRevisionId: created.body.revision.id, changeSummary: "ship" }).expect(200);
    }
    const keys = (await http.get(listUrl(s)).expect(200)).body.documents.map((d: { key: string }) => d.key);
    expect(keys).toEqual(["alpha", "zeta"]);
    await app(s.actors.otherCompany, s.config).get(listUrl(s)).expect(404);
    await app(s.actors.anonymous, s.config).get(listUrl(s)).expect(401);
  });

  it("backfills a draft row for a Case document that predates the table", async () => {
    const s = await seed();
    const [doc] = await db.insert(documents).values({
      companyId: s.company.id, title: "old", latestBody: "legacy", latestRevisionNumber: 1,
    }).returning();
    await db.insert(caseDocuments).values({
      companyId: s.company.id, caseId: s.policy.id, documentId: doc!.id, key: "legacy",
    });
    expect(await db.select().from(documentPublications).where(eq(documentPublications.documentId, doc!.id))).toEqual([]);

    // Run the migration's own backfill statement.
    const migration = readFileSync(
      new URL("../../../packages/db/src/migrations/0294_cold_roxanne_simpson.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").map((part) => part.trim())
      .find((part) => part.startsWith('INSERT INTO "document_publications"'));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));

    const row = await publicationRow(doc!.id);
    expect(row).toMatchObject({
      state: "draft", companyId: s.company.id, publishedRevisionId: null,
      publishedRevisionNumber: null, publishedAt: null, publishedBy: null, withdrawnAt: null,
    });
    const list = await app(s.actors.raySession, s.config).get(listUrl(s)).expect(200);
    expect(list.body.documents).toEqual([]);
  });
});
