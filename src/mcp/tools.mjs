import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeStatus } from '../status/status.mjs';
import { buildBrief, buildUnclaimedBrief } from '../brief/brief.mjs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { scanAnnotations, reconcile } from '../claims/annotations.mjs';
import { computeRemovedClaims } from '../claims/removed.mjs';
import { readSpecDoc } from '../evidence/writer.mjs';
import { resolveChangedRef, withChangedRef } from '../gate/changed.mjs';

/**
 * The read-only surface an agent needs, in any harness.
 *
 * TestGuard's operating loop currently lives in a Claude Code skill and a
 * session-start hook, and both vanish the moment the harness is something
 * else. These tools expose the documents the tool already computes, so the
 * loop survives that change.
 *
 * Every tool is read-only and none of them probes. A probe is long-running
 * and budgeted, and the human should see it happen: `next_command` hands back
 * the exact shell line for the agent to run in its own terminal instead.
 */
const projectOf = (args) => resolve(args?.dir ?? '.');
const evidenceOf = (args) => (args?.evidence ? resolve(args.evidence) : undefined);

const DIR = { type: 'string', description: 'Project directory (where testguard.claims.json lives). Defaults to the current directory.' };
const EVIDENCE = { type: 'string', description: "Read this evidence document instead of the project's own — CI's, fetched as an artifact." };
const CHANGED = { type: 'string', description: 'A git reference to measure the change against, so claim coverage of the change is included.' };

const statusFor = (args) => {
  const projectDir = projectOf(args);
  return withChangedRef(resolveChangedRef({ explicit: args?.changed, projectDir }), (changedRef) =>
    computeStatus({ projectDir, toolVersion: args?.__version ?? '0.0.0', changedRef, evidence: evidenceOf(args) }));
};

export const TOOLS = [
  {
    name: 'testguard_status',
    description: 'Where this project stands and the ONE next action, as the machine-readable status document: state, next {action, command, why}, counts, stale inputs, faults edited since they were probed, and the ranked findings. This is the single source of truth every other rendering derives from — read it before deciding anything.',
    inputSchema: { type: 'object', properties: { dir: DIR, changed: CHANGED, evidence: EVIDENCE }, additionalProperties: false },
    handler: (args) => statusFor(args),
  },
  {
    name: 'testguard_brief',
    description: 'Where the test suite is blind, ranked and capped, with one actionable hint per finding and unclaimed changed files first. Read this before writing or changing code, which is what the session-start hook does for harnesses that have one.',
    inputSchema: { type: 'object', properties: { dir: DIR, changed: CHANGED, evidence: EVIDENCE, max: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    handler: (args) => {
      const projectDir = projectOf(args);
      const evPath = evidenceOf(args) ?? join(projectDir, '.testguard', 'evidence.json');
      const status = (() => {
        try {
          return statusFor(args);
        } catch {
          return undefined; // a brief must never fail because status could not be computed
        }
      })();
      if (!existsSync(evPath)) {
        if (status?.changes?.uncovered?.length) {
          return buildUnclaimedBrief({ tool: { name: 'testguard', version: args?.__version ?? '0.0.0' }, next: status.next, changes: status.changes });
        }
        return { note: `no evidence at ${evPath}: nothing has been probed yet`, next: status?.next };
      }
      const evidence = readSpecDoc('evidence', evPath);
      const basePath = join(projectDir, '.testguard', 'baseline.json');
      const baseline = existsSync(basePath) ? readSpecDoc('baseline', basePath) : undefined;
      return buildBrief(evidence, baseline, { max: args?.max ?? 20, next: status?.next, changes: status?.changes });
    },
  },
  {
    name: 'testguard_claims',
    description: "What this project claims must be true, each with its faults and defenders, plus drift against `@claim` annotations in source and — when `since` is given — every claim or fault that existed at that reference and does not now. A claim that disappeared is invisible to every other check.",
    inputSchema: { type: 'object', properties: { dir: DIR, since: { type: 'string', description: 'A git reference: report claims and faults removed since it.' } }, additionalProperties: false },
    handler: (args) => {
      const projectDir = projectOf(args);
      const path = defaultClaimsPath(projectDir);
      if (!existsSync(path)) return { path, claims: [], note: 'no claims file in this project yet' };
      const claims = loadClaims(path);
      const drift = reconcile(claims, scanAnnotations(projectDir));
      const removed = args?.since
        ? computeRemovedClaims({ projectDir, ref: args.since, claimsPath: path, current: claims, evidencePath: join(projectDir, '.testguard', 'evidence.json'), toolVersion: args?.__version ?? '0.0.0' })
        : undefined;
      return { path, claims, drift, ...(removed ? { removed } : {}) };
    },
  },
  {
    name: 'testguard_evidence',
    description: 'One run\'s findings on disk: every verdict with the runs that produced it. Pass `claim` (and optionally `fault`) for a single record instead of the whole document, which can be large.',
    inputSchema: {
      type: 'object',
      properties: { dir: DIR, evidence: EVIDENCE, claim: { type: 'string', description: 'Return only this claim\'s records.' }, fault: { type: 'string', description: 'With `claim`: only this fault\'s record.' } },
      additionalProperties: false,
    },
    handler: (args) => {
      const projectDir = projectOf(args);
      const evPath = evidenceOf(args) ?? join(projectDir, '.testguard', 'evidence.json');
      if (!existsSync(evPath)) return { note: `no evidence at ${evPath}: run a probe first`, path: evPath };
      const doc = readSpecDoc('evidence', evPath);
      if (!args?.claim) return doc;
      const records = doc.records.filter((r) => r.claim.id === args.claim && (!args.fault || r.subject.id === args.fault));
      return { ...doc, records, filtered: { claim: args.claim, ...(args.fault ? { fault: args.fault } : {}) } };
    },
  },
  {
    name: 'testguard_next_command',
    description: 'The exact shell command to run next, with the reason. Run it yourself in a terminal: a probe is long-running and budgeted, and the person should see it happen. This tool never runs anything.',
    inputSchema: { type: 'object', properties: { dir: DIR, changed: CHANGED, evidence: EVIDENCE }, additionalProperties: false },
    handler: (args) => {
      const doc = statusFor(args);
      return { state: doc.state, action: doc.next.action, command: doc.next.command, why: doc.next.why, ...(doc.next.target ? { target: doc.next.target } : {}), ...(doc.next.file ? { file: doc.next.file } : {}) };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
