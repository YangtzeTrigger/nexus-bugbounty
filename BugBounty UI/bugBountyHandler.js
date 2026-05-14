/**
 * bugBountyHandler.js
 * Nexus — Harmonic Command
 * Main process IPC handler for the Bug Bounty pipeline
 *
 * USAGE — in your main.js, add:
 *   const { registerBugBountyHandlers } = require('./bugBountyHandler');
 *   registerBugBountyHandlers(ipcMain);
 *
 * Requires ANTHROPIC_API_KEY in your .env (already present in Nexus).
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-20250514';

// ─── Agent System Prompts ─────────────────────────────────────────────────────

const SCOPE_SYSTEM = `You are a Scope Validator agent in a bug bounty pipeline.
Your job is to assess whether a given target and objective represent a legitimate,
ethical, and legal security research task.

Evaluate:
1. Is the target a real domain/application (not a critical infrastructure, government system, or out-of-bounds target)?
2. Is the objective reasonable for bug bounty research?
3. Flag any obvious red flags (credentials harvesting, DDoS, social engineering, etc.)

You MUST respond with valid JSON only — no prose, no markdown, no code fences. Schema:
{
  "scope_status": "CLEAR" | "BLOCKED",
  "reason": "brief reasoning string",
  "attack_surface": "what is in scope based on paths/notes provided",
  "recommended_approach": "vulnerability class to focus on"
}

If BLOCKED, set scope_status to "BLOCKED" and explain in reason. If CLEAR, proceed with the assessment.`;

const RECON_SYSTEM = `You are a Bug Finder agent in a bug bounty pipeline.
You receive a validated scope and objective. Your job is to reason through
likely vulnerability classes for the given target and scope, and produce
structured findings a security researcher could use to guide testing.

You MUST respond with valid JSON only — no prose, no markdown, no code fences. Schema:
{
  "findings": [
    {
      "id": "F-001",
      "title": "short finding title",
      "vuln_class": "e.g. IDOR, SQLi, Auth Bypass, SSRF",
      "severity": "critical" | "high" | "medium" | "low",
      "cvss_estimate": "e.g. 8.1",
      "confidence": "confirmed" | "probable" | "suspected",
      "location": "specific endpoints, parameters, or headers to probe",
      "poc_steps": "conceptual proof-of-concept steps",
      "rationale": "why this is likely given the target type",
      "cwe_id": "e.g. CWE-639"
    }
  ]
}

Confidence levels:
- confirmed: vulnerability class has real disclosed precedents against similar targets
- probable: strongly inferred from target architecture and common patterns
- suspected: pattern-matched from general knowledge, lower certainty

Focus on the severity level requested. Be technically precise.
Do not include generic advice — every finding must be specific to the target described.`;

const FIX_SYSTEM = `You are a Fix Suggester agent in a bug bounty pipeline.
You receive structured bug findings. Your job is to produce clear, actionable
remediation recommendations matched to each finding by ID.

You MUST respond with valid JSON only — no prose, no markdown, no code fences. Schema:
{
  "remediations": [
    {
      "finding_id": "F-001",
      "root_cause": "root cause analysis",
      "fix": "concrete code-level or configuration-level recommendation, naming specific libraries/functions/patterns",
      "verification": "how to confirm the fix is effective",
      "owasp_ref": "e.g. OWASP A01:2021",
      "cwe_id": "e.g. CWE-639"
    }
  ]
}`;

const REPORT_SYSTEM = `You are a Reporter agent in a bug bounty pipeline.
You receive structured scope assessment, findings, and remediations.
Your job is to produce a clean, professional bug bounty disclosure report as plain text.

Structure:
---
VULNERABILITY DISCLOSURE REPORT
================================
Target: [target]
Date: [today]
Severity: [severity]

EXECUTIVE SUMMARY
-----------------
[2-3 sentence overview]

FINDINGS
--------
[For each finding: ID, title, severity, confidence, description, reproduction steps, impact]

REMEDIATIONS
------------
[Matched remediations for each finding]

SCOPE NOTES
-----------
[Scope assessment summary]

RESEARCHER NOTES
----------------
[Report level: beginner/intermediate/expert framing]
---

Write in clear professional English. Calibrate technical depth to the report level.
This report should be ready to submit to a bug bounty platform or directly to a security team.`;

// ─── Abort controller registry ────────────────────────────────────────────────

let _currentAbortController = null;

// ─── Stage Handlers ───────────────────────────────────────────────────────────

async function runScopeStage(client, payload, signal) {
  const { target, scope, objective, severity } = payload;

  const userMsg = `Target: ${target}
Scope/paths: ${scope || 'Not specified — treat entire domain as in-scope'}
Objective: ${objective || 'General vulnerability assessment'}
Requested severity focus: ${severity}

Validate this scope and provide your assessment as JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: SCOPE_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  }, { signal });

  console.log(`[BugBounty:scope] tokens in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  const raw = response.content[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Graceful fallback: treat as CLEAR but log the parse failure
    console.warn('[BugBounty:scope] JSON parse failed, falling back to text search:', raw.slice(0, 200));
    const blocked = /SCOPE_STATUS\s*:\s*BLOCKED/i.test(raw) || /"scope_status"\s*:\s*"BLOCKED"/i.test(raw);
    return { output: raw, blocked };
  }

  const blocked = (parsed.scope_status || '').toUpperCase() === 'BLOCKED';
  const output = `SCOPE_STATUS: ${parsed.scope_status}\nReason: ${parsed.reason}\nAttack Surface: ${parsed.attack_surface}\nRecommended Approach: ${parsed.recommended_approach}`;

  return { output, blocked, structured: parsed };
}

async function runReconStage(client, payload, signal) {
  const { target, scope, objective, severity, scopeOutput } = payload;

  const userMsg = `Scope Validator output:
${scopeOutput}

Target: ${target}
In-scope paths: ${scope || 'Full domain'}
Objective: ${objective || 'General vulnerability assessment'}
Focus severity: ${severity}

Identify likely vulnerabilities and produce structured findings as JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: RECON_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  }, { signal });

  console.log(`[BugBounty:recon] tokens in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  const raw = response.content[0]?.text || '';
  let structured;
  try {
    structured = JSON.parse(raw);
  } catch {
    console.warn('[BugBounty:recon] JSON parse failed');
    return { output: raw };
  }

  // Human-readable summary for the UI card
  const summary = (structured.findings || []).map(f =>
    `[${f.id}] ${f.title} — ${f.severity.toUpperCase()} (${f.confidence})\n  ${f.vuln_class} @ ${f.location}`
  ).join('\n\n');

  return { output: summary || raw, structured };
}

async function runFixStage(client, payload, signal) {
  const { reconOutput, reconStructured } = payload;

  const userMsg = `Bug Finder findings:
${reconStructured ? JSON.stringify(reconStructured, null, 2) : reconOutput}

Produce remediation recommendations for each finding as JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: FIX_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  }, { signal });

  console.log(`[BugBounty:fix] tokens in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  const raw = response.content[0]?.text || '';
  let structured;
  try {
    structured = JSON.parse(raw);
  } catch {
    console.warn('[BugBounty:fix] JSON parse failed');
    return { output: raw };
  }

  const summary = (structured.remediations || []).map(r =>
    `[${r.finding_id}] ${r.fix}\n  Verify: ${r.verification}`
  ).join('\n\n');

  return { output: summary || raw, structured };
}

async function runReportStage(client, payload, signal) {
  const { target, severity, progLevel, scopeOutput, reconOutput, fixOutput,
          reconStructured, fixStructured } = payload;

  const today = new Date().toISOString().split('T')[0];

  const userMsg = `Generate a complete disclosure report for:

Target: ${target}
Date: ${today}
Severity focus: ${severity}
Report level: ${progLevel}

SCOPE ASSESSMENT:
${scopeOutput}

FINDINGS:
${reconStructured ? JSON.stringify(reconStructured, null, 2) : reconOutput}

REMEDIATIONS:
${fixStructured ? JSON.stringify(fixStructured, null, 2) : fixOutput}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: REPORT_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  }, { signal });

  console.log(`[BugBounty:report] tokens in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);

  return { output: response.content[0]?.text || '' };
}

// ─── Registration ─────────────────────────────────────────────────────────────

function registerBugBountyHandlers(ipcMain) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  ipcMain.handle('bugbounty:abort', () => {
    if (_currentAbortController) {
      _currentAbortController.abort();
      _currentAbortController = null;
      console.log('[BugBounty] Aborted in-flight request.');
    }
  });

  ipcMain.handle('bugbounty:run', async (_event, payload) => {
    const { stage } = payload;

    _currentAbortController = new AbortController();
    const { signal } = _currentAbortController;

    try {
      switch (stage) {
        case 'scope':  return await runScopeStage(client, payload, signal);
        case 'recon':  return await runReconStage(client, payload, signal);
        case 'fix':    return await runFixStage(client, payload, signal);
        case 'report': return await runReportStage(client, payload, signal);
        default:
          return { error: `Unknown stage: ${stage}` };
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        return { error: 'Aborted.' };
      }
      console.error(`[BugBounty:${stage}]`, err.message);
      return { error: err.message || 'Unknown error' };
    } finally {
      _currentAbortController = null;
    }
  });

  console.log('[BugBounty] Handlers registered.');
}

module.exports = { registerBugBountyHandlers };
