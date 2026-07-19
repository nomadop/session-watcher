// public/elements/bucketPanel.js — Bucket panel element (v3): keep/discard checkboxes
// + compact-instruction generator. Replaces bucketTree.js placeholder.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

import { OTHERS_DRIFT_WARN_PCT, DONUT_CIRCUMFERENCE, MIN_B_PREVIEW, COPY_FEEDBACK_MS } from '../lib/uiConstants.js';
import { churnTier, maxChildTier } from '../lib/churnTier.js';
import { redactCmd } from '../lib/redaction.js';
export { redactCmd };

// ─── buildTree helpers ────────────────────────────────────────────────────────


// foldPaths: convert flat path list into a collapsible tree grouped by directory.
// Uses recursive grouping by path segments. Single-child intermediate dirs collapse
// (e.g. workspace/lib with only one sub-group shows as one label "lib" not nested).
// Max display depth: 3 levels of nesting.
function foldPaths(paths) {
  if (!paths || paths.length === 0) return [];

  // Drop bare directory entries (trailing '/').
  const files = paths.filter(p => !p.path.endsWith('/'));
  if (files.length === 0) return [];

  function makeFileLeaf(p, name, indent) {
    const defaultSel = p.defaultSelected !== false; // explicit false → excluded
    const waste = (p.totalSpent ?? p.tokens ?? 0) - (p.tokens ?? 0);
    const tier = churnTier({ churn: p.churn ?? null, waste, pureRereads: p.pureRereads ?? 0 });
    return {
      id: 'file:' + p.path,
      group: 'paths',
      kind: 'file',
      name,
      label: p.path,
      displayName: name,
      detail: undefined,
      tool: undefined,
      tokens: p.tokens ?? 0,
      totalSpent: p.totalSpent ?? p.tokens ?? 0,
      churn: p.churn ?? null,
      pureRereads: p.pureRereads ?? 0,
      readCount: p.readCount ?? 0,
      editCount: p.editCount ?? 0,
      efficiency: p.efficiency ?? null,
      touchSeqs: p.touchSeqs ?? null,
      defaultDiscardReason: p.defaultDiscardReason ?? null,
      churnTier: tier,
      lastTurn: p.lastTurn ?? null,
      lastCallSeq: p.lastCallSeq ?? null,
      locked: false,
      selectable: true,
      defaultSelected: defaultSel,
      selected: defaultSel,
      children: null,
      indent,
    };
  }

  function makeDirNode(label, children, indent, fullPrefix) {
    const tokens = children.reduce((s, c) => s + (c.tokens ?? 0), 0);
    // Dir tier = max child tier (coral only propagates from WASTE_FLOOR-passing children,
    // already baked into each child's churnTier value).
    const dirTier = maxChildTier(children);
    return {
      id: 'dir:paths:' + fullPrefix,
      group: 'paths',
      kind: 'dir',
      name: label,
      label,
      displayName: label,
      detail: undefined,
      tool: undefined,
      tokens,
      churnTier: dirTier,
      lastTurn: null,
      locked: false,
      selectable: true,
      defaultSelected: true,
      selected: true,
      children,
      indent,
      collapsed: true,
    };
  }

  // Build tree recursively. `prefix` is the full path prefix already consumed.
  // Each level groups by the next directory segment after prefix.
  function build(entries, prefix, indent, maxDepth) {
    if (indent >= maxDepth) {
      return entries.map(p => {
        const rel = prefix ? p.path.slice(prefix.length + 1) : p.path;
        return makeFileLeaf(p, rel, indent);
      });
    }

    const groups = new Map(); // nextSeg → [entry...]
    const here = []; // files directly at this prefix (no more '/')
    for (const p of entries) {
      let rest = prefix ? p.path.slice(prefix.length + 1) : p.path;
      if (!prefix && rest.startsWith('/')) rest = rest.slice(1); // skip leading '/' for absolute paths
      const slashIdx = rest.indexOf('/');
      if (slashIdx < 0) {
        here.push(p);
      } else {
        const seg = rest.slice(0, slashIdx);
        if (!groups.has(seg)) groups.set(seg, []);
        groups.get(seg).push(p);
      }
    }

    const result = [];

    // Files at this level — show basename
    for (const p of here) {
      let rest = prefix ? p.path.slice(prefix.length + 1) : p.path;
      if (!prefix && rest.startsWith('/')) rest = rest.slice(1);
      result.push(makeFileLeaf(p, rest, indent));
    }

    // Subdirectories
    for (const [seg, group] of groups) {
      // When prefix is empty and paths are absolute, dirPrefix must include '/' to stay aligned with p.path
      const dirPrefix = prefix ? prefix + '/' + seg
        : (group[0].path.startsWith('/') ? '/' + seg : seg);

      if (group.length === 1) {
        // Lone file — display relative path from current prefix
        const p = group[0];
        let rel = prefix ? p.path.slice(prefix.length + 1) : p.path;
        if (!prefix && rel.startsWith('/')) rel = rel.slice(1);
        result.push(makeFileLeaf(p, rel, indent));
      } else {
        // Collapse single-child intermediate dirs into one label
        let label = seg;
        let curPrefix = dirPrefix;
        let curGroup = group;
        while (true) {
          const sub = new Map();
          const subHere = [];
          for (const p of curGroup) {
            const rest = p.path.slice(curPrefix.length + 1);
            const si = rest.indexOf('/');
            if (si < 0) subHere.push(p);
            else {
              const s = rest.slice(0, si);
              if (!sub.has(s)) sub.set(s, []);
              sub.get(s).push(p);
            }
          }
          if (subHere.length === 0 && sub.size === 1) {
            const [[nextSeg, nextGroup]] = sub;
            label += '/' + nextSeg;
            curPrefix += '/' + nextSeg;
            curGroup = nextGroup;
          } else {
            break;
          }
        }
        const children = build(curGroup, curPrefix, indent + 1, maxDepth);
        result.push(makeDirNode(label, children, indent, curPrefix));
      }
    }

    return result;
  }

  // Find and strip the common absolute-path root (e.g. "/workspace") so the tree
  // doesn't start with a meaningless root dir. Only for absolute paths (all start with '/').
  let commonPrefix = '';
  if (files.length > 1 && files[0].path.startsWith('/') && files.every(p => p.path.startsWith('/'))) {
    const first = files[0].path;
    let end = 0;
    outer: for (let i = 0; i < first.length; i++) {
      for (let j = 1; j < files.length; j++) {
        if (i >= files[j].path.length || files[j].path[i] !== first[i]) break outer;
      }
      if (first[i] === '/') end = i;
    }
    // Only use if it's beyond the root '/'
    if (end > 0) commonPrefix = first.slice(0, end);
  }

  const result = build(files, commonPrefix, 0, 3);
  sortByTokensDesc(result);
  return result;
}

