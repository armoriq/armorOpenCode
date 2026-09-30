import json
from typing import Optional


def render_json(report: dict) -> str:
    return json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"


def _number(value: Optional[int]) -> str:
    return "unknown" if value is None else format(value, ",")


def _table(headers, rows) -> str:
    values = [["".join(character if ord(character) >= 32 and ord(character) != 127 else " " for character in str(value)) for value in row] for row in [headers] + list(rows)]
    widths = [max(len(row[index]) for row in values) for index in range(len(headers))]
    return "\n".join("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)) for row in values)


def render_table(report: dict) -> str:
    overview = report["overview"]
    budget = overview["budget"]
    lines = ["ArmorIQ / OpenCode telemetry", "",
             "Sessions " + _number(overview["sessions"]) + "  Models " + str(len(report["models"])) + "  Steps " + _number(overview["steps"]),
             "Tokens " + _number(overview["tokens"]) + "  Tool calls " + _number(overview["toolCalls"]),
             "Components  " + "  ".join(key + "=" + _number(value) for key, value in overview["breakdown"].items()),
             "Total budget  actual=" + _number(budget["actual"]) + " limit=" + _number(budget["limit"]) + " remaining=" + _number(budget["remaining"]) + " status=" + budget["status"],
             "Inherited history  messages=" + str(overview["inheritedMessages"]) + " tools=" + str(overview["inheritedToolCalls"]) + " tokens=" + _number(overview["inheritedTokens"]), "", "Models",
             _table(["Provider/model", "Family", "Tokens", "Tools", "Errors"],
                    [(row["id"], row["family"], _number(row["tokens"]), row["toolCalls"], row["toolOutcomes"]["error"]) for row in report["models"]]),
             "", "Sessions",
             _table(["Session ID", "Tokens", "Tools", "Target", "Remaining", "Budget"],
                    [(row["id"], _number(row["tokens"]), row["toolCalls"], _number(row["budget"]["limit"]), _number(row["budget"]["remaining"]), row["budget"]["status"]) for row in report["sessions"]]),
             "", "Daily usage (" + report["metadata"]["timezone"] + ")",
             _table(["Date", "Tokens", "Tools"], [(row["date"], _number(row["tokens"]), row["toolCalls"]) for row in report["days"]]),
             "", "Tools",
             _table(["Tool", "Calls", "Completed", "Error", "Running", "Pending", "Unknown"],
                    [(row["name"], row["calls"], *[row["outcomes"][key] for key in ("completed", "error", "running", "pending", "unknown")]) for row in report["tools"]]),
             "", report["metadata"]["notice"]]
    if overview["missingUsageSteps"]:
        lines.append("Incomplete usage  " + str(overview["missingUsageSteps"]) + " steps; known tokens=" + _number(overview["knownTokens"]))
    if report["diagnostics"]:
        from collections import Counter
        lines.append("Diagnostics  " + "  ".join(key + "=" + str(value) for key, value in sorted(Counter(item["code"] for item in report["diagnostics"]).items())))
    return "\n".join(lines) + "\n"


def render_trace(report: dict, session_id: str) -> str:
    trace = next((row for row in report["traces"] if row["sessionID"] == session_id), None)
    if trace is None:
        return "No retained telemetry matches this session and filter.\n"
    lines = ["Session " + session_id, "", "Usage steps",
             _table(["Step ID", "Model", "Tokens", "Basis", "Inherited"],
                    [(row["id"], row["model"], _number(row["tokens"]), row["basis"], row["inherited"]) for row in trace["steps"]]),
             "", "Tool calls",
             _table(["Tool", "Outcome", "Duration ms", "Model", "Inherited"],
                    [(row["name"], row["status"], _number(row["durationMs"]), row["model"], row["inherited"]) for row in trace["tools"]]),
             "", "Per-tool token attribution is unavailable. Trace contains metadata only."]
    return "\n".join(lines) + "\n"


def render_html(report: dict) -> str:
    payload = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    for character, escaped in (("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"), ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        payload = payload.replace(character, escaped)
    return _HTML.replace("__TELEMETRY_DATA__", payload)


_HTML = r'''<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>ArmorIQ | OpenCode telemetry</title>
<style>
:root{--bg:#0b1014;--panel:#121a20;--raised:#18232b;--line:#28343d;--text:#eef4f7;--muted:#99aab6;--accent:#c6f178;--orange:#f6bb79;--red:#ff9292;--shadow:0 8px 30px #0002}html[data-theme=light]{--bg:#f4f6f1;--panel:#fff;--raised:#eef3e8;--line:#dce3d5;--text:#1a2822;--muted:#627468;--accent:#426d16;--orange:#925216;--red:#b13737;--shadow:0 8px 30px #182b1108}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit;color:inherit}button,select{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}header{display:flex;align-items:center;justify-content:space-between;padding:24px 4vw;border-bottom:1px solid var(--line);gap:20px}.brand{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:750;letter-spacing:-.6px}.mark{background:var(--accent);color:var(--bg);display:grid;place-items:center;width:32px;height:36px;clip-path:polygon(0 0,100% 0,100% 70%,50% 100%,0 70%)}.brand small{font-weight:450;font-size:13px;color:var(--muted);letter-spacing:0;border-left:1px solid var(--line);padding-left:14px;margin-left:5px}.actions{display:flex;gap:8px}.button{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 13px}main{max-width:1500px;margin:auto;padding:38px 4vw 28px}.eyebrow{font-size:11px;letter-spacing:1.8px;text-transform:uppercase;color:var(--accent);font-weight:700}h1{font-size:34px;letter-spacing:-1.2px;margin:10px 0}h2{font-size:17px;margin:0;letter-spacing:-.3px}p{color:var(--muted);line-height:1.6}.intro{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:25px}.intro p{margin:8px 0}.stamp{font:11px ui-monospace,monospace;color:var(--muted);white-space:nowrap;margin-bottom:10px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.card{padding:21px}.label{color:var(--muted);font-size:12px}.value{font-size:29px;font-weight:650;letter-spacing:-1px;margin:10px 0}.sub{color:var(--muted);font-size:11px;line-height:1.6}.accent{color:var(--accent)}.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:22px}.toolbar input{flex:1;min-width:0}.toolbar input,.toolbar select{padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.toolbar label{font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:1.3fr 1fr;gap:20px;margin-bottom:20px}.panel{overflow:hidden}.panel-head{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:20px 22px;border-bottom:1px solid var(--line)}.panel-head span{color:var(--muted);font-size:11px}.scroll{overflow:auto;max-height:370px}table{border-collapse:collapse;width:100%;text-align:left;font-size:12px}th{color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;padding:14px 22px;background:var(--panel);position:sticky;top:0}td{padding:15px 22px;border-top:1px solid var(--line);vertical-align:top}td small{display:block;color:var(--muted);font-size:10px;margin-top:5px;max-width:260px;overflow-wrap:anywhere}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:4px;padding:3px 7px;background:var(--raised);font-size:10px;color:var(--muted)}.badge.completed,.badge.within{color:var(--accent)}.badge.error,.badge.exceeded{color:var(--red)}.badge.running,.badge.pending,.badge.incomplete{color:var(--orange)}.clickable{cursor:pointer}.clickable:hover,.selected{background:var(--raised)}.chart{display:flex;align-items:end;gap:5px;height:130px;padding:18px 22px 0;overflow-x:auto}.bar-wrap{display:flex;flex-direction:column;justify-content:end;align-items:center;min-width:22px;flex:1;height:100%;gap:8px}.bar{width:100%;max-width:44px;min-height:2px;background:var(--accent);border-radius:4px 4px 0 0;opacity:.8}.bar-label{font-size:8px;color:var(--muted);height:17px;white-space:nowrap}.breakdown{display:flex;flex-wrap:wrap;gap:20px;padding:18px 22px;border-top:1px solid var(--line);margin-top:16px}.breakdown strong{display:block;margin-top:5px;font-weight:550;font-variant-numeric:tabular-nums}.empty{padding:24px;color:var(--muted);font-size:12px;line-height:1.6}.trace{max-height:460px;overflow:auto;padding:0 22px}.event{padding:16px 0;border-bottom:1px solid var(--line);display:flex;gap:12px}.event-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);margin-top:6px;flex-shrink:0}.event.tool .event-dot{background:var(--muted)}.event-body{flex:1;min-width:0}.event-title{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font-size:12px}.event-meta{font-size:10px;color:var(--muted);line-height:1.8;overflow-wrap:anywhere;margin-top:6px}.event-value{font-size:11px;white-space:nowrap}.notice{font-size:11px;border-top:1px solid var(--line);padding-top:20px;margin:24px 0 0;line-height:1.8;color:var(--muted)}details{margin-top:16px;color:var(--muted);font-size:11px}summary{cursor:pointer}.diagnostics{max-height:160px;overflow:auto;line-height:1.8;margin-top:8px}.tool-list{padding:5px 22px}.tool-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.tool-name{font-family:ui-monospace,monospace;font-size:11px}.tool-outcome{color:var(--muted);font-size:10px;text-align:right}@media(max-width:900px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.stamp{display:none}}@media(max-width:520px){header{padding:18px}.brand small{display:none}main{padding:25px 18px}.metrics{gap:9px}.card{padding:15px}.value{font-size:23px}.toolbar{flex-wrap:wrap}.toolbar input{flex-basis:100%}.toolbar select{flex:1}h1{font-size:27px}th,td{padding:12px 15px}.button{padding:8px;font-size:11px}}
.toolbar{display:grid;grid-template-columns:auto minmax(160px,1fr) auto minmax(180px,1.3fr)}
.toolbar label{white-space:nowrap}
.toolbar input,.toolbar select{width:100%;min-width:0}
#scope{grid-column:1/-1;text-align:right}
@media(max-width:650px){.toolbar{grid-template-columns:auto minmax(0,1fr)}}
</style></head><body><header><div class="brand"><div class="mark">A</div>ArmorIQ<small>OpenCode telemetry</small></div><div class="actions"><button class="button" id="export" title="Exports the full generated report before browser filters">Export full report</button><button class="button" id="theme" aria-label="Switch to light theme">Light theme</button></div></header>
<main><div class="intro"><div><div class="eyebrow">Local observability / v1</div><h1>Know where your tokens go.</h1><p>All your models. Every retained session. A clear view of tool activity.</p></div><div class="stamp" id="stamp"></div></div>
<div class="metrics" id="metrics"></div><div class="toolbar"><label for="search">Find a session</label><input id="search" type="search" placeholder="Search session ID or tool name"><label for="model">Model</label><select id="model"><option value="">All models</option></select><span class="sub" id="scope"></span></div>
<div class="grid"><section class="panel"><div class="panel-head"><h2>Model usage</h2><span id="component-label">Normalized token components</span></div><div class="scroll"><table><thead><tr><th>Model</th><th>Tokens</th><th>Tools</th><th>Errors</th></tr></thead><tbody id="models"></tbody></table></div></section><section class="panel"><div class="panel-head"><h2>Daily activity</h2><span id="zone"></span></div><div class="chart" id="chart"></div><div class="breakdown" id="breakdown"></div></section></div>
<div class="grid"><section class="panel"><div class="panel-head"><h2>Sessions</h2><span>Select a session to inspect its trace</span></div><div class="scroll"><table><thead><tr><th>Session</th><th>Tokens</th><th>Tools</th><th>Budget</th></tr></thead><tbody id="sessions"></tbody></table></div></section><section class="panel"><div class="panel-head"><h2>Session trace</h2><span id="trace-label">Metadata only</span></div><div class="trace" id="trace"></div></section></div>
<section class="panel"><div class="panel-head"><h2>Tool activity</h2><span>Per-tool token usage unavailable</span></div><div class="tool-list" id="tools"></div></section><details id="diagnostic-details"><summary id="diagnostic-summary"></summary><div class="diagnostics" id="diagnostics"></div></details><p class="notice" id="notice"></p></main>
<script id="telemetry-data" type="application/json">__TELEMETRY_DATA__</script>
<script>
'use strict';

const report = JSON.parse(document.getElementById('telemetry-data').textContent);
const byId = id => document.getElementById(id);
const num = value => value === null || value === undefined ? 'Unknown' : Number(value).toLocaleString();
let selected = null;
let current = [];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function badge(value) {
  return el('span', value, 'badge ' + value);
}

function budget(actual, limit) {
  return {
    actual,
    limit,
    remaining: actual === null || limit === null ? null : limit - actual,
    status: limit === null ? 'unconfigured' : actual === null ? 'incomplete' : actual > limit ? 'exceeded' : 'within'
  };
}

function targetDescription(target) {
  if (target.status === 'unconfigured') return 'Target not set';
  if (target.status === 'incomplete') return 'Actual usage incomplete';
  if (target.remaining < 0) return num(-target.remaining) + ' over target';
  return num(target.remaining) + ' remaining';
}

function aggregate(steps, tools) {
  const activeSteps = steps.filter(step => !step.inherited);
  const activeTools = tools.filter(tool => !tool.inherited);
  let tokens = 0;
  let missing = 0;
  const breakdown = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  activeSteps.forEach(step => {
    if (step.tokens === null) missing++;
    else tokens += step.tokens;
    if (step.breakdown) {
      Object.keys(breakdown).forEach(key => breakdown[key] += step.breakdown[key] || 0);
    }
  });
  return {
    tokens: missing || !report.metadata.scanComplete ? null : tokens,
    knownTokens: tokens,
    missing,
    breakdown,
    steps: activeSteps.length,
    tools: activeTools.length,
    errors: activeTools.filter(tool => tool.status === 'error').length
  };
}

function tracesFor(session) {
  return report.traces.find(trace => trace.sessionID === session.id) || { steps: [], tools: [] };
}

function day(milliseconds) {
  if (milliseconds === null) return 'unknown';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: report.metadata.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(milliseconds));
  } catch {
    return 'unknown';
  }
}

function emptyTable(body, text, columns) {
  const row = el('tr');
  const cell = el('td', text, 'empty');
  cell.colSpan = columns;
  row.append(cell);
  body.append(row);
}

function renderMetrics(steps, tools) {
  const totals = aggregate(steps, tools);
  const totalBudget = budget(totals.tokens, report.overview.budget.limit);
  const inProgress = tools.filter(tool => !tool.inherited && ['running', 'pending'].includes(tool.status)).length;
  const modelCount = new Set(steps.map(step => step.model).concat(tools.map(tool => tool.model))).size;
  let tokenDescription = 'Input + output + reasoning + cache';
  if (!report.metadata.scanComplete) {
    tokenDescription = num(totals.knownTokens) + ' known · source scan incomplete';
  } else if (totals.missing) {
    tokenDescription = num(totals.knownTokens) + ' known · ' + totals.missing + ' missing steps';
  }
  const cards = [
    ['Tokens used', num(totals.tokens), tokenDescription],
    [report.metadata.scanComplete ? 'Tool calls' : 'Known tool calls', num(totals.tools), report.metadata.scanComplete ? num(totals.errors) + ' errors · ' + num(inProgress) + ' in progress' : 'Source scan incomplete'],
    [report.metadata.scanComplete ? 'Retained sessions' : 'Known retained sessions', num(current.length), report.metadata.scanComplete ? num(modelCount) + ' models in this view' : 'Source scan incomplete'],
    ['Token target / current view', num(totalBudget.limit), targetDescription(totalBudget)]
  ];
  const target = byId('metrics');
  target.replaceChildren();
  cards.forEach(([label, value, description]) => {
    const card = el('div', undefined, 'card');
    card.append(
      el('div', label, 'label'),
      el('div', value, 'value' + (label === 'Tokens used' ? ' accent' : '')),
      el('div', description, 'sub')
    );
    target.append(card);
  });
  return totals;
}

function renderModels(steps, tools, modelFilter) {
  const target = byId('models');
  target.replaceChildren();
  report.models.filter(model => !modelFilter || model.id === modelFilter).forEach(model => {
    const ownSteps = steps.filter(step => step.model === model.id);
    const ownTools = tools.filter(tool => tool.model === model.id);
    if (!ownSteps.length && !ownTools.length) return;
    const summary = aggregate(ownSteps, ownTools);
    const row = el('tr');
    const name = el('td', model.displayName);
    name.append(el('small', model.id));
    row.append(name, el('td', num(summary.tokens)), el('td', num(summary.tools)), el('td', num(summary.errors)));
    target.append(row);
  });
  if (!target.children.length) emptyTable(target, 'No model usage matches this view.', 4);
}

function renderSessions() {
  const target = byId('sessions');
  target.replaceChildren();
  if (selected && !current.some(session => session.id === selected)) selected = null;
  current.forEach(session => {
    const row = el('tr', undefined, 'clickable' + (session.id === selected ? ' selected' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', 'Inspect session ' + session.id);
    const name = el('td', session.id, 'mono');
    const targetBudget = budget(session.summary.tokens, session.budget.limit);
    const budgetCell = el('td');
    name.append(el('small', session.models.join(', ')));
    if (session.inheritedMessages) {
      name.append(el('small', session.inheritedMessages + ' inherited messages · ' + num(session.inheritedTokens) + ' inherited tokens excluded'));
    }
    budgetCell.append(
      badge(targetBudget.status),
      el('small', targetBudget.limit === null ? 'Target not set' : num(targetBudget.actual) + ' / ' + num(targetBudget.limit) + ' · ' + targetDescription(targetBudget))
    );
    row.append(name, el('td', num(session.summary.tokens)), el('td', num(session.summary.tools)), budgetCell);
    const choose = () => {
      selected = session.id;
      render();
    };
    row.addEventListener('click', choose);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });
    target.append(row);
  });
  if (!current.length) emptyTable(target, 'No sessions match this view.', 4);
}

function renderChart(steps, totals) {
  const target = byId('chart');
  target.replaceChildren();
  const dates = new Map();
  steps.filter(step => !step.inherited).forEach(step => {
    const key = day(step.createdMs);
    dates.set(key, (dates.get(key) || 0) + (step.tokens || 0));
  });
  const maximum = Math.max(1, ...dates.values());
  [...dates].sort((a, b) => a[0].localeCompare(b[0])).forEach(([date, total]) => {
    const wrapper = el('div', undefined, 'bar-wrap');
    const bar = el('div', undefined, 'bar');
    bar.style.height = (total / maximum * 90) + 'px';
    bar.title = date + ' · ' + num(total) + ' known tokens';
    wrapper.append(bar, el('div', date === 'unknown' ? '?' : date.slice(5), 'bar-label'));
    target.append(wrapper);
  });
  if (!dates.size) target.append(el('div', 'No usage steps in this view.', 'empty'));
  const breakdown = byId('breakdown');
  breakdown.replaceChildren();
  Object.entries(totals.breakdown).forEach(([key, value]) => {
    const node = el('div', key.replace(/([A-Z])/g, ' $1'), 'label');
    node.append(el('strong', num(value)));
    breakdown.append(node);
  });
}

function renderTools(tools) {
  const target = byId('tools');
  target.replaceChildren();
  [...new Set(tools.map(tool => tool.name))].sort().forEach(name => {
    const calls = tools.filter(tool => tool.name === name && !tool.inherited);
    const node = el('div', undefined, 'tool-row');
    const outcomes = {};
    calls.forEach(tool => outcomes[tool.status] = (outcomes[tool.status] || 0) + 1);
    const counts = Object.entries(outcomes).map(([key, value]) => value + ' ' + key).join(' · ');
    node.append(el('div', name, 'tool-name'), el('div', calls.length + ' calls · ' + counts, 'tool-outcome'));
    target.append(node);
  });
  if (!tools.length) target.append(el('div', 'No tool activity in this view.', 'empty'));
}

function showTrace() {
  const target = byId('trace');
  target.replaceChildren();
  const session = current.find(item => item.id === selected);
  if (!session) {
    target.append(el('div', 'Select a session to see usage steps and tool outcomes.', 'empty'));
    byId('trace-label').textContent = 'Metadata only';
    return;
  }
  byId('trace-label').textContent = session.id;
  const items = [
    ...session.trace.steps.map(step => ({ ...step, kind: 'step', at: step.createdMs })),
    ...session.trace.tools.map(tool => ({ ...tool, kind: 'tool', at: tool.startedMs ?? tool.createdMs }))
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!items.length) target.append(el('div', 'This session has no matching telemetry.', 'empty'));
  items.forEach(item => {
    const node = el('div', undefined, 'event ' + item.kind);
    const dot = el('div', undefined, 'event-dot');
    const body = el('div', undefined, 'event-body');
    const title = el('div', undefined, 'event-title');
    title.append(el('span', item.kind === 'step' ? 'Usage step' : item.name));
    if (item.kind === 'tool') title.append(badge(item.status));
    if (item.inherited) title.append(badge('inherited'));
    const timestamp = item.at === null ? 'Time unavailable' : new Date(item.at).toLocaleString(undefined, { timeZone: report.metadata.timezone });
    body.append(title, el('div', timestamp + ' · ' + item.model + ' · ' + item.messageID, 'event-meta'));
    if (item.kind === 'step') {
      const components = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']
        .map(key => key.replace(/([A-Z])/g, ' $1') + ' ' + num(item.breakdown?.[key])).join(' · ');
      body.append(el('div', item.basis + ' · ' + components, 'event-meta'));
    }
    const text = item.kind === 'step' ? num(item.tokens) + ' tokens'
      : item.durationMs === null ? 'Duration unknown' : num(item.durationMs) + ' ms';
    node.append(dot, body, el('div', text, 'event-value'));
    target.append(node);
  });
}

function render() {
  const query = byId('search').value.trim().toLowerCase();
  const model = byId('model').value;
  current = report.sessions.map(session => {
    const trace = tracesFor(session);
    const filtered = {
      steps: trace.steps.filter(step => !model || step.model === model),
      tools: trace.tools.filter(tool => !model || tool.model === model)
    };
    return { ...session, trace: filtered, summary: aggregate(filtered.steps, filtered.tools) };
  }).filter(session => (!model || session.trace.steps.length || session.trace.tools.length)
    && (!query || session.id.toLowerCase().includes(query)
      || session.trace.tools.some(tool => tool.name.toLowerCase().includes(query))));
  const steps = current.flatMap(session => session.trace.steps);
  const tools = current.flatMap(session => session.trace.tools);
  byId('scope').textContent = current.length + ' sessions · targets apply to this view';
  const totals = renderMetrics(steps, tools);
  byId('component-label').textContent = totals.tokens === null ? 'Known token components · incomplete usage' : 'Normalized token components';
  renderModels(steps, tools, model);
  renderSessions();
  renderChart(steps, totals);
  renderTools(tools);
  showTrace();
}

report.models.forEach(model => {
  const option = el('option', model.displayName + ' · ' + model.id);
  option.value = model.id;
  byId('model').append(option);
});
byId('zone').textContent = report.metadata.timezone;
byId('stamp').textContent = 'Snapshot ' + new Date(report.metadata.generatedAt).toLocaleString();
byId('notice').textContent = report.metadata.notice + ' No prompts, arguments, tool results, project paths, or reasoning text are included.';
byId('diagnostic-summary').textContent = report.diagnostics.length + ' data diagnostics';
report.diagnostics.forEach(diagnostic => {
  byId('diagnostics').append(el('div', diagnostic.code + ' · ' + diagnostic.message + (diagnostic.count ? ' (' + diagnostic.count + ')' : '')));
});
byId('diagnostic-details').hidden = report.diagnostics.length === 0;
byId('search').addEventListener('input', render);
byId('model').addEventListener('change', render);
byId('theme').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  byId('theme').textContent = light ? 'Dark theme' : 'Light theme';
  byId('theme').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
});
byId('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const anchor = el('a');
  anchor.href = url;
  anchor.download = 'armor-opencode-telemetry.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();
</script></body></html>'''
