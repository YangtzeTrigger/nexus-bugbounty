/**
 * BugBountyTab.jsx
 * Nexus — Harmonic Command
 * Bug Bounty Pipeline Tab — 4-stage agent pipeline
 *
 * Drop into: src/components/tabs/BugBountyTab.jsx
 * Add to sidebar nav with tab key: 'bugbounty'
 */

import { useState, useRef, useEffect } from 'react';

// ─── Nexus Design Tokens ─────────────────────────────────────────────────────
const C = {
  obsidian:   '#0E1016',
  surface:    '#13151C',
  panel:      '#1A1D27',
  border:     '#252836',
  borderHi:   '#2E3347',
  cyan:       '#22D3EE',
  cyanDim:    '#0E6B7A',
  violet:     '#6366F1',
  violetDim:  '#2D2F6B',
  amber:      '#F59E0B',
  amberDim:   '#6B4500',
  emerald:    '#10B981',
  emeraldDim: '#064E3B',
  red:        '#EF4444',
  redDim:     '#450A0A',
  textPrimary:'#E8EAED',
  textSub:    '#8B92A5',
  textMuted:  '#4B5268',
};

// ─── Pipeline Stage Definitions ──────────────────────────────────────────────
const STAGES = [
  {
    id: 'scope',
    label: 'Scope Validator',
    short: 'SCOPE',
    icon: '⬡',
    color: C.violet,
    dimColor: C.violetDim,
    desc: 'Validates target legitimacy and attack surface',
  },
  {
    id: 'recon',
    label: 'Bug Finder',
    short: 'RECON',
    icon: '◈',
    color: C.cyan,
    dimColor: C.cyanDim,
    desc: 'Identifies vulnerabilities within scope',
  },
  {
    id: 'fix',
    label: 'Fix Suggester',
    short: 'FIX',
    icon: '◆',
    color: C.amber,
    dimColor: C.amberDim,
    desc: 'Proposes remediations for findings',
  },
  {
    id: 'report',
    label: 'Reporter',
    short: 'REPORT',
    icon: '◉',
    color: C.emerald,
    dimColor: C.emeraldDim,
    desc: 'Generates structured disclosure report',
  },
];

const STATUS = { idle: 'idle', running: 'running', done: 'done', error: 'error', skipped: 'skipped' };