function sortByTokensDesc(nodes) {
  nodes.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
  for (const n of nodes) {
    if (n.children) sortByTokensDesc(n.children);
  }
}

// foldResidual: convert a bash/mcp list into BucketNode[].
// >1 → dir node + per-feature children; =1 → single inline leaf; 0 → nothing.
function foldResidual(kind, list, nameOf) {
  if (!list || list.length === 0) return [];

  function makeLeaf(item, indent) {
    const name = nameOf(item);
    const isBash = kind === 'bash';
    const id = kind + ':' + name;
    const displayName = isBash ? redactCmd(name) : name;
    return {
      id,
      group: 'output',
      kind,
      name,
      label: name,
      displayName,
      detail: item.detail ?? undefined,
      tool: isBash ? undefined : name,
      tokens: item.tokens ?? 0,
      count: item.count ?? 1,
      lastTurn: item.lastTurn ?? null,
      lastCallSeq: item.lastCallSeq ?? null,
      touchSeqs: item.touchSeqs ?? null,
      locked: false,
      selectable: true,
      defaultSelected: false,
      selected: false,
      children: null,
      indent,
    };
  }

  if (list.length === 1) {
    return [makeLeaf(list[0], 0)];
  }

  // >1 → dir node
  const children = list.map(item => makeLeaf(item, 1));
  const tokens = children.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const dirNode = {
    id: 'dir:output:' + kind,
    group: 'output',
    kind: 'dir',
    name: kind,
    label: kind,
    displayName: kind,
    detail: undefined,
    tool: undefined,
    tokens,
    lastTurn: null,
    locked: false,
    selectable: true,
    defaultSelected: false,
    selected: false,
    children,
    indent: 0,
    collapsed: true,
  };
  return [dirNode];
}

// ─── buildTree ────────────────────────────────────────────────────────────────

/**
 * Convert the §11.3.1 bucketData object into an array of BucketNode for the panel UI.
 * Groups: system / paths / output (bash + mcp + others).
 * @param {object|null|undefined} bucketData
 * @returns {BucketNode[]}
 */
export function buildTree(bucketData) {
  if (!bucketData) return [];
  const tree = [];

  // ── SYSTEM ──
  tree.push({
    id: 'system:prompt',
    group: 'system',
    kind: 'system',
    name: 'system prompt',
    label: 'system prompt',
    displayName: 'system prompt',
    detail: undefined,
    tool: undefined,
    tokens: bucketData.dead || 0,
    lastTurn: null,
    locked: true,
    selectable: false,
    defaultSelected: false,
    selected: false,
    children: null,
    indent: 0,
  });

  for (const s of (bucketData.skills || [])) {
    tree.push({
      id: 'skill:' + s.name,
      group: 'system',
      kind: 'skill',
      name: s.name,
      label: 'skill:' + s.name,
      displayName: 'skill:' + s.name,
      detail: undefined,
      tool: undefined,
      tokens: s.tokens ?? 0,
      lastTurn: s.lastTurn ?? null,
      lastCallSeq: s.lastCallSeq ?? null,
      locked: false,
      selectable: true,
      defaultSelected: true,
      selected: true,
      children: null,
      indent: 0,
    });
  }

  // ── PATHS (smart fold) ──
  tree.push(...foldPaths(bucketData.paths || []));

  // ── OUTPUT ──
  const bash = bucketData.residual?.bash || [];
  const mcp = bucketData.residual?.mcp || [];
  const agent = bucketData.residual?.agent || [];

  tree.push(...foldResidual('bash', bash, b => b.name));
  tree.push(...foldResidual('mcp', mcp, m => m.tool));
  tree.push(...foldResidual('agent', agent, a => a.name));

  const sumBash = bash.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const sumMcp = mcp.reduce((s, m) => s + (m.tokens ?? 0), 0);
  const sumAgent = agent.reduce((s, a) => s + (a.tokens ?? 0), 0);

  // WHY: use totalResidualRaw (not clamped) so drift signal is never silently lost (review GPT#7)
  const totalRaw = bucketData.totalResidualRaw ?? bucketData.totalResidual ?? 0;
  const othersRaw = totalRaw - sumBash - sumMcp - sumAgent;

  // Drift-warn: if raw goes deeply negative, something is misaccounted
  if (othersRaw < -(OTHERS_DRIFT_WARN_PCT * (bucketData.totalL || 0))) {
    console.warn('bucket measurement drift');
  }

  // others is always last; locked; tokens clamped to 0 (never negative in the UI)
  tree.push({
    id: 'others',
    group: 'output',
    kind: 'others',
    name: 'others',
    label: 'others',
    displayName: 'others',
    detail: undefined,
    tool: undefined,
    tokens: Math.max(0, othersRaw),
    lastTurn: null,
    locked: true,
    selectable: false,
    defaultSelected: false,
    selected: false,
    children: null,
    indent: 0,
  });

  return tree;
}

// ─── Pure summary helpers ─────────────────────────────────────────────────────

/**
 * Recursively collect all leaf nodes (no children or children: null).
 * Dir nodes (with non-empty children arrays) are excluded from the result
 * but recursed into.
 * @param {BucketNode[]} tree
 * @param {BucketNode[]} out
 * @returns {BucketNode[]}
 */
export function flattenLeaves(tree, out = []) {
  for (const n of tree) {
    if (n.children && n.children.length) flattenLeaves(n.children, out);
    else out.push(n);
  }
  return out;
}

/**
 * Collect all dir nodes (nodes where n.children?.length > 0).
 * Used for collapsedOverrides GC — key space is dir ids, not leaf ids.
 * @param {BucketNode[]} tree
 * @param {BucketNode[]} out
 * @returns {BucketNode[]}
 */
export function flattenDirs(tree, out = []) {
  for (const n of tree) {
    if (n.children && n.children.length) {
      out.push(n);
      flattenDirs(n.children, out);
    }
  }
  return out;
}

/**
 * Derive checkbox state from descendant leaves.
 * Accepts a dir node OR a children array.
 * Only counts selectable leaves. Zero selectable → 'unchecked'.
 * @param {BucketNode|BucketNode[]} nodeOrChildren
 * @returns {'checked'|'unchecked'|'half'}
 */
export function deriveDirState(nodeOrChildren) {
  const src = Array.isArray(nodeOrChildren) ? nodeOrChildren : (nodeOrChildren?.children || []);
  const leaves = flattenLeaves(src).filter(n => n.selectable);
  if (leaves.length === 0) return 'unchecked';
  const sel = leaves.filter(n => n.selected).length;
  if (sel === 0) return 'unchecked';
  if (sel === leaves.length) return 'checked';
  return 'half';
}

/**
 * Compute leaf-only token totals for the donut chart.
 * Dir aggregate tokens are excluded — only leaf nodes contribute.
 * @param {BucketNode[]} tree
 * @returns {{ fixed: number, selected: number, discarded: number, total: number }}
 */
