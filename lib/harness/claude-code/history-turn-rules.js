// lib/harness/claude-code/history-turn-rules.js — the Claude Code History Turn rules and the Dialogue
// Adapter that binds them.
//
// This is the only place a native local-command echo, a native tool name, or a native answer structure is
// read on the Dialogue side. Each rule answers with a classification and a text; the shared Turn Head
// constructor copies every source fact from the line the rule won on, so no coordinate is chosen here.

import { isAbsolute, join, normalize, resolve } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { ABSORB, PASS, groupTurns } from '../../turn.js';
import { projectDialogue } from '../../dialogue-fold.js';
import { safePrefix, safeSuffix } from '../../turn-history-budget.js';
import { resolveClaudeCodeToolTarget } from './native-tools.js';

// ── The human rule ────────────────────────────────────────────────────────────

// Wrapper blocks that carry no human intent of their own; removing them leaves the residue.
const TAG_BLOCKS = /<(command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+)>[\s\S]*?<\/\1>/g;
// The wrapped fragments that DO carry intent and are re-emitted as segments.
const CAPTURE = /<(command-name|command-args|bash-input)>([\s\S]*?)<\/\1>/g;
// The harness's own echo of the session-ending local command — see the ACK gate below.
const EXIT_ECHO = '<command-name>/exit</command-name>';
const EXIT_COMMAND = '/exit';

/**
 * Project one raw human message onto its cleaned intent, and judge whether it opens a Turn. The
 * judgement is made on the residue, never on the mere presence of a tag — a message that quotes
 * `<command-name>` inside its prose is a real question and keeps its full text.
 */
function cleanUserText(rawText) {
  const s = String(rawText || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  const captured = [];
  for (const m of s.matchAll(CAPTURE)) captured.push({ tag: m[1], text: m[2].trim() });
  const residue = s.replace(TAG_BLOCKS, '').trim();

  if (/^\[Request interrupted/.test(residue)) return null;
  if (!residue && captured.length === 0) return null;
  const segments = [];
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    if (c.tag === 'command-name') {
      const next = captured[i + 1];
      if (next && next.tag === 'command-args' && next.text) { segments.push(`${c.text} ${next.text}`); i++; }
      else segments.push(c.text);
    } else if (c.tag === 'bash-input') segments.push(`!${c.text}`);
  }
  if (residue) segments.push(residue);
  // Nothing survived the projection (args with no name, an empty command name): there is no intent to
  // open a Turn on, so it absorbs. Judged on the projection, symmetrically for every such shape.
  return segments.filter(Boolean).join(' — ') || null;
}

/**
 * The Claude Code rule for a visible human line. It owns every such line — HEAD, ACK or ABSORB — and
 * passes on everything else.
 *
 * @returns {function} a HistoryTurnHeadRule
 */
export function createClaudeCodeHumanHeadRule() {
  return (line) => {
    if (line.kind !== 'visible' || line.message.role !== 'human') return PASS;
    const raw = String(line.message.text ?? '');
    const cleaned = cleanUserText(raw);
    if (cleaned === null) return ABSORB;
    // The conjunction is what makes this the harness's echo rather than the string: the projection
    // excludes human prose that quotes the tag (that prose keeps residue), and the raw tag excludes a
    // human message whose whole body is literally the command. Claude Code writes the echo into the
    // transcript it is about to abandon, and a resume back into that same file appends its own
    // "No response requested." reply inside that Turn — harness acknowledgement, not this Turn's work.
    if (cleaned === EXIT_COMMAND && raw.includes(EXIT_ECHO)) return { kind: 'ACK', text: cleaned };
    return { kind: 'HEAD', text: cleaned };
  };
}

// ── The Ask rule ──────────────────────────────────────────────────────────────

const ASK_TOOL_NAME = 'AskUserQuestion';

// The degradation cut is bounded at BOTH ends on purpose. A changed structure is exactly the case where
// we no longer know where the ratification sits in the string, and today it sits at the tail (`"Q"="A"`
// after a fixed prefix) — a head-only cut of ASK_FALLBACK_HEAD loses it; bounding the tail at
// ASK_FALLBACK_TAIL keeps it.
const ASK_FALLBACK_HEAD = 200;
const ASK_FALLBACK_TAIL = 200;

// The structured path. `header` is a required field of the tool's schema and is the label the human saw on
// the chip, so it identifies the question in a fraction of its bytes. `annotations[q].notes` is where the
// picker records prose the human typed instead of choosing, and without it `answers` degrades to a literal
// placeholder on the richest rows. The placeholder is NOT stripped: matching its wording is the prose
// dependency this whole projection exists to avoid, and a placeholder's own characters cost less than a
// silent loss when that wording changes.
function projectAskAnswers(raw) {
  const answers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.answers : null;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { readable: false, cleaned: '' };
  const headers = new Map();
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    if (q && typeof q === 'object' && q.question != null) headers.set(String(q.question), q.header);
  }
  const segments = [];
  for (const [question, answer] of Object.entries(answers)) {
    const label = headers.get(question) ?? question;
    const notes = raw.annotations?.[question]?.notes;
    const body = notes ? `${answer} · ${notes}` : String(answer);
    segments.push(`${label} → ${body}`);
  }
  return { readable: true, cleaned: segments.join(' — ').trim() };
}