// ─── Styles ───────────────────────────────────────────────────────────────────
const sx = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: C.obsidian,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    color: C.textPrimary,
    overflow: 'hidden',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: `1px solid ${C.border}`,
    background: C.surface,
    flexShrink: 0,
  },
  topBarTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: C.cyan,
    textTransform: 'uppercase',
  },
  topBarSub: {
    fontSize: 10,
    color: C.textMuted,
    letterSpacing: '0.1em',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  // ── Left config panel ──
  configPanel: {
    width: 300,
    flexShrink: 0,
    borderRight: `1px solid ${C.border}`,
    background: C.surface,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  configInner: {
    padding: 16,
    overflowY: 'auto',
    flex: 1,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.16em',
    color: C.textMuted,
    textTransform: 'uppercase',
    marginBottom: 6,
    display: 'block',
  },
  input: {
    width: '100%',
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '8px 10px',
    fontSize: 11,
    color: C.textPrimary,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  },
  textarea: {
    width: '100%',
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '8px 10px',
    fontSize: 11,
    color: C.textPrimary,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 72,
    transition: 'border-color 0.15s',
  },
  select: {
    width: '100%',
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '8px 10px',
    fontSize: 11,
    color: C.textPrimary,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    cursor: 'pointer',
  },
  sectionDivider: {
    borderTop: `1px solid ${C.border}`,
    margin: '12px 0',
  },
  // ── Pipeline stages ──
  stageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 4,
    marginBottom: 4,
    background: C.panel,
    border: `1px solid ${C.border}`,
    fontSize: 10,
    transition: 'border-color 0.2s, background 0.2s',
  },
  stageBadge: {
    width: 20,
    height: 20,
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    flexShrink: 0,
  },
  stageLabel: {
    flex: 1,
    fontSize: 10,
    color: C.textSub,
    letterSpacing: '0.04em',
  },
  stageStatus: {
    fontSize: 9,
    letterSpacing: '0.08em',
    fontWeight: 700,
  },
  // ── Run button ──
  runBtn: {
    margin: 16,
    padding: '10px 0',
    background: `linear-gradient(135deg, ${C.cyan}22, ${C.violet}22)`,
    border: `1px solid ${C.cyan}`,
    borderRadius: 4,
    color: C.cyan,
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'background 0.2s, box-shadow 0.2s',
    flexShrink: 0,
  },
  stopBtn: {
    margin: '0 16px 16px',
    padding: '8px 0',
    background: `${C.red}22`,
    border: `1px solid ${C.red}`,
    borderRadius: 4,
    color: C.red,
    fontFamily: 'inherit',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    cursor: 'pointer',
  },
  // ── Right output panel ──
  outputPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  outputTabs: {
    display: 'flex',
    borderBottom: `1px solid ${C.border}`,
    background: C.surface,
    flexShrink: 0,
  },
  outputTab: {
    padding: '10px 16px',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit',
    transition: 'color 0.15s',
    borderBottom: '2px solid transparent',
  },
  outputBody: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  // ── Pipeline view ──
  pipelineView: {
    flex: 1,
    overflowY: 'auto',
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  agentCard: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    overflow: 'hidden',
  },
  agentCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  agentCardIcon: {
    fontSize: 16,
    width: 24,
    textAlign: 'center',
    flexShrink: 0,
  },
  agentCardTitle: {
    flex: 1,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
  },
  agentCardBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.12em',
    padding: '2px 6px',
    borderRadius: 3,
    textTransform: 'uppercase',
  },
  agentCardBody: {
    padding: '0 14px 12px',
    borderTop: `1px solid ${C.border}`,
    fontSize: 11,
    lineHeight: 1.7,
    color: C.textSub,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 320,
    overflowY: 'auto',
  },
  thinkingDots: {
    display: 'inline-flex',
    gap: 4,
    padding: '12px 0',
  },
  // ── Report view ──
  reportView: {
    flex: 1,
    overflowY: 'auto',
    padding: 20,
  },
  reportBox: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 20,
    fontSize: 11,
    lineHeight: 1.8,
    color: C.textSub,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  copyBtn: {
    marginTop: 12,
    padding: '7px 14px',
    background: `${C.emerald}22`,
    border: `1px solid ${C.emerald}`,
    borderRadius: 4,
    color: C.emerald,
    fontFamily: 'inherit',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    cursor: 'pointer',
  },
  // ── Empty state ──
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    color: C.textMuted,
    padding: 40,
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8,
    opacity: 0.4,
  },
  emptyTitle: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: C.textMuted,
  },
  emptyDesc: {
    fontSize: 10,
    letterSpacing: '0.05em',
    textAlign: 'center',
    maxWidth: 260,
    lineHeight: 1.6,
  },
};