export function summarize(tree) {
  let fixed = 0, selected = 0, discarded = 0;
  for (const leaf of flattenLeaves(tree)) {
    if (leaf.locked && leaf.kind === 'system') fixed += leaf.tokens;
    else if (leaf.locked && leaf.kind === 'others') discarded += leaf.tokens;
    else if (leaf.selected) selected += leaf.tokens;
    else discarded += leaf.tokens;
  }
  return { fixed, selected, discarded, total: fixed + selected + discarded };
}

/**
 * Compute SVG dash-array/dashoffset values for the 3-arc donut.
 * system starts at offset 0, selected at -systemLen, discarded at -(systemLen+selectedLen).
 * Guard total === 0 → all zero-length arcs (no NaN).
 * @param {{ fixed: number, selected: number, discarded: number }} param0
 * @returns {{ system: {dasharray: string, dashoffset: number}, selected: {...}, discarded: {...} }}
 */
export function donutSegments({ fixed, selected, discarded }) {
  const total = fixed + selected + discarded;
  const C = DONUT_CIRCUMFERENCE;
  const arc = (v) => total > 0 ? (v / total) * C : 0;
  const sysLen = arc(fixed), selLen = arc(selected), disLen = arc(discarded);
  const seg = (len, offset) => ({ dasharray: `${len.toFixed(1)} ${(C - len).toFixed(1)}`, dashoffset: offset });
  return {
    system: seg(sysLen, 0),
    selected: seg(selLen, -sysLen),
    discarded: seg(disLen, -(sysLen + selLen)),
  };
}

// ─── Selection state helpers ──────────────────────────────────────────────────

/**
 * Apply a Map<id, bool> of user overrides to the tree's selectable leaves.
 * Each selectable leaf: selected = overrides.has(leaf.id) ? overrides.get(leaf.id) : leaf.defaultSelected.
 * Mutates in place; returns void.
 * @param {BucketNode[]} tree
 * @param {Map<string, boolean>} overrides
 */
export function applyOverrides(tree, overrides) {
  for (const leaf of flattenLeaves(tree)) {
    if (!leaf.selectable) continue;
    leaf.selected = overrides.has(leaf.id) ? overrides.get(leaf.id) : leaf.defaultSelected;
  }
}

/**
 * Return true if ANY selectable leaf has selected !== defaultSelected.
 * @param {BucketNode[]} tree
 * @returns {boolean}
 */
export function computeDirty(tree) {
  return flattenLeaves(tree).some(n => n.selectable && n.selected !== n.defaultSelected);
}

/**
 * Compute the estimated context size after overrides are applied.
 * delta = Σ ((selected?1:0) - (defaultSelected?1:0)) × tokens for each selectable leaf.
 * Result is floored at MIN_B_PREVIEW.
 * @param {BucketNode[]} tree
 * @param {number} B_default
 * @returns {number}
 */
export function computeBPreview(tree, B_default) {
  let delta = 0;
  for (const leaf of flattenLeaves(tree)) {
    if (!leaf.selectable) continue;
    delta += ((leaf.selected ? 1 : 0) - (leaf.defaultSelected ? 1 : 0)) * leaf.tokens;
  }
  return Math.max(MIN_B_PREVIEW, B_default + delta);
}

// Pure helper — exported so tests can import without touching the DOM.
// Builds a natural-language /compact instruction from the tree's live selection state.
// Signature CHANGED from old {keptPaths, discardedBash, discardedMcp} to (tree) because
// half-select generation requires per-child state unavailable in the flat form. (§8.1/§8.2)
export function buildCompactInstruction(tree) {
  const clauses = [];
  const retain = [];

  // 1/2. Recurse the PATHS group (review GPT#6: must handle nested sub-dirs, not just top-level).
  //   - fully-selected dir  → retain <dir>            (do NOT descend — the whole subtree is kept)
  //   - fully-unselected dir → (nothing; its files are discarded implicitly)
  //   - half-selected dir   → summarize <dir> excluding <unchecked descendant leaf names>, THEN recurse
  //                            into child dirs so a deeper half-selected sub-dir gets its own clause
  //   - kept lone file      → retain <file>
  function walkPath(node) {
    if (node.kind === 'file') { if (node.selected) retain.push(redactCmd(node.name)); return; }  // redact path (GPT#10: /home/alice → ~)
    if (node.kind !== 'dir') return;
    const state = deriveDirState(node);              // descendant-leaf based (Task 5)
    if (state === 'checked') { retain.push(redactCmd(node.name)); return; }
    if (state === 'unchecked') return;
    // half: summarize this dir excluding its unchecked descendant LEAVES, then recurse into sub-dirs
    const excluded = flattenLeaves(node.children).filter(l => l.selectable && !l.selected).map(l => redactCmd(l.name));
    clauses.push(`summarize ${redactCmd(node.name)} briefly, excluding ${excluded.join(', ')}`);
    for (const c of node.children) if (c.kind === 'dir') walkPath(c);
  }
  for (const n of tree) if (n.group === 'paths') walkPath(n);
  if (retain.length) clauses.unshift(`retain detailed context for ${retain.join(' and ')}`);

  // 2b. Unchecked skills (group==='system', selectable, kind==='skill') → discard
  const discardedSkills = [];
  for (const leaf of flattenLeaves(tree)) {
    if (leaf.kind === 'skill' && leaf.selectable && !leaf.selected) {
      discardedSkills.push(leaf.name);
    }
  }
  if (discardedSkills.length) clauses.push(`discard skill context: ${discardedSkills.join(', ')}`);

  // 3. Unchecked bash/mcp → discard (redacted). Iterate leaves so a bash DIR's children are covered too.
  //    leaf.name is already the SERVER-EXTRACTED feature (Task 0b); redactCmd is defense-in-depth (§8.3).
  //    Include detail for disambiguation (GPT#10: two 'curl' calls otherwise indistinguishable).
  const discards = [];
  for (const leaf of flattenLeaves(tree)) {
    if ((leaf.kind === 'bash' || leaf.kind === 'mcp' || leaf.kind === 'agent') && leaf.selectable && !leaf.selected) {
      const bashLabel = [leaf.name, leaf.detail].filter(Boolean).join(' ');
      const label = leaf.kind === 'bash' ? redactCmd(bashLabel)
        : leaf.kind === 'agent' ? (leaf.detail || leaf.name)
        : (leaf.tool || leaf.name);
      discards.push(`${label} output`);
    }
  }
  if (discards.length) clauses.push(`discard raw ${discards.join(', ')}, keeping only failing assertions and error names`);

  if (!clauses.length) return '';  // guard: nothing to compact
  return '/compact ' + clauses.join('; ');
}

// ─── Private DOM helpers ──────────────────────────────────────────────────────

