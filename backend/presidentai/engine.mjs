export const GROUP_KEYS = ["workers", "business", "rural", "youth", "publicSector", "conservative"];

const EFFECT_LIMITS = Object.freeze({
  gdp: [-100, 150],
  gdpGrowth: [-3, 3],
  inflation: [-5, 5],
  unemployment: [-3, 3],
  budgetBalance: [-5, 5],
  treasury: [-25, 25],
  approval: [-12, 12],
  stability: [-12, 12],
  corruption: [-12, 12],
  publicServices: [-8, 8],
  education: [-8, 8],
  healthcare: [-8, 8],
  infrastructure: [-8, 8],
  militaryPower: [-8, 8],
  democracyIndex: [-12, 12],
  taxRate: [-3, 3],
  debt: [-8, 8]
});

const METRIC_BOUNDS = Object.freeze({
  gdp: [1, 10000000],
  gdpGrowth: [-30, 30],
  inflation: [-20, 250],
  unemployment: [0, 100],
  budgetBalance: [-100, 100],
  treasury: [0, 1000000],
  approval: [0, 100],
  stability: [0, 100],
  corruption: [0, 100],
  publicServices: [0, 100],
  education: [0, 100],
  healthcare: [0, 100],
  infrastructure: [0, 100],
  militaryPower: [0, 100],
  democracyIndex: [0, 100],
  taxRate: [0, 70],
  debt: [0, 500]
});

export function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

export function sanitizeDeltas(input) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    const limit = EFFECT_LIMITS[key];
    if (!limit || typeof value !== "number" || !Number.isFinite(value)) continue;
    result[key] = clamp(value, limit[0], limit[1]);
  }
  return result;
}

export function sanitizeGroupDeltas(input) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const key of GROUP_KEYS) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = clamp(value, -4, 4);
  }
  return result;
}

export function applyStateDeltas(currentState, input) {
  const state = currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? structuredClone(currentState)
    : {};
  const deltas = sanitizeDeltas(input);
  for (const [key, delta] of Object.entries(deltas)) {
    const bounds = METRIC_BOUNDS[key];
    const current = Number.isFinite(Number(state[key])) ? Number(state[key]) : (key === "gdp" ? 1 : 50);
    state[key] = Number(clamp(current + delta, bounds[0], bounds[1]).toFixed(2));
  }
  return { state, applied: deltas };
}

export function applyGroupDeltas(currentGroups, input) {
  const groups = { ...(currentGroups && typeof currentGroups === "object" ? currentGroups : {}) };
  const deltas = sanitizeGroupDeltas(input);
  for (const [key, delta] of Object.entries(deltas)) {
    groups[key] = Number(clamp(Number(groups[key] ?? 50) + delta, 0, 100).toFixed(1));
  }
  return { groups, applied: deltas };
}

export function electionDifficultyProfile(value = "normal") {
  const difficulty = String(value || "normal").toLowerCase();
  if (difficulty === "easy") return {
    startMin: 42, startRange: 9, proposalGroup: 0.70, proposalCredibility: 0.09,
    feasibilityPenalty: 0.20, proposalCap: 2.2, actionGroup: 0.42, actionCap: 1.3,
    eventGroup: 0.30, eventCap: 0.85
  };
  if (difficulty === "hard") return {
    startMin: 18, startRange: 9, proposalGroup: 0.30, proposalCredibility: 0.04,
    feasibilityPenalty: 0.45, proposalCap: 1.25, actionGroup: 0.22, actionCap: 0.8,
    eventGroup: 0.18, eventCap: 0.45
  };
  return {
    startMin: 32, startRange: 9, proposalGroup: 0.55, proposalCredibility: 0.07,
    feasibilityPenalty: 0.30, proposalCap: 1.9, actionGroup: 0.34, actionCap: 1.1,
    eventGroup: 0.24, eventCap: 0.70
  };
}

function applyCampaignOpinionEffects(currentElection, input, difficulty, mode) {
  const election = currentElection && typeof currentElection === "object" && !Array.isArray(currentElection)
    ? structuredClone(currentElection)
    : {};
  const profile = electionDifficultyProfile(difficulty);
  const groupResult = applyGroupDeltas(election.voterGroups, input);
  const values = Object.values(groupResult.applied);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const multiplier = mode === "event" ? profile.eventGroup : profile.actionGroup;
  const cap = mode === "event" ? profile.eventCap : profile.actionCap;
  const supportDelta = clamp(average * multiplier, -cap, cap);
  const support = clamp(Number(election.candidateSupport ?? 20) + supportDelta, 5, 95);
  election.voterGroups = groupResult.groups;
  election.candidateSupport = Number(support.toFixed(1));
  election.oppositionSupport = Number((100 - support).toFixed(1));
  return { election, applied: groupResult.applied, supportDelta: Number(supportDelta.toFixed(2)) };
}

