// The inner seal over the real DSH loop of the checkout `SW_DSH_CHECKOUT` names. The built host entry is loaded through a temporary profile's runtime resolution in a fresh process (`test/helpers/dsh-shipped-entry.js`) and runs beside the real native consumers each case names. Without the checkout every case skips.
import test from 'node:test';

import { runShippedScenario, shippedEntrySkip } from './helpers/dsh-shipped-entry.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SHIPPED = { skip: shippedEntrySkip(CHECKOUT), timeout: 120_000 };

test('G4: beside the stock compaction-basic and session checkpoint policy mounted before it, the prepended seal runs ahead of both, so the stock pressure check reads the sealed surface and compacts nothing where the same history with the mode off is compacted, and the checkpoint\'s pre-step flush persists the sealed surface', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-g4', CHECKOUT);
});

const LOOP = { child: 'dsh-inner-seal-loop-child.js', timeout: 120_000 };

test('consecutive seals over the real tools and skill from an empty state: each auxiliary call runs under the pre-step selection before the step, its input cut at its own preparation after the frozen slice and before anything its consumption sees appended, the second carrier carries only what changed against the first, an unreadable held path reaches the next request with its reason and hint, B\'s observation lets an edit through where a rewrite between its stat and read fails one, the raw log keeps every call and result once, and each session\'s own JSONL log, natively restored, and Store rebuild cold to the off-mode control\'s attribution and statistics, the carried chain equal to the disk on its held lines and the control\'s accepted skill payload', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-seals', CHECKOUT, LOOP);
});

test('the stock entries beside the seal, each firing alone: the step pressure after /sw-continue, its first seal and a second, and a skeleton call answered by /sw-load compacts all before the second carrier, and the seal recounts from that checkpoint over its kept tail, the old carrier, the payload and the answered call ordinary unpaused source, its B only what the new epoch read, in the same later segment under the user\'s overrides and the lamp\'s clocks', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-stock', CHECKOUT, LOOP);
});

test('a session with no mode record and one whose record follows its first turn stay off however long they run, and a seal over the native pruner\'s second replacement under a tighter budget cites the original result it stands for', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-records-and-pruner', CHECKOUT, LOOP);
});

test('the Rate Lamp in a later segment: its clocks stand at zero while the calls are pending, the seal\'s post moves the bill clock under the same state key and the calls behind the post move none, beside the user\'s override and the saved archives', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-lamp', CHECKOUT, LOOP);
});

test('consecutive user-triggered failures through the real loop: a content_filtered stop on every rung of the ladder, the session\'s model, its repeat and the saved backup model, and then a stream ending in tool calls, are each a fresh dispatch recorded once with its raw outcome, and each failed turn ends without pruning, replacing, executing the emitted tool call or changing the mode or range, and the next attempt seals the same range', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-repeated-failures', CHECKOUT, LOOP);
});

test('a summary reply that finishes normally and is not the notes object, through the shipped host and the real loop: the seal asks again over the same request inside the turn, each request an attempt of its own, the failed ones ended with their calls recorded and the third sealing with one prune and one carrier', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-format-retry', CHECKOUT, LOOP);
});

test('a summary reply that finishes normally and fails JSON syntax alone, through the shipped host and the real loop: the library the host bundles recovers it locally, so the seal commits after the one request with no failed attempt and no second dispatch, its first note as the model meant it', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-summary-recovery', CHECKOUT, LOOP);
});

test('the quote through the shipped host: a seal over text-only turns quotes L_A as the range\'s characters at the calibrated pair of the session\'s epoch model, so a model the policy calibrates and one it does not quote the same text apart, while the prune of both keeps the meter\'s own heuristic count', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-quote', CHECKOUT, LOOP);
});

test('the questions a step asked the user through the shipped host: a call the real loop ran and a stand-in for the question tool answered is carried as each question\'s original text and the user\'s own answer beside the step\'s note, without the options and their descriptions, and the step\'s request after the seal carries the body that source renders', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-asks', CHECKOUT, LOOP);
});

test('a question call the real tool runtime refused through the shipped host: the step is sealed with no question, answer or raw call and result in their place', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-asks-error', CHECKOUT, LOOP);
});

test('the state block through the shipped host over the real todos unit and working directory service: the directory and the list written in the turn a seal falls in are read from the host\'s services and projection registry and shown in full, the items whose tools are not mounted are left out, the seal at a later turn\'s start shows the unit\'s reset as the empty list beside the directory as unchanged, and the seal after it shows the directory as unchanged and the list as empty again', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-state', CHECKOUT, LOOP);
});

