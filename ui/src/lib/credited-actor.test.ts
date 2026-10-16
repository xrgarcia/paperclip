import type { ActivityEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { withCreditedActor } from "./credited-actor";

const event = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: "a1", companyId: "c1", actorType: "user", actorId: "ray", action: "issue.updated",
  entityType: "issue", entityId: "i1", agentId: null, runId: null, details: null, createdAt: new Date(0), ...over,
});

describe("credited activity actor", () => {
  it("shows a credited board-user row as its credited author", () => {
    expect(withCreditedActor(event({ details: { creditedActor: { type: "agent", id: "foreman" } } })))
      .toMatchObject({ actorType: "agent", actorId: "foreman" });
    expect(withCreditedActor(event({ details: { creditedActor: { type: "user", id: "u2" } } })))
      .toMatchObject({ actorType: "user", actorId: "u2" });
  });

  it("leaves an uncredited, malformed or agent-logged row as saved", () => {
    const plain = event({});
    expect(withCreditedActor(plain)).toBe(plain);
    const bad = event({ details: { creditedActor: { type: "system", id: "x" } } });
    expect(withCreditedActor(bad)).toBe(bad);
    const agentRow = event({ actorType: "agent", actorId: "nova", details: { creditedActor: { type: "agent", id: "foreman" } } });
    expect(withCreditedActor(agentRow)).toBe(agentRow);
  });
});