export function applyCampaignEventEffects(currentElection, input, difficulty = "normal") {
  return applyCampaignOpinionEffects(currentElection, input, difficulty, "event");
}

export function applyCampaignActionEffects(currentElection, input, difficulty = "normal") {
  return applyCampaignOpinionEffects(currentElection, input, difficulty, "action");
}

export function coupProbability(state) {
  const s = state && typeof state === "object" ? state : {};
  const military = clamp(s.militaryPower ?? 50, 0, 100);
  const stability = clamp(s.stability ?? 50, 0, 100);
  const corruption = clamp(s.corruption ?? 50, 0, 100);
  const democracy = clamp(s.democracyIndex ?? 50, 0, 100);
  return Math.round(clamp(
    24 + (military - 50) * 0.28 + (stability - 50) * 0.22 +
    (corruption - 50) * 0.12 - (democracy - 50) * 0.2,
    8,
    65
  ));
}

export function resolveCoup(currentState, roll) {
  const state = structuredClone(currentState || {});
  const chance = coupProbability(state);
  const success = clamp(roll, 1, 100) <= chance;
  if (success) {
    state.dictatorship = true;
    state.democracyIndex = Number(clamp(Number(state.democracyIndex ?? 50) - 38, 0, 100).toFixed(2));
    state.stability = Number(clamp(Number(state.stability ?? 50) - 12, 0, 100).toFixed(2));
    state.approval = Number(clamp(Number(state.approval ?? 50) - 12, 0, 100).toFixed(2));
    state.corruption = Number(clamp(Number(state.corruption ?? 50) + 10, 0, 100).toFixed(2));
    state.institutionalTrust = Number(clamp(Number(state.institutionalTrust ?? 50) - 30, 0, 100).toFixed(2));
    state.powerGrab = { status: "successful", roll, chance };
  } else {
    state.democracyIndex = Number(clamp(Number(state.democracyIndex ?? 50) - 5, 0, 100).toFixed(2));
    state.stability = Number(clamp(Number(state.stability ?? 50) - 22, 0, 100).toFixed(2));
    state.approval = Number(clamp(Number(state.approval ?? 50) - 9, 0, 100).toFixed(2));
    state.corruption = Number(clamp(Number(state.corruption ?? 50) + 5, 0, 100).toFixed(2));
    state.institutionalTrust = Number(clamp(Number(state.institutionalTrust ?? 50) - 12, 0, 100).toFixed(2));
    state.powerGrab = { status: "failed", roll, chance };
  }
  return { state, success, chance, roll };
}

export function updateElection(currentState, aiResult, playerText, issue) {
  const state = structuredClone(currentState || {});
  const election = state.election && typeof state.election === "object" ? state.election : {};
  const groupResult = applyGroupDeltas(election.voterGroups, aiResult?.voterEffects);
  const effects = sanitizeDeltas(aiResult?.policyEffects);
  const credibilityDelta = clamp(Number(aiResult?.credibilityDelta ?? 0), -8, 8);
  const trustDelta = clamp(Number(aiResult?.institutionalTrustDelta ?? 0), -8, 8);
  const fiscalImpact = clamp(Number(aiResult?.fiscalImpactPct ?? 0), -3, 3);
  const groups = groupResult.groups;
  const deltas = Object.values(groupResult.applied);
  const groupAverage = deltas.length ? deltas.reduce((sum, n) => sum + n, 0) / deltas.length : 0;
  const oldSupport = clamp(election.candidateSupport ?? state.approval ?? 50, 1, 99);
  const credibility = clamp(Number(election.policyCredibility ?? 50) + credibilityDelta, 0, 100);
  const trust = clamp(Number(election.institutionalTrust ?? state.democracyIndex ?? 50) + trustDelta, 0, 100);
  const profile = electionDifficultyProfile(state.difficulty);
  const feasibilityPenalty = Math.max(0, Math.abs(fiscalImpact) - 1.2) * 0.45 * profile.feasibilityPenalty;
  const supportDelta = clamp(groupAverage * profile.proposalGroup + credibilityDelta * profile.proposalCredibility - feasibilityPenalty, -profile.proposalCap, profile.proposalCap);
  const support = clamp(oldSupport + supportDelta, 5, 95);
  const decisions = Array.isArray(election.decisions) ? [...election.decisions] : [];
  const issueTitle = issue?.title || aiResult?.issueTitle || "Политическая программа";
  const proposalTitle = String(aiResult?.decisionTitle || "Предложение партии").slice(0, 160);
  const decision = {
    issueId: issue?.id || "freeform",
    choiceId: "ai-" + Date.now(),
    issueTitle,
    choiceTitle: proposalTitle,
    playerProposal: String(playerText).slice(0, 4000),
    aiAnalysis: asText(aiResult?.analysis, 1200),
    publicReaction: asText(aiResult?.publicReaction, 800),
    policyEffects: effects,
    voterEffects: groupResult.applied,
    fiscalImpactPct: fiscalImpact,
    feasibilityScore: clamp(Number(aiResult?.feasibilityScore ?? 50), 0, 100),
    createdAt: new Date().toISOString()
  };
  decisions.push(decision);
  const policyEffects = { ...(election.policyEffects || {}) };
  for (const [key, value] of Object.entries(effects)) {
    policyEffects[key] = Number((Number(policyEffects[key] || 0) + value).toFixed(2));
  }
  const agenda = Array.isArray(election.agenda) ? election.agenda : [];
  const nextIndex = Math.max(0, Number(election.issueIndex || 0)) + 1;
  state.election = {
    ...election,
    decisions,
    voterGroups: groups,
    candidateSupport: Number(support.toFixed(1)),
    oppositionSupport: Number((100 - support).toFixed(1)),
    issueIndex: nextIndex,
    currentIssue: agenda[nextIndex]?.id || null,
    policyCredibility: Number(credibility.toFixed(1)),
    institutionalTrust: Number(trust.toFixed(1)),
    fiscalImpactPct: Number((Number(election.fiscalImpactPct || 0) + fiscalImpact).toFixed(2)),
    policyEffects
  };
  return { state, decision, election: state.election };
}