test('children of the real subagent runtime: a plain subagent takes its parent\'s mode, on or off, as its own record before its first turn, and a fork whose inherited completed-turn prefix holds a checkpoint and a load counts that prefix\'s unsealed steps toward its seal', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-creation', CHECKOUT, LOOP);
});

test('the Rate Lamp\'s integer counters in a later segment: main usage growing fast enough that the interval the seal\'s post closes passes bill cycles, the counter stands with the clocks behind the post and is not wound back by the persisted ledger', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-lamp-counters', CHECKOUT, LOOP);
});

// Fixture-only switches of the installed pi-ai Bedrock provider: no request signing with real credentials, and HTTP/1.1 to the plain loopback endpoint.
const NATIVE = { child: 'dsh-inner-seal-native-child.js', timeout: 180_000, env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_BEDROCK_FORCE_HTTP1: '1' } };

test('the native adapters: consecutive seals through the real llm-pi-ai Responses adapter, resumed on a fresh context over the session\'s own log, each request body holding every resident carrier in surface order with readable file handles, the Bedrock adapter serializing a sealed session\'s auxiliary and main requests, and the mounted tools reading back the shadowed source, the carried text file and the saved image', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-native', CHECKOUT, NATIVE);
});

test('the first seal of a session whose first request carried the real workspace-instructions, time and skill-catalog contexts besides the task, through the real Responses adapter: the range opens with the first model step and the initial prefix is in no range, prune, slot or cited source, the auxiliary call and the next main request carrying its input items and system prompt verbatim ahead of the carrier', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-initial-prefix', CHECKOUT, NATIVE);
});

test('a fresh mode-on session that starts with /sw-load, through the real Responses adapter with the real contexts: the load payload, its read and its follow-up are admitted before the contexts prepared for the first request, and the first seal leaves all of them resident, not admitted again, and writes into B only the kept line rewritten since the load showed it', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-fresh-load', CHECKOUT, NATIVE);
});

test('a mode-on session cleared by /sw-continue, through the real Responses adapter with the real contexts: the first request after the clear logs a series header with no changed content, everything admitted before it, the load\'s payload, read and follow-up and the contexts, is the cleared epoch\'s initial prefix as in a new session, and the first seal leaves it resident and writes into B only the kept line rewritten since the load showed it', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-continue-prefix', CHECKOUT, NATIVE);
});

test('a held block the real Engine moved down its file: the next seal writes every held line, leaves out of its body the lines whose text the earlier carrier shows and shows the new ones, the earlier carrier\'s bytes in the request stay as they were, the chain still holds the left-out lines, and the host\'s resources are the off-mode run\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-relocation', CHECKOUT, NATIVE);
});

const STAGE_POINTS = { child: 'dsh-inner-seal-stage-points-child.js', timeout: 180_000 };

test('stage points through the real loop: with the seals fired in the middle of one long turn and at a later turn\'s start, the host watcher\'s history is exactly the epoch\'s head, the call right behind each carrier whatever opens its range, and the calls no seal replaced', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-chain', CHECKOUT, STAGE_POINTS);
});

test('stage points through the real loop over empties: the call right behind a carrier that the loop settled empty, by a stop with no block and by a tool call the output ceiling cut, stands in the host watcher\'s history with no other call of its range', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-empties', CHECKOUT, STAGE_POINTS);
});

test('stage points through the real loop with the real workspace-instructions and time contexts: whatever the loop admits behind a carrier, the call right behind it stands in the host watcher\'s history and the ranges\' other calls do not', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-contexts', CHECKOUT, STAGE_POINTS);
});

test('stage points through the real loop across ordinary changes: the prompt head replaced in place and a tool declared and withdrawn by the real producers leave the head and the call behind each carrier standing, the one behind the carrier whose range opens with the tool-registry message included', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-ordinary', CHECKOUT, STAGE_POINTS);
});

test('stage points through the real loop across ordinary changes on a route that declares a tool update mode: the tool-registry message reaches the request, and the same changes leave the same points', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-ordinary-in-history', CHECKOUT, STAGE_POINTS);
});

test('stage points through the real loop over a re-admitted runtime snapshot: the snapshot a seal replaced is admitted again ahead of the next request, and the call behind that carrier stands beside it', SHIPPED, (t) => {
  runShippedScenario(t, 'stage-points-runtime', CHECKOUT, STAGE_POINTS);
});

test('the wire after a step the output ceiling emptied, through the real Responses adapter: the assistant message with no block keeps its surface position and reaches the request body as no item', SHIPPED, (t) => {
  runShippedScenario(t, 'loop-empty-step-wire', CHECKOUT, NATIVE);
});