// The degradation. It parses NOTHING: no prefix match, no trailing-sentence strip, no field name — so its
// only failure mode is an ugly line, never a silent empty one. Newlines are unified first so the cut
// spends its budget on characters that survive — the same order the skeleton's cuts use.
function askFallbackCut(result) {
  const s = String(result ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  if (s.length <= ASK_FALLBACK_HEAD + ASK_FALLBACK_TAIL) return s;
  return safePrefix(s, ASK_FALLBACK_HEAD) + '…' + safeSuffix(s, ASK_FALLBACK_TAIL);
}

/**
 * The Claude Code rule for a ratified question. It runs after last-result-wins pairing, so the line it
 * judges already carries the answering row's content and annotation; the question's own row supplies
 * position, identity and time through the shared Turn Head constructor.
 *
 * A question the human dismissed with ESC, or one whose arguments failed validation, carries no
 * ratification at all — it is `CONTEXT.md` Absorbed Harness Evidence, the same class as
 * `[Request interrupted]`.
 *
 * @returns {function} a HistoryTurnHeadRule
 */
export function createClaudeCodeAskHeadRule() {
  return (line) => {
    if (line.kind !== 'tool' || line.tool.name !== ASK_TOOL_NAME) return PASS;
    if (line.tool.isError === true) return ABSORB;
    const structured = projectAskAnswers(line.tool.resultMeta?.annotation);
    // A READABLE structure is authoritative even when it projects to nothing; only an unreadable one
    // degrades to the raw string. Otherwise a deliberately empty answer would resurrect the envelope.
    const cleaned = structured.readable ? structured.cleaned : askFallbackCut(line.tool.result);
    if (!cleaned) return ABSORB;
    return { kind: 'HEAD', text: cleaned };
  };
}

// ── The bound Dialogue Adapter ────────────────────────────────────────────────

/**
 * The one Claude Code Dialogue Adapter. Its rule order is fixed here, so no consumer passes rules and no
 * visible-only fallback exists.
 *
 * After pairing it resolves each native target once and attaches the nullable `resourceKey` shared Turn
 * History reads: the skeleton's basenames, the snapshot digest and the search-terms index all take their
 * path cue from that field rather than resolving a native input of their own.
 *
 * @param {{ sessionCwd?: string|null }} [deps]
 * @returns {{ project: function, groupTurns: function }}
 */
export function createClaudeCodeDialogueProjection({ sessionCwd = null } = {}) {
  const context = { path: { join, isAbsolute, resolve, normalize }, homedir: osHomedir, sessionCwd };
  const rules = [
    createClaudeCodeHumanHeadRule(),
    createClaudeCodeAskHeadRule(),
  ];
  return {
    project(observations) {
      const { folds } = projectDialogue(observations);
      for (const fold of folds) {
        for (const pair of fold.toolPairs) {
          pair.resourceKey = resolveClaudeCodeToolTarget(pair, context);
        }
      }
      return { folds };
    },
    groupTurns(lines) {
      return groupTurns(lines, rules);
    },
  };
}