function asText(value, max = 1200) {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["text", "summary", "message", "reaction", "description"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim().slice(0, max);
    }
  }
  if (Array.isArray(value)) return value.filter(item => typeof item === "string").join(" · ").slice(0, max);
  return "";
}

export function initializeElectionBaseline(currentState, seed = "") {
  const state = currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? structuredClone(currentState)
    : {};
  const phase = String(state.phase || "");
  if (!["election_campaign", "election"].includes(phase)) return { state, changed: false };

  const election = state.election && typeof state.election === "object" ? state.election : {};
  if (Number(election.baselineVersion || 0) >= 3) return { state, changed: false };

  const decisions = Array.isArray(election.decisions) ? election.decisions : [];
  const actions = Array.isArray(state.politicalActions) ? state.politicalActions : [];
  const issueIndex = Math.max(0, Number(election.issueIndex || 0));
  const hasProgress = decisions.length > 0 || actions.length > 0 || issueIndex > 0;
  const currentSupport = clamp(election.candidateSupport ?? state.approval ?? 45, 1, 99);

  let hash = 2166136261;
  for (const character of String(seed || election.partyName || "campaign")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const profile = electionDifficultyProfile(state.difficulty);
  const startingSupport = profile.startMin + (hash >>> 0) % profile.startRange;
  const previousStartingSupport = Number.isFinite(Number(election.startingSupport)) ? Number(election.startingSupport) : currentSupport;
  const progress = hasProgress ? clamp(currentSupport - previousStartingSupport, -12, 25) : 0;
  const candidateSupport = clamp(startingSupport + progress, 5, 95);
  const adjustment = startingSupport - previousStartingSupport;

  const currentGroups = election.voterGroups && typeof election.voterGroups === "object"
    ? election.voterGroups
    : {};
  const voterGroups = {};
  GROUP_KEYS.forEach((key, index) => {
    const existing = Number(currentGroups[key]);
    const spread = ((hash >>> (index * 3)) % 9) - 4;
    const baseline = Number.isFinite(existing) ? existing : currentSupport + spread;
    voterGroups[key] = Number(clamp(baseline + adjustment, 8, 70).toFixed(1));
  });

  state.election = {
    ...election,
    baselineVersion: 3,
    difficultyBalanceVersion: 3,
    startingSupport: Number(startingSupport.toFixed(1)),
    baselineAdjustment: Number(adjustment.toFixed(1)),
    candidateSupport: Number(candidateSupport.toFixed(1)),
    oppositionSupport: Number((100 - candidateSupport).toFixed(1)),
    voterGroups
  };
  return { state, changed: true };
}

export function isDuplicateCampaignAction(actions, input) {
  const normalize = value => String(value || "").toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const requested = normalize(input);
  if (requested.length < 8 || !Array.isArray(actions)) return false;
  return actions.slice(-8).some(item => normalize(item?.text) === requested);
}

export function normalizeTreaties(raw) {
  if (Array.isArray(raw)) return { activeDeals: [...raw] };
  if (raw && typeof raw === "object") return { ...raw };
  return { activeDeals: [] };
}
