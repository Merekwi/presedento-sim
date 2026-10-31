import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDeltas, applyStateDeltas, applyGroupDeltas,
  coupProbability, resolveCoup, updateElection, normalizeTreaties,
  initializeElectionBaseline, isDuplicateCampaignAction, applyCampaignEventEffects
} from "./engine.mjs";

test("AI deltas accept only known numeric metrics and enforce limits", () => {
  const actual = sanitizeDeltas({ approval: 999, stability: -999, unknown: 4, gdpGrowth: "100", treasury: 3.5 });
  assert.deepEqual(actual, { approval: 12, stability: -12, treasury: 3.5 });
});

test("state application clamps final values and preserves unrelated state", () => {
  const { state } = applyStateDeltas({ approval: 97, treasury: 2, unrelated: "keep" }, { approval: 12, treasury: -25 });
  assert.equal(state.approval, 100);
  assert.equal(state.treasury, 0);
  assert.equal(state.unrelated, "keep");
});

test("voter group changes are bounded", () => {
  const { groups } = applyGroupDeltas({ workers: 98, business: 4 }, { workers: 8, business: -8, fake: 8 });
  assert.equal(groups.workers, 100);
  assert.equal(groups.business, 0);
  assert.equal(groups.fake, undefined);
  assert.deepEqual(applyGroupDeltas({ workers: 50 }, { workers: 8 }).applied, { workers: 4 });
});

test("coup probability stays between eight and sixty-five percent", () => {
  assert.equal(coupProbability({ militaryPower: 100, stability: 100, corruption: 100, democracyIndex: 0 }), 65);
  assert.equal(coupProbability({ militaryPower: 0, stability: 0, corruption: 0, democracyIndex: 100 }), 8);
});

test("failed and successful coup outcomes both preserve explicit state", () => {
  const base = { stability: 60, approval: 50, democracyIndex: 60, corruption: 30, unrelated: true };
  const failed = resolveCoup(base, 100);
  const won = resolveCoup(base, 1);
  assert.equal(failed.success, false);
  assert.equal(failed.state.powerGrab.status, "failed");
  assert.equal(won.success, true);
  assert.equal(won.state.dictatorship, true);
  assert.equal(won.state.unrelated, true);
});

test("election proposals add free-text decisions and advance only one agenda point", () => {
  const current = { phase: "election_campaign", election: { issueIndex: 0, agenda: [{id:"economy",title:"Экономика"},{id:"health",title:"Здравоохранение"}], voterGroups:{workers:50}, candidateSupport:50, decisions:[] } };
  const result = updateElection(current, { decisionTitle:"Налоговая реформа", credibilityDelta:2, voterEffects:{workers:3}, policyEffects:{gdpGrowth:1} }, "Снизить налог на труд и закрыть льготы монополиям", current.election.agenda[0]);
  assert.equal(result.state.election.issueIndex, 1);
  assert.equal(result.state.election.currentIssue, "health");
  assert.equal(result.state.election.decisions[0].playerProposal.includes("монополиям"), true);
  assert.equal(result.state.election.candidateSupport > 50, true);
});

test("diplomacy treaties retain old list values", () => {
  assert.deepEqual(normalizeTreaties([{name:"Договор"}]).activeDeals, [{name:"Договор"}]);
});

test("new election baseline starts well below a 50 percent majority and is idempotent", () => {
  const current = {
    phase: "election_campaign",
    approval: 70,
    election: { candidateSupport: 49, voterGroups: { workers: 48, business: 52 }, decisions: [], issueIndex: 0 }
  };
  const first = initializeElectionBaseline(current, "save-123");
  const support = first.state.election.candidateSupport;
  assert.equal(first.changed, true);
  assert.ok(support >= 18 && support <= 26);
  assert.equal(first.state.election.oppositionSupport, 100 - support);
  assert.ok(first.state.election.voterGroups.workers < 30);
  assert.ok(first.state.election.voterGroups.business < 35);
  const second = initializeElectionBaseline(first.state, "save-123");
  assert.equal(second.changed, false);
  assert.equal(second.state.election.candidateSupport, support);
});

test("baseline normalization preserves a small amount of early campaign progress", () => {
  const current = {
    phase: "election_campaign",
    election: {
      candidateSupport: 48,
      voterGroups: { workers: 54, business: 43 },
      issueIndex: 1,
      decisions: [{ playerProposal: "proposal" }]
    },
    politicalActions: [{ text: "town hall meeting" }]
  };
  const result = initializeElectionBaseline(current, "existing-save");
  assert.ok(result.state.election.candidateSupport < 30);
  assert.ok(result.state.election.candidateSupport > result.state.election.startingSupport);
});

test("duplicate campaign actions are detected after whitespace and punctuation normalization", () => {
  const actions = [{ text: "Провести встречи с жителями регионов!" }];
  assert.equal(isDuplicateCampaignAction(actions, " провести   встречи с жителями регионов "), true);
  assert.equal(isDuplicateCampaignAction(actions, "Организовать публичные дебаты"), false);
});

test("debate and press event effects shift polls gradually and retain realistic bounds", () => {
  const current = {
    candidateSupport: 24,
    oppositionSupport: 76,
    voterGroups: { workers: 20, business: 18, rural: 22, youth: 25, publicSector: 19, conservative: 21 }
  };
  const result = applyCampaignEventEffects(current, {
    workers: 4, business: 4, rural: 4, youth: 4, publicSector: 4, conservative: 4
  });
  assert.equal(result.election.candidateSupport, 24.4);
  assert.equal(result.election.oppositionSupport, 75.6);
  assert.equal(result.supportDelta, 0.45);
  assert.equal(result.election.voterGroups.workers, 24);
  assert.equal(current.candidateSupport, 24);
});

test("a poor debate answer can reduce support, but never by more than 0.45 per round", () => {
  const result = applyCampaignEventEffects({
    candidateSupport: 24,
    voterGroups: { workers: 20, business: 20, rural: 20, youth: 20, publicSector: 20, conservative: 20 }
  }, { workers: -4, business: -4, rural: -4, youth: -4, publicSector: -4, conservative: -4 });
  assert.equal(result.supportDelta, -0.45);
  assert.equal(result.election.candidateSupport, 23.6);
});