// ─── Dot Loader ───────────────────────────────────────────────────────────────
function ThinkingDots({ color }) {
  return (
    <span style={sx.thinkingDots}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: 5, height: 5, borderRadius: '50%',
            background: color,
            animation: `bb-pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ─── Stage Status Badge ───────────────────────────────────────────────────────
function StageBadge({ status, color }) {
  const map = {
    idle:    { label: 'IDLE',    bg: C.panel,      fg: C.textMuted },
    running: { label: 'ACTIVE',  bg: `${color}22`, fg: color       },
    done:    { label: 'DONE',    bg: `${C.emerald}22`, fg: C.emerald },
    error:   { label: 'ERROR',   bg: `${C.red}22`, fg: C.red       },
    skipped: { label: 'SKIP',    bg: C.panel,      fg: C.textMuted },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{ ...sx.stageStatus, background: s.bg, color: s.fg,
      padding: '2px 6px', borderRadius: 3 }}>
      {s.label}
    </span>
  );
}

// ─── Agent Card ───────────────────────────────────────────────────────────────
function AgentCard({ stage, status, output, expanded, onToggle }) {
  const isRunning = status === STATUS.running;
  const borderColor = status === STATUS.running ? stage.color
    : status === STATUS.done ? C.emerald
    : status === STATUS.error ? C.red
    : C.border;

  return (
    <div style={{ ...sx.agentCard, borderColor }}>
      <div style={sx.agentCardHeader} onClick={onToggle}>
        <span style={{ ...sx.agentCardIcon, color: stage.color }}>{stage.icon}</span>
        <span style={{ ...sx.agentCardTitle, color: status === STATUS.idle ? C.textMuted : C.textPrimary }}>
          {stage.label}
        </span>
        <StageBadge status={status} color={stage.color} />
        <span style={{ color: C.textMuted, fontSize: 10, marginLeft: 6 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div style={sx.agentCardBody}>
          {isRunning && !output && <ThinkingDots color={stage.color} />}
          {output
            ? <span style={{ color: C.textSub }}>{output}</span>
            : !isRunning && <span style={{ color: C.textMuted, fontSize: 10 }}>{stage.desc}</span>
          }
          {isRunning && output && <ThinkingDots color={stage.color} />}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function BugBountyTab() {
  const [target, setTarget]       = useState('');
  const [scope, setScope]         = useState('');
  const [objective, setObjective] = useState('');
  const [severity, setSeverity]   = useState('medium');
  const [progLevel, setProgLevel] = useState('intermediate');

  const [stageStatus, setStageStatus] = useState({
    scope: STATUS.idle, recon: STATUS.idle,
    fix: STATUS.idle, report: STATUS.idle,
  });
  const [stageOutput, setStageOutput] = useState({
    scope: '', recon: '', fix: '', report: '',
  });
  const [expanded, setExpanded] = useState({
    scope: true, recon: true, fix: true, report: true,
  });

  const [running, setRunning]   = useState(false);
  const [activeOutputTab, setActiveOutputTab] = useState('pipeline');
  const [reportText, setReportText] = useState('');
  const [copied, setCopied]     = useState(false);
  const abortRef = useRef(false);

  // CSS animation injection
  useEffect(() => {
    const id = 'bb-keyframes';
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `
        @keyframes bb-pulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        .bb-run-btn:hover { box-shadow: 0 0 16px ${C.cyan}44; }
        .bb-input:focus { border-color: ${C.cyan}88 !important; }
        .bb-textarea:focus { border-color: ${C.cyan}88 !important; }
        .bb-select:focus { border-color: ${C.cyan}88 !important; }
        .bb-output-tab-active { color: ${C.cyan} !important; border-bottom-color: ${C.cyan} !important; }
        .bb-output-tab-inactive { color: #4B5268; }
        .bb-output-tab-inactive:hover { color: #8B92A5; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  const resetStages = () => {
    setStageStatus({ scope: STATUS.idle, recon: STATUS.idle, fix: STATUS.idle, report: STATUS.idle });
    setStageOutput({ scope: '', recon: '', fix: '', report: '' });
    setReportText('');
  };

  const setStage = (id, status, output) => {
    setStageStatus(p => ({ ...p, [id]: status }));
    if (output !== undefined) setStageOutput(p => ({ ...p, [id]: output }));
  };

  const handleRun = async () => {
    if (!target.trim()) return;
    abortRef.current = false;
    setRunning(true);
    setActiveOutputTab('pipeline');
    resetStages();

    const payload = {
      target: target.trim(),
      scope: scope.trim(),
      objective: objective.trim(),
      severity,
      progLevel,
    };

    try {
      // ── Stage 1: Scope Validator ──────────────────────────────────────────
      setStage('scope', STATUS.running);
      const scopeResult = await window.nexus.invoke('bugbounty:run', {
        stage: 'scope', ...payload,
      });
      if (abortRef.current) return;
      if (scopeResult.error) { setStage('scope', STATUS.error, scopeResult.error); setRunning(false); return; }
      setStage('scope', STATUS.done, scopeResult.output);

      // Bail if scope validator rejects
      if (scopeResult.blocked) {
        setStage('recon', STATUS.skipped);
        setStage('fix', STATUS.skipped);
        setStage('report', STATUS.skipped);
        setRunning(false);
        return;
      }

      // ── Stage 2: Bug Finder ───────────────────────────────────────────────
      setStage('recon', STATUS.running);
      const reconResult = await window.nexus.invoke('bugbounty:run', {
        stage: 'recon', scopeOutput: scopeResult.output, ...payload,
      });
      if (abortRef.current) return;
      if (reconResult.error) { setStage('recon', STATUS.error, reconResult.error); setRunning(false); return; }
      setStage('recon', STATUS.done, reconResult.output);

      // ── Stage 3: Fix Suggester ────────────────────────────────────────────
      setStage('fix', STATUS.running);
      const fixResult = await window.nexus.invoke('bugbounty:run', {
        stage: 'fix',
        scopeOutput: scopeResult.output,
        reconOutput: reconResult.output,
        reconStructured: reconResult.structured || null,
        ...payload,
      });
      if (abortRef.current) return;
      if (fixResult.error) { setStage('fix', STATUS.error, fixResult.error); setRunning(false); return; }
      setStage('fix', STATUS.done, fixResult.output);

      // ── Stage 4: Reporter ─────────────────────────────────────────────────
      setStage('report', STATUS.running);
      const reportResult = await window.nexus.invoke('bugbounty:run', {
        stage: 'report',
        scopeOutput: scopeResult.output,
        reconOutput: reconResult.output,
        fixOutput: fixResult.output,
        reconStructured: reconResult.structured || null,
        fixStructured: fixResult.structured || null,
        ...payload,
      });
      if (abortRef.current) return;
      if (reportResult.error) { setStage('report', STATUS.error, reportResult.error); setRunning(false); return; }
      setStage('report', STATUS.done, reportResult.output);
      setReportText(reportResult.output);
      setActiveOutputTab('report');

    } catch (err) {
      console.error('[BugBounty]', err);
    } finally {
      if (!abortRef.current) setRunning(false);
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    setRunning(false);
    // Signal main process to cancel any in-flight Anthropic request
    window.nexus.invoke('bugbounty:abort', {});
    setStageStatus(prev => {
      const next = { ...prev };
      STAGES.forEach(s => {
        if (prev[s.id] === STATUS.running) next[s.id] = STATUS.error;
      });
      return next;
    });
    setStageOutput(prev => {
      const next = { ...prev };
      STAGES.forEach(s => {
        if (stageStatus[s.id] === STATUS.running) next[s.id] = 'Aborted by user.';
      });
      return next;
    });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(reportText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const anyDone = Object.values(stageStatus).some(s => s === STATUS.done);

  return (
    <div style={sx.root}>
      {/* Top bar */}
      <div style={sx.topBar}>
        <div>
          <div style={sx.topBarTitle}>◈ Bug Bounty Pipeline</div>
          <div style={sx.topBarSub}>4-stage agent pipeline — scope · recon · fix · report</div>
        </div>
        <div style={{ fontSize: 9, color: C.textMuted, letterSpacing: '0.12em' }}>
          NEXUS / HARMONIC COMMAND
        </div>
      </div>

      <div style={sx.body}>
        {/* ── Config panel ── */}
        <div style={sx.configPanel}>
          <div style={sx.configInner}>
            {/* Target */}
            <div style={sx.fieldGroup}>
              <label style={sx.label}>Target</label>
              <input
                className="bb-input"
                style={sx.input}
                placeholder="https://target.example.com"
                value={target}
                onChange={e => setTarget(e.target.value)}
                disabled={running}
              />
            </div>

            {/* Scope */}
            <div style={sx.fieldGroup}>
              <label style={sx.label}>In-Scope Paths / Notes</label>
              <textarea
                className="bb-textarea"
                style={sx.textarea}
                placeholder={`/api/*\n/auth/*\n# Out of scope: /admin`}
                value={scope}
                onChange={e => setScope(e.target.value)}
                disabled={running}
                rows={4}
              />
            </div>

            {/* Objective */}
            <div style={sx.fieldGroup}>
              <label style={sx.label}>Objective</label>
              <textarea
                className="bb-textarea"
                style={sx.textarea}
                placeholder="Find auth bypass vulnerabilities in the login flow"
                value={objective}
                onChange={e => setObjective(e.target.value)}
                disabled={running}
                rows={3}
              />
            </div>

            <div style={sx.sectionDivider} />

            {/* Severity + Level */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={sx.label}>Target Severity</label>
                <select className="bb-select" style={sx.select} value={severity}
                  onChange={e => setSeverity(e.target.value)} disabled={running}>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={sx.label}>Report Level</label>
                <select className="bb-select" style={sx.select} value={progLevel}
                  onChange={e => setProgLevel(e.target.value)} disabled={running}>
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="expert">Expert</option>
                </select>
              </div>
            </div>

            <div style={sx.sectionDivider} />

            {/* Stage indicators */}
            <label style={sx.label}>Pipeline Stages</label>
            {STAGES.map(stage => (
              <div key={stage.id}
                style={{
                  ...sx.stageRow,
                  borderColor: stageStatus[stage.id] === STATUS.running
                    ? stage.color
                    : stageStatus[stage.id] === STATUS.done
                    ? `${C.emerald}66`
                    : C.border,
                }}>
                <div style={{
                  ...sx.stageBadge,
                  background: stageStatus[stage.id] === STATUS.idle ? C.panel : `${stage.color}22`,
                  color: stageStatus[stage.id] === STATUS.idle ? C.textMuted : stage.color,
                }}>
                  {stage.icon}
                </div>
                <span style={sx.stageLabel}>{stage.label}</span>
                <StageBadge status={stageStatus[stage.id]} color={stage.color} />
              </div>
            ))}
          </div>

          {/* Run / Stop button */}
          {running ? (
            <button style={sx.stopBtn} onClick={handleStop}>
              ■ Abort Pipeline
            </button>
          ) : (
            <button
              className="bb-run-btn"
              style={{
                ...sx.runBtn,
                opacity: target.trim() ? 1 : 0.4,
                cursor: target.trim() ? 'pointer' : 'not-allowed',
              }}
              onClick={handleRun}
              disabled={!target.trim()}
            >
              ▶ Run Pipeline
            </button>
          )}
        </div>

        {/* ── Output panel ── */}
        <div style={sx.outputPanel}>
          <div style={sx.outputTabs}>
            {['pipeline', 'report'].map(tab => (
              <button
                key={tab}
                className={activeOutputTab === tab ? 'bb-output-tab-active' : 'bb-output-tab-inactive'}
                style={sx.outputTab}
                onClick={() => setActiveOutputTab(tab)}
              >
                {tab === 'pipeline' ? '◈ Pipeline' : '◉ Report'}
              </button>
            ))}
          </div>

          <div style={sx.outputBody}>
            {/* Pipeline tab */}
            {activeOutputTab === 'pipeline' && (
              !anyDone && !running ? (
                <div style={sx.emptyState}>
                  <div style={sx.emptyIcon}>◈</div>
                  <div style={sx.emptyTitle}>Pipeline Idle</div>
                  <div style={sx.emptyDesc}>
                    Enter a target and objective, then run the pipeline.
                    Agents will execute in sequence: Scope → Recon → Fix → Report.
                  </div>
                </div>
              ) : (
                <div style={sx.pipelineView}>
                  {STAGES.map(stage => (
                    <AgentCard
                      key={stage.id}
                      stage={stage}
                      status={stageStatus[stage.id]}
                      output={stageOutput[stage.id]}
                      expanded={expanded[stage.id]}
                      onToggle={() => setExpanded(p => ({ ...p, [stage.id]: !p[stage.id] }))}
                    />
                  ))}
                </div>
              )
            )}

            {/* Report tab */}
            {activeOutputTab === 'report' && (
              !reportText ? (
                <div style={sx.emptyState}>
                  <div style={sx.emptyIcon}>◉</div>
                  <div style={sx.emptyTitle}>No Report Yet</div>
                  <div style={sx.emptyDesc}>
                    Run the pipeline to completion to generate a structured disclosure report.
                  </div>
                </div>
              ) : (
                <div style={sx.reportView}>
                  <div style={sx.reportBox}>{reportText}</div>
                  <button style={sx.copyBtn} onClick={handleCopy}>
                    {copied ? '✓ Copied' : '⧉ Copy Report'}
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