function tokenLabel(tokens) {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

// Bar color class by node kind/group
function barColorClass(node) {
  if (node.kind === 'system') return 'color-mute';
  if (node.kind === 'skill') return 'color-sky';
  if (node.kind === 'others') return 'color-mute';
  if (node.group === 'output') return 'color-amber';
  // paths: color by churn tier
  const tier = node.churnTier ?? 'mint';
  if (tier === 'coral') return 'color-coral';
  if (tier === 'amber') return 'color-amber';
  return 'color-mint';
}

// Name class for .bucket-name span
function nameClass(node) {
  if (node.kind === 'system') return 'is-system';
  if (node.kind === 'skill') return 'is-skill';
  if (node.kind === 'dir') return 'is-dir-name';
  if (node.kind === 'bash' || node.kind === 'mcp' || node.kind === 'agent') return 'is-special';
  if (node.kind === 'others') return 'is-others';
  return '';
}

// ─── Private tree helpers ─────────────────────────────────────────────────────

function findNodeById(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children && n.children.length) {
      const found = findNodeById(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

// ─── Element mount ────────────────────────────────────────────────────────────

export function mount(root, ctx) {
  // ── Closure state ──────────────────────────────────────────────────────────
  const state = {
    tree: [],
    selectionOverrides: new Map(),   // leaf id → bool (user toggles since last Reset)
    collapsedOverrides: new Map(),   // dir id → bool (user fold toggles)
    sectionCollapsed: { system: false, paths: false, output: true }, // section-level fold
    prevSegment: null,
    lastGoodBucketData: null,        // last non-null bd — fallback for transient failures
    B_default: 0,                    // from status.rateLamp.B_rebuild ?? bd.totalB
    _bodyTips: [],                   // tooltip elements appended to document.body (for cleanup)
  };

  // ── Card structure (outer shell, rebuilt once) ─────────────────────────────
  const card = document.createElement('div');
  card.className = 'bucket-card';
  card.id = 'sw-buckets';

  // Header
  const header = document.createElement('div');
  header.className = 'bucket-header';

  const donutWrap = document.createElement('div');
  donutWrap.className = 'header-donut';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');

  // 4 circles: track + system + selected + discarded
  const circleTrack = document.createElementNS(SVG_NS, 'circle');
  circleTrack.setAttribute('cx', '18'); circleTrack.setAttribute('cy', '18'); circleTrack.setAttribute('r', '14');
  circleTrack.setAttribute('fill', 'none'); circleTrack.setAttribute('stroke', 'rgba(255,255,255,0.04)');
  circleTrack.setAttribute('stroke-width', '4.5');

  const circleSystem = document.createElementNS(SVG_NS, 'circle');
  circleSystem.setAttribute('cx', '18'); circleSystem.setAttribute('cy', '18'); circleSystem.setAttribute('r', '14');
  circleSystem.setAttribute('fill', 'none'); circleSystem.setAttribute('stroke', '#5a6a75');
  circleSystem.setAttribute('stroke-width', '4.5');
  circleSystem.className.baseVal = 'donut-system';

  const circleSelected = document.createElementNS(SVG_NS, 'circle');
  circleSelected.setAttribute('cx', '18'); circleSelected.setAttribute('cy', '18'); circleSelected.setAttribute('r', '14');
  circleSelected.setAttribute('fill', 'none'); circleSelected.setAttribute('stroke', '#4fe0b0');
  circleSelected.setAttribute('stroke-width', '4.5');
  circleSelected.className.baseVal = 'donut-selected';

  const circleDiscarded = document.createElementNS(SVG_NS, 'circle');
  circleDiscarded.setAttribute('cx', '18'); circleDiscarded.setAttribute('cy', '18'); circleDiscarded.setAttribute('r', '14');
  circleDiscarded.setAttribute('fill', 'none'); circleDiscarded.setAttribute('stroke', '#ff7566');
  circleDiscarded.setAttribute('stroke-width', '4.5'); circleDiscarded.setAttribute('opacity', '0.7');
  circleDiscarded.className.baseVal = 'donut-discarded';

  svg.appendChild(circleTrack);
  svg.appendChild(circleSystem);
  svg.appendChild(circleSelected);
  svg.appendChild(circleDiscarded);
  donutWrap.appendChild(svg);

  const headerInfo = document.createElement('div');
  headerInfo.className = 'header-info';
  const h3 = document.createElement('h3');
  h3.textContent = 'Context buckets';
  const subtitle = document.createElement('div');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'rebuild cost · uncheck to draft compact';
  headerInfo.appendChild(h3);
  headerInfo.appendChild(subtitle);

  const headerStats = document.createElement('div');
  headerStats.className = 'header-stats';
  const statSelectedEl = document.createElement('div');
  const statSelectedSpan = document.createElement('span');
  statSelectedSpan.className = 'val-selected stat-selected';
  statSelectedEl.appendChild(statSelectedSpan);
  const statDiscardedEl = document.createElement('div');
  const statDiscardedSpan = document.createElement('span');
  statDiscardedSpan.className = 'val-discarded stat-discarded';
  statDiscardedEl.appendChild(statDiscardedSpan);
  headerStats.appendChild(statSelectedEl);
  headerStats.appendChild(statDiscardedEl);

  header.appendChild(donutWrap);
  header.appendChild(headerInfo);
  header.appendChild(headerStats);

  // Status bar (syncing / stale chip) — hidden by default
  const statusBar = document.createElement('div');
  statusBar.className = 'panel-status-bar';
  statusBar.style.display = 'none';

  // Sweep line (syncing animation)
  const sweepTrack = document.createElement('div');
  sweepTrack.className = 'sync-sweep-track';
  sweepTrack.setAttribute('aria-hidden', 'true');
  sweepTrack.style.display = 'none';

  // Tree
  const treeEl = document.createElement('div');
  treeEl.className = 'bucket-tree';

  // Footer
  const footer = document.createElement('div');
  footer.className = 'bucket-footer';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'bucket-reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.type = 'button';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'bucket-copy-btn';
  copyBtn.textContent = 'Copy instructions';
  copyBtn.type = 'button';

  footer.appendChild(resetBtn);
  footer.appendChild(copyBtn);

  card.appendChild(sweepTrack);
  card.appendChild(header);
  card.appendChild(statusBar);
  card.appendChild(treeEl);
  card.appendChild(footer);
  root.appendChild(card);

  // ── Stale-label interval ───────────────────────────────────────────────────
  let staleInterval = null;

  function clearStaleInterval() {
    if (staleInterval) { clearInterval(staleInterval); staleInterval = null; }
  }

  // ── Event dispatchers ──────────────────────────────────────────────────────
  function dispatchPreview(forceFalse) {
    if (forceFalse) {
      document.dispatchEvent(new CustomEvent('sw-bucket-preview', { detail: { B_preview: state.B_default, dirty: false } }));
      return;
    }
    const dirty = computeDirty(state.tree);
    const B_preview = computeBPreview(state.tree, state.B_default);
    document.dispatchEvent(new CustomEvent('sw-bucket-preview', { detail: { B_preview, dirty } }));
  }

  let _hoveredNodeId = null; // track currently hovered row across re-renders

  function dispatchHover(detail) {
    document.dispatchEvent(new CustomEvent('sw-bucket-hover', { detail }));
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function makeRow(node, maxLeafTokens) {
    const row = document.createElement('div');
    row.className = 'bucket-row';
    if (node.kind === 'dir') row.classList.add('is-dir');
    if (node.indent) row.dataset.indent = String(node.indent);
    row.dataset.id = node.id;
    row.dataset.tokens = String(node.tokens);
    if (node.lastCallSeq != null) row.dataset.lastCallSeq = String(node.lastCallSeq);
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'option');

    // Excluded rows: file with defaultSelected === false, or dir where ALL leaves are excluded
    const isExcluded = node.kind === 'file'
      ? node.defaultSelected === false
      : node.kind === 'dir' && flattenLeaves(node.children).every(l => l.defaultSelected === false);
    if (isExcluded) row.classList.add('is-excluded');

    // Checkbox
    const cb = document.createElement('span');
    cb.className = 'bucket-cb';
    if (node.locked) {
      cb.classList.add('locked');
      if (node.kind !== 'others') cb.classList.add('checked');
      row.setAttribute('aria-disabled', 'true');
      row.setAttribute('aria-checked', node.kind !== 'others' ? 'true' : 'false');
    } else if (node.kind === 'dir') {
      const ds = deriveDirState(node);
      if (ds === 'checked') cb.classList.add('checked');
      else if (ds === 'half') cb.classList.add('half');
      row.setAttribute('aria-checked', ds === 'checked' ? 'true' : ds === 'half' ? 'mixed' : 'false');
    } else {
      if (node.selected) cb.classList.add('checked');
      // Excluded rows: checkbox unchecked by default (no 'checked' class)
      row.setAttribute('aria-checked', node.selected ? 'true' : 'false');
    }
    row.appendChild(cb);

    // Expand arrow (dirs only) — SVG chevron-right, rotated via CSS
    if (node.kind === 'dir') {
      const expand = document.createElement('span');
      expand.className = 'bucket-expand';
      if (node.collapsed) expand.classList.add('collapsed');
      expand.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
      row.appendChild(expand);
    }


    // Name + optional count badge
    const nameWrap = document.createElement('span');
    nameWrap.className = 'bucket-name-wrap';
    const nameEl = document.createElement('span');
    nameEl.className = 'bucket-name';
    const nc = nameClass(node);
    if (nc) nameEl.classList.add(nc);
    // Apply churn tier class to path/dir name elements
    if (node.group === 'paths' || (node.kind === 'dir' && node.group === 'paths')) {
      const tier = node.churnTier ?? 'mint';
      if (tier === 'amber') nameEl.classList.add('churn-med');
      else if (tier === 'coral') nameEl.classList.add('churn-high');
    }
    nameEl.textContent = node.displayName;
    nameWrap.appendChild(nameEl);

    if (node.count > 1 && (node.kind === 'bash' || node.kind === 'mcp' || node.kind === 'agent')) {
      const badge = document.createElement('span');
      badge.className = 'bucket-count';
      badge.textContent = String(node.count);
      nameWrap.appendChild(badge);
    }
    row.appendChild(nameWrap);

    // Right cluster: token count + mini-bar
    const right = document.createElement('span');
    right.className = 'bucket-right';

    const tokEl = document.createElement('span');
    tokEl.className = 'bucket-tokens';
    tokEl.textContent = tokenLabel(node.tokens);
    right.appendChild(tokEl);

    const barWrap = document.createElement('span');
    barWrap.className = 'bucket-bar-wrap';
    const bar = document.createElement('span');
    bar.className = 'bucket-bar ' + barColorClass(node);
    // sqrt scale: preserves ratio perception while expanding small-value resolution
    const pct = maxLeafTokens > 0
      ? (Math.sqrt(node.tokens) / Math.sqrt(maxLeafTokens)) * 100
      : 0;
    bar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    barWrap.appendChild(bar);
    right.appendChild(barWrap);

    row.appendChild(right);

    // Structured tooltip for path rows (file/dir in paths group)
    if (node.group === 'paths' && node.kind === 'file') {
      const tip = document.createElement('div');
      tip.className = 'sw-bucket-tip';
      // position: fixed — anchored to row side (flip + shift)
      row.addEventListener('mouseenter', () => {
        tip.style.display = 'block';
        const rect = row.getBoundingClientRect();
        const tipH = tip.offsetHeight;
        const tipW = tip.offsetWidth;
        const offset = 8;
        // X: prefer right of row; flip left if overflows viewport
        const spaceRight = window.innerWidth - rect.right;
        if (spaceRight >= tipW + offset) {
          tip.style.left = (rect.right + offset) + 'px';
        } else {
          tip.style.left = (rect.left - tipW - offset) + 'px';
        }
        // Y: vertically centered on row, shifted to stay in viewport
        const rowMid = rect.top + rect.height / 2;
        const idealY = rowMid - tipH / 2;
        tip.style.top = Math.max(8, Math.min(idealY, window.innerHeight - tipH - 8)) + 'px';
      });
      row.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
        tip.style.left = '';
      });
      if (isExcluded && node.defaultDiscardReason) {
        const excLine = document.createElement('div');
        excLine.className = 'tooltip-excluded';
        excLine.textContent = 'excluded';
        const reason = document.createElement('span');
        reason.className = 'reason';
        reason.textContent = node.defaultDiscardReason;
        excLine.appendChild(reason);
        tip.appendChild(excLine);
      }
      const rows = [
        ['retained', tokenLabel(node.tokens)],
        ['total spent', tokenLabel(node.totalSpent ?? node.tokens)],
        ['ops', `${node.readCount ?? 0}R · ${node.editCount ?? 0}E`],
      ];
      if ((node.pureRereads ?? 0) > 0) rows.push(['pure rereads', String(node.pureRereads)]);
      for (const [label, val] of rows) {
        const tr = document.createElement('div');
        tr.className = 'tooltip-row';
        tr.textContent = `${label}: ${val}`;
        tip.appendChild(tr);
      }
      if (node.efficiency != null) {
        const effRow = document.createElement('div');
        effRow.className = 'tooltip-eff';
        const effLabel = document.createElement('span');
        effLabel.textContent = `eff ${Math.round(node.efficiency)}%`;
        const effBar = document.createElement('span');
        effBar.className = 'tooltip-eff-bar';
        const tier = node.churnTier ?? 'mint';
        const effFill = document.createElement('span');
        effFill.className = `tooltip-eff-fill color-${tier}`;
        effFill.style.width = `${Math.max(0, Math.min(100, node.efficiency ?? 0)).toFixed(1)}%`;
        effBar.appendChild(effFill);
        effRow.appendChild(effLabel);
        effRow.appendChild(effBar);
        tip.appendChild(effRow);
      }
      document.body.appendChild(tip);
      state._bodyTips.push(tip);
    }

    // Dim row if not selected, or if it's the uncontrollable 'others' residual
    if (node.kind === 'others') {
      row.style.opacity = '0.5';
    } else if (!node.locked) {
      if (node.kind === 'dir') {
        if (deriveDirState(node) === 'unchecked') row.style.opacity = '0.5';
      } else if (!node.selected) {
        row.style.opacity = '0.5';
      }
    }

    return row;
  }

  function renderNodeTree(nodes, maxLeafTokens, fragment) {
    for (const node of nodes) {
      const row = makeRow(node, maxLeafTokens);
      fragment.appendChild(row);
      if (node.kind === 'dir' && node.children && node.children.length) {
        // Render children; hide them if collapsed
        const childFrag = document.createDocumentFragment();
        renderNodeTree(node.children, maxLeafTokens, childFrag);
        // Wrap children in a container so we can hide them as a unit
        const childWrap = document.createElement('div');
        childWrap.className = 'bucket-dir-children';
        childWrap.dataset.parentId = node.id;
        if (node.collapsed) childWrap.style.display = 'none';
        childWrap.appendChild(childFrag);
        fragment.appendChild(childWrap);
      }
    }
  }

  function render() {
    // Clear + rebuild — bucket list can change between polls
    for (const t of state._bodyTips) t.remove();
    state._bodyTips.length = 0;
    treeEl.innerHTML = '';

    const allLeaves = flattenLeaves(state.tree);
    // others + system don't participate in max — their bars are clamped to 100%
    const maxLeafTokens = allLeaves.reduce((m, n) => (n.kind === 'others' || n.kind === 'system') ? m : Math.max(m, n.tokens), 0);

    // ── Group into system / paths / output ──
    const systemNodes = state.tree.filter(n => n.group === 'system');
    const pathNodes = state.tree.filter(n => n.group === 'paths');
    const outputNodes = state.tree.filter(n => n.group === 'output');

    const frag = document.createDocumentFragment();

    function makeSection(label, nodes, isFirst) {
      if (!nodes.length) return;
      if (!isFirst) {
        const sep = document.createElement('hr');
        sep.className = 'bucket-sep';
        frag.appendChild(sep);
      }
      const lbl = document.createElement('div');
      lbl.className = 'section-label';
      if (state.sectionCollapsed[label]) lbl.classList.add('collapsed');
      lbl.dataset.section = label;

      // SVG chevron (IDE-style)
      const chevron = document.createElement('span');
      chevron.className = 'section-chevron';
      chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
      lbl.appendChild(chevron);

      // Label text
      const displayLabel = label === 'output' ? 'tools' : label;
      lbl.appendChild(document.createTextNode(displayLabel));

      // Token summary (shown when collapsed)
      const sectionTokens = nodes.reduce((s, n) => s + (n.tokens ?? 0), 0);
      const summary = document.createElement('span');
      summary.className = 'section-summary';
      summary.textContent = tokenLabel(sectionTokens);
      lbl.appendChild(summary);

      frag.appendChild(lbl);

      const group = document.createElement('div');
      group.className = 'section-group';
      group.dataset.section = label;
      if (state.sectionCollapsed[label]) group.classList.add('collapsed');
      renderNodeTree(nodes, maxLeafTokens, group);
      frag.appendChild(group);
    }

    makeSection('system', systemNodes, true);
    makeSection('paths', pathNodes, !systemNodes.length);
    makeSection('output', outputNodes, !systemNodes.length && !pathNodes.length);

    treeEl.appendChild(frag);

    // ── Update donut ──
    const sums = summarize(state.tree);
    const segs = donutSegments(sums);
    circleSystem.setAttribute('stroke-dasharray', segs.system.dasharray);
    circleSystem.setAttribute('stroke-dashoffset', String(segs.system.dashoffset));
    circleSelected.setAttribute('stroke-dasharray', segs.selected.dasharray);
    circleSelected.setAttribute('stroke-dashoffset', String(segs.selected.dashoffset));
    circleDiscarded.setAttribute('stroke-dasharray', segs.discarded.dasharray);
    circleDiscarded.setAttribute('stroke-dashoffset', String(segs.discarded.dashoffset));

    // ── Update stats ──
    statSelectedSpan.textContent = `selected ${tokenLabel(sums.selected)}`;
    statDiscardedSpan.textContent = `discarded ${sums.discarded >= 0 ? tokenLabel(sums.discarded) : '0'}`;

    // ── Footer dirty state ──
    const dirty = computeDirty(state.tree);
    resetBtn.classList.toggle('active', dirty);
  }

  function renderSkeleton() {
    treeEl.innerHTML = '';
    subtitle.textContent = 'loading…';
    statSelectedSpan.textContent = '';
    statDiscardedSpan.textContent = '';

    // Indeterminate donut
    circleSystem.setAttribute('stroke-dasharray', '26 62');
    circleSystem.setAttribute('stroke-dashoffset', '0');
    circleSelected.setAttribute('stroke-dasharray', '0 88');
    circleSelected.setAttribute('stroke-dashoffset', '0');
    circleDiscarded.setAttribute('stroke-dasharray', '0 88');
    circleDiscarded.setAttribute('stroke-dashoffset', '0');

    // Shimmer stat bars
    const statsShimmer = document.createDocumentFragment();
    [82, 70].forEach(w => {
      const s = document.createElement('span');
      s.className = 'skel';
      s.style.cssText = `width:${w}px;height:10px;display:block;margin-bottom:3px;`;
      statsShimmer.appendChild(s);
    });
    headerStats.innerHTML = '';
    headerStats.appendChild(statsShimmer);

    // Skeleton rows — preserve structural orientation
    const skelGroups = [
      { label: 'system', rows: [
        { widths: [130], hasIcon: true },
        { widths: [112], hasIcon: true },
        { widths: [80], hasIcon: true },
      ]},
      { label: 'paths', rows: [
        { widths: [118], hasExpand: true },
        { widths: [90], indent: 1 },
        { widths: [110], indent: 1 },
        { widths: [148] },
        { widths: [60], hasExpand: true },
        { widths: [94], indent: 1 },
        { widths: [78], indent: 1 },
        { widths: [162] },
      ]},
      { label: 'tools', rows: [
        { widths: [46], hasExpand: true },
        { widths: [40] },
        { widths: [58] },
      ]},
    ];

    const frag = document.createDocumentFragment();
    let firstGroup = true;
    for (const grp of skelGroups) {
      if (!firstGroup) {
        const sep = document.createElement('hr');
        sep.className = 'bucket-sep';
        frag.appendChild(sep);
      }
      firstGroup = false;

      const lbl = document.createElement('div');
      lbl.className = 'section-label skel-label';
      lbl.textContent = grp.label;
      frag.appendChild(lbl);

      for (const rowDef of grp.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'skel-row' + (rowDef.indent ? ` indent-${rowDef.indent}` : '');

        const cbSkel = document.createElement('span');
        cbSkel.className = 'skel skel-cb';
        rowEl.appendChild(cbSkel);

        if (rowDef.hasIcon) {
          const iconSkel = document.createElement('span');
          iconSkel.className = 'skel skel-icon';
          rowEl.appendChild(iconSkel);
        }
        if (rowDef.hasExpand) {
          const expandSkel = document.createElement('span');
          expandSkel.className = 'skel skel-expand';
          rowEl.appendChild(expandSkel);
        }

        const nameSkel = document.createElement('span');
        nameSkel.className = 'skel skel-name';
        nameSkel.style.maxWidth = `${rowDef.widths[0]}px`;
        rowEl.appendChild(nameSkel);

        const rightDiv = document.createElement('div');
        rightDiv.className = 'bucket-right';
        const tokSkel = document.createElement('span');
        tokSkel.className = 'skel skel-tokens';
        const barSkel = document.createElement('span');
        barSkel.className = 'skel skel-barwrap';
        rightDiv.appendChild(tokSkel);
        rightDiv.appendChild(barSkel);
        rowEl.appendChild(rightDiv);

        frag.appendChild(rowEl);
      }
    }
    treeEl.appendChild(frag);

    // Footer: reset to non-dirty state
    resetBtn.classList.remove('active');
  }

  function updateSyncState() {
    const transport = ctx?.transport;
    const bs = transport?.bucketState ?? {};
    const isFetching = bs.isFetching ?? false;
    const consecutiveFailures = bs.consecutiveFailures ?? 0;
    const lastSuccessAt = bs.lastSuccessAt ?? null;

    clearStaleInterval();

    // Reset styles first
    sweepTrack.style.display = 'none';
    statusBar.style.display = 'none';
    statusBar.innerHTML = '';
    card.removeAttribute('data-state');
    donutWrap.classList.remove('donut-syncing');

    if (!state.lastGoodBucketData) return; // skeleton — no sync state

    if (isFetching) {
      // State 2a: syncing
      card.dataset.state = 'syncing';
      sweepTrack.style.display = '';
      donutWrap.classList.add('donut-syncing');
      statusBar.style.display = '';
      const chip = document.createElement('span');
      chip.className = 'status-chip chip-syncing';
      chip.setAttribute('role', 'status');
      chip.setAttribute('aria-live', 'polite');
      chip.setAttribute('aria-label', 'Syncing bucket data');
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.setAttribute('aria-hidden', 'true');
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(' syncing…'));
      statusBar.appendChild(chip);
    } else if (consecutiveFailures >= 1 && lastSuccessAt) {
      // State 2b: stale
      card.dataset.state = 'stale';
      statusBar.style.display = '';
      const chip = document.createElement('span');
      chip.className = 'status-chip chip-stale';
      chip.setAttribute('role', 'status');
      chip.setAttribute('aria-live', 'polite');

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.setAttribute('aria-hidden', 'true');
      chip.appendChild(dot);

      const chipText = document.createTextNode('');
      chip.appendChild(chipText);

      function updateStaleText() {
        const elapsed = Math.round((Date.now() - lastSuccessAt) / 1000);
        chipText.textContent = ` last updated ${elapsed}s ago · retrying`;
        chip.setAttribute('aria-label', `Data may be stale — last updated ${elapsed} seconds ago, retrying`);
      }
      updateStaleText();
      staleInterval = setInterval(updateStaleText, 1000);

      statusBar.appendChild(chip);
    }
  }

  // ── update(snapshot) ──────────────────────────────────────────────────────
  function update(snapshot) {
    // 1. Last-good preservation + 3-state UX
    let bd = snapshot?.bucketData;
    if (!bd) bd = state.lastGoodBucketData;
    if (!bd) {
      // Restore stats area to shimmer form if we had replaced it
      if (!headerStats.querySelector('.stat-selected')) {
        // Stats area was replaced by skeleton shimmer; restore structure
        headerStats.innerHTML = '';
        headerStats.appendChild(statSelectedEl);
        headerStats.appendChild(statDiscardedEl);
      }
      renderSkeleton();
      return;
    }

    // First successful bucket data — write-once
    if (!state.lastGoodBucketData) {
      state.lastGoodBucketData = bd;
      subtitle.textContent = 'rebuild cost · uncheck to draft compact';
      // Restore stats area
      headerStats.innerHTML = '';
      headerStats.appendChild(statSelectedEl);
      headerStats.appendChild(statDiscardedEl);
    } else if (bd !== state.lastGoodBucketData) {
      state.lastGoodBucketData = bd;
    }

    // 2. Segment-change GC
    const currentSegment = snapshot?.status?.segment ?? bd.segment ?? null;
    if (currentSegment !== state.prevSegment) {
      state.selectionOverrides.clear();
      state.collapsedOverrides.clear();
      state.prevSegment = currentSegment;
      dispatchPreview(true); // clear ghost
    }

    // 3. B_default
    state.B_default = snapshot?.status?.rateLamp?.B_rebuild ?? bd.totalB ?? 0;

    // 4. Build tree
    state.tree = buildTree(bd);

    // 5. Apply overrides
    applyOverrides(state.tree, state.selectionOverrides);

    // 6. Collapse reapply
    for (const dirNode of flattenDirs(state.tree)) {
      if (state.collapsedOverrides.has(dirNode.id)) {
        dirNode.collapsed = state.collapsedOverrides.get(dirNode.id);
      }
    }

    // 7. Override GC
    const liveLeafIds = new Set(flattenLeaves(state.tree).filter(n => n.selectable).map(n => n.id));
    for (const k of state.selectionOverrides.keys()) {
      if (!liveLeafIds.has(k)) state.selectionOverrides.delete(k);
    }
    const liveDirIds = new Set(flattenDirs(state.tree).map(n => n.id));
    for (const k of state.collapsedOverrides.keys()) {
      if (!liveDirIds.has(k)) state.collapsedOverrides.delete(k);
    }

    // 8. Render tree + donut + stats + footer (hover restored after if still active)
    render();

    // 8b. Restore hover if a row was hovered before re-render
    if (_hoveredNodeId) {
      const node = findNodeById(state.tree, _hoveredNodeId);
      if (node && node.lastCallSeq != null) {
        const touchSeqs = node.touchSeqs ?? null;
        const tier = node.churnTier ?? 'mint';
        const group = node.group ?? 'paths';
        const name = node.displayName ?? node.name ?? '';
        dispatchHover({ lastCallSeq: Number(node.lastCallSeq), name, touchSeqs, tier, group });
      } else {
        _hoveredNodeId = null;
        dispatchHover(null);
      }
    }

    // 9b. Update sync state chip/sweep
    updateSyncState();

    // 10. Dirty refresh
    if (computeDirty(state.tree)) dispatchPreview();
  }

  // ── refreshDerived: update visuals after a selection change ──────────────
  function refreshDerived() {
    render();
    dispatchPreview();
  }

  // ── showCopyOverlay: fallback when clipboard API fails ────────────────────
  function showCopyOverlay(text) {
    // Remove any existing overlay first
    const existing = card.querySelector('.bucket-copy-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bucket-copy-overlay';

    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.setAttribute('aria-label', 'Compact instruction text — select all and copy');

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'bucket-copy-overlay-dismiss';

    overlay.appendChild(ta);
    overlay.appendChild(dismissBtn);
    card.appendChild(overlay);

    // Auto-select the text for convenience
    ta.focus();
    ta.select();

    dismissBtn.addEventListener('click', () => overlay.remove(), { once: true });
  }

  // ── Copy timeout ref (cleaned up in destroy) ──────────────────────────────
  let copyTimeout = null;

  // ── Checkbox toggle (delegated) ────────────────────────────────────────────
  treeEl.addEventListener('click', (e) => {
    const cbEl = e.target.closest('.bucket-cb');
    if (!cbEl) return; // not a checkbox click
    const row = cbEl.closest('.bucket-row');
    if (!row) return;
    const id = row.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.locked || !node.selectable) return;

    if (node.kind === 'dir') {
      // Directory toggle: batch all descendant selectable leaves
      const dirState = deriveDirState(node);
      const target = dirState !== 'checked'; // checked → uncheck all; else check all
      for (const leaf of flattenLeaves(node.children)) {
        if (leaf.selectable) {
          leaf.selected = target;
          state.selectionOverrides.set(leaf.id, target);
        }
      }
    } else {
      // Leaf toggle
      node.selected = !node.selected;
      state.selectionOverrides.set(id, node.selected);
    }
    refreshDerived();
  });

  // ── Directory fold (click dir row body, NOT checkbox) ─────────────────────
  treeEl.addEventListener('click', (e) => {
    if (e.target.closest('.bucket-cb')) return; // checkbox handled above
    const row = e.target.closest('.bucket-row');
    if (!row) return;
    const id = row.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.kind !== 'dir') return;

    node.collapsed = !node.collapsed;
    state.collapsedOverrides.set(node.id, node.collapsed);

    // Toggle visibility of children container
    const childrenContainer = row.nextElementSibling;
    if (childrenContainer?.classList.contains('bucket-dir-children')) {
      childrenContainer.style.display = node.collapsed ? 'none' : '';
    }
    // Toggle expand glyph class
    const expand = row.querySelector('.bucket-expand');
    if (expand) expand.classList.toggle('collapsed', node.collapsed);
  });

  // ── Section-level fold (click section label) ───────────────────────────────
  treeEl.addEventListener('click', (e) => {
    const lbl = e.target.closest('.section-label');
    if (!lbl) return;
    const section = lbl.dataset.section;
    if (!section) return;
    state.sectionCollapsed[section] = !state.sectionCollapsed[section];
    lbl.classList.toggle('collapsed', state.sectionCollapsed[section]);
    const group = lbl.nextElementSibling;
    if (group?.classList.contains('section-group')) {
      group.classList.toggle('collapsed', state.sectionCollapsed[section]);
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────────
  resetBtn.addEventListener('click', () => {
    state.selectionOverrides.clear();
    applyOverrides(state.tree, state.selectionOverrides);
    render();
    dispatchPreview(true); // force dirty:false
  });

  // ── Copy + overlay fallback ────────────────────────────────────────────────
  copyBtn.addEventListener('click', async () => {
    const text = buildCompactInstruction(state.tree);
    if (!text) return;  // nothing to compact
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.classList.add('copied');
      copyBtn.textContent = '✓ Copied';
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copy instructions';
        copyTimeout = null;
      }, COPY_FEEDBACK_MS);
    } catch {
      showCopyOverlay(text);
    }
  });

  // ── Hover linkage ──────────────────────────────────────────────────────────
  treeEl.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.bucket-row');
    if (!row) return;
    // Guard: if we're moving between child elements of the same row, ignore
    if (row.contains(e.relatedTarget)) return;
    const lastCallSeq = row.dataset.lastCallSeq;
    if (lastCallSeq != null) {
      const name = row.querySelector('.bucket-name')?.textContent || '';
      const id = row.dataset.id;
      const node = findNodeById(state.tree, id);
      const touchSeqs = node?.touchSeqs ?? null;
      const tier = node?.churnTier ?? 'mint';
      const group = node?.group ?? 'paths';
      _hoveredNodeId = id;
      dispatchHover({ lastCallSeq: Number(lastCallSeq), name, touchSeqs, tier, group });
    }
  });

  treeEl.addEventListener('mouseout', (e) => {
    const row = e.target.closest('.bucket-row');
    if (!row) return;
    // Guard: if we're moving to a child element of the same row, ignore
    if (row.contains(e.relatedTarget)) return;
    _hoveredNodeId = null;
    dispatchHover({ lastCallSeq: null });
  });

  // ── Keyboard a11y ──────────────────────────────────────────────────────────
  treeEl.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const row = e.target.closest('.bucket-row');
    if (!row) return;
    const id = row.dataset.id;
    const node = findNodeById(state.tree, id);
    if (!node || node.locked || !node.selectable) return;
    e.preventDefault();
    if (node.kind === 'dir') {
      const dirState = deriveDirState(node);
      const target = dirState !== 'checked';
      for (const leaf of flattenLeaves(node.children)) {
        if (leaf.selectable) {
          leaf.selected = target;
          state.selectionOverrides.set(leaf.id, target);
        }
      }
    } else {
      node.selected = !node.selected;
      state.selectionOverrides.set(id, node.selected);
    }
    refreshDerived();
  });

  // ── destroy() ─────────────────────────────────────────────────────────────
  function destroy() {
    clearStaleInterval();
    if (copyTimeout) { clearTimeout(copyTimeout); copyTimeout = null; }
    const overlay = card.querySelector('.bucket-copy-overlay');
    if (overlay) overlay.remove();
    for (const t of state._bodyTips) t.remove();
    state._bodyTips.length = 0;
    if (unsubBucketState) unsubBucketState();
    dispatchHover(null);
    dispatchPreview(true);
    card.remove();
  }

  // Subscribe to bucket-state changes for reactive sync chip updates
  const unsubBucketState = ctx?.transport?.onBucketState?.(() => {
    if (state.lastGoodBucketData) updateSyncState();
  });

  // Render skeleton on mount (before first update)
  renderSkeleton();

  return { update, destroy };
}
