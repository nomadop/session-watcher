// The opt-in pi-ai adapter entry of the session watcher's DSH package (`@nomadop/session-watcher-dsh/pi-ai`): its carrier cache point over the checkout `SW_DSH_CHECKOUT` names. The built entry is loaded through a temporary profile's runtime resolution in a fresh process (`test/helpers/dsh-shipped-entry.js`) and mounted on a real Cordis context beside the real llm service and the real pi-ai adapter, whose native serializers write the requests the loopback endpoints record. Without the checkout every case skips.
import test from 'node:test';

import { runShippedScenario, shippedEntrySkip } from './helpers/dsh-shipped-entry.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SHIPPED = { skip: shippedEntrySkip(CHECKOUT), timeout: 120_000 };
// Fixture-only switches of the installed pi-ai Bedrock provider: no request signing with real credentials, and HTTP/1.1 to the plain loopback endpoint.
const PI_AI = { child: 'dsh-pi-ai-child.js', timeout: 120_000, env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_BEDROCK_FORCE_HTTP1: '1' } };

test('a request holding no carrier through the replacement entry reaches the Anthropic endpoint as the original adapter sends it, the same body and attribution headers', SHIPPED, (t) => {
  runShippedScenario(t, 'parity-without-carrier', CHECKOUT, PI_AI);
});

test('H C1 C2 C3 A on Anthropic Messages: the last whole carrier ends in the native cache marker while every earlier carrier, the system prompt, the tools and the native tail point are the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-carrier-point', CHECKOUT, PI_AI);
});

test('the carrier a seal has just appended is the request\'s last message: the native tail point already ends it and the request is the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-carrier-last', CHECKOUT, PI_AI);
});

test('a route that keeps prompts for long gives the last carrier the same lifetime as its native points', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-long-retention', CHECKOUT, PI_AI);
});

test('a route whose profile turns caching off keeps the original request, the last carrier given no point', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-caching-off', CHECKOUT, PI_AI);
});

test('an Anthropic request whose four native points leave the carrier none is the original adapter\'s request, and one warning names the route', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-no-free-point', CHECKOUT, PI_AI);
});

test('H C1 C2 C3 A on Bedrock Converse: a standalone cache point block ends the last whole carrier, and the rest of the request is the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'bedrock-carrier-point', CHECKOUT, PI_AI);
});

test('the carrier a seal has just appended is Bedrock\'s last message: the native tail point already closes it and no second cache point block is added', SHIPPED, (t) => {
  runShippedScenario(t, 'bedrock-carrier-last', CHECKOUT, PI_AI);
});

test('a Bedrock route that keeps prompts for long gives the last carrier the lifetime of its native points', SHIPPED, (t) => {
  runShippedScenario(t, 'bedrock-long-retention', CHECKOUT, PI_AI);
});

test('a Bedrock request with caching off by profile, or for a model the serializer writes no cache point for, is the original adapter\'s request', SHIPPED, (t) => {
  runShippedScenario(t, 'bedrock-no-native-points', CHECKOUT, PI_AI);
});

test('H C1 C2 C3 A on Responses with a model that takes explicit breakpoints and the switch on: the last whole carrier\'s final input_text block carries one, and the request\'s mode, key and options and every other block are the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-carrier-point', CHECKOUT, PI_AI);
});

test('a Responses route whose profile turns caching off is sent explicit-only mode with the switch on, and the request gets no breakpoint for its carrier', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-caching-off', CHECKOUT, PI_AI);
});

test('a long retention Responses route keeps its request-level lifetime and the carrier\'s breakpoint names none of its own', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-long-retention', CHECKOUT, PI_AI);
});

test('a carrier that is the last Responses input item is the original adapter\'s request, the latest message\'s implicit breakpoint already ending it', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-carrier-last', CHECKOUT, PI_AI);
});

test('a hand-declared Responses route that declares the explicit-breakpoint capability keeps it with the switch on, and its last carrier ends in the breakpoint where the earlier ones do not', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-custom-opt-in', CHECKOUT, PI_AI);
});

test('the Responses breakpoint switch on, a request that gets a breakpoint: its last carrier ends in it and the request carries the options the serializer writes for a route that declares explicit prompt-cache mode, a long route\'s 24-hour retention given way to the 30-minute lifetime, whether the route\'s profile declares nothing or the capability false, and a catalog model that takes breakpoints keeps its own options', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-on', CHECKOUT, PI_AI);
});

test('the Responses breakpoint switch on, a request that gets no breakpoint, whether it holds no carrier, ends in its carrier or is sent with caching off, is the request the original adapter writes, the 24-hour retention of a long route and every other wire field included, and a profile declaring the capability false changes none of it', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-skips', CHECKOUT, PI_AI);
});

test('the Responses breakpoint switch off, or no host service at all: no Responses route is given a breakpoint, the catalog models and the routes that declare the capability included, and the request is the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-off', CHECKOUT, PI_AI);
});

test('the Responses breakpoint switch is read once for each Responses request, and no settings service, one with no such member, one whose answer is not true and one that cannot answer each leave the request the original adapter\'s, the last with one warning', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-unreadable', CHECKOUT, PI_AI);
});

test('the host\'s saved Responses breakpoint switch reaches the replacement\'s hook across the two entries of one context: off while nothing is saved or it is saved off, and a saved on gives a route whose model declares no capability the breakpoint on its last carrier', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-host', CHECKOUT, PI_AI);
});

test('the Responses breakpoint switch leaves the other protocols alone: the Anthropic, Bedrock and Chat Completions gateway points are the same with it on and off', SHIPPED, (t) => {
  runShippedScenario(t, 'responses-switch-other-protocols', CHECKOUT, PI_AI);
});

test('H C1 C2 C3 A on a Chat Completions gateway that takes Anthropic-format cache markers: the last whole carrier\'s final text part carries the marker and the rest of the request is the original adapter\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'completions-gateway-point', CHECKOUT, PI_AI);
});

test('a Chat Completions endpoint of unstated format, one whose profile turns caching off and a carrier that is the last message are each the original adapter\'s request', SHIPPED, (t) => {
  runShippedScenario(t, 'completions-no-extra-point', CHECKOUT, PI_AI);
});

test('the real loop over the replacement entry through two seals, the second asked for again after a reply that is not the notes: every main, auxiliary and retried request holds its last carrier ending in a marker, one point beyond the native ones, and no earlier carrier has one', { ...SHIPPED, timeout: 240_000 }, (t) => {
  runShippedScenario(t, 'loop-carrier-cache', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('the activation composition on the real Loader, the original llm-pi-ai row off and carrying the profile dictionary and the replacement mounted under its own id with no configuration: the replacement reads the original row\'s composed configuration at startup, the routes and the configurable-provider directory are its alone, no second copy of the dictionary exists, and a request through the llm service carries the carrier point, the stored credential and the attribution headers', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-activation', CHECKOUT, PI_AI);
});

test('the session watcher\'s host over the llm and Settings services of the activation composition and the replacement\'s sibling status prices a session under the lifetime its route\'s profile declares in the original row\'s configuration', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-retention-pricing', CHECKOUT, PI_AI);
});

test('a profile written through the Settings service under the namespace the replacement\'s directory names is refused and changes neither patch layer', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-settings-write', CHECKOUT, PI_AI);
});

test('the replacement entry owes a request what the original adapter does besides its body: the request-headers contributors see its purpose and session, and a route naming a credential that is not stored fails before any request leaves with the same failure', SHIPPED, (t) => {
  runShippedScenario(t, 'headers-and-credentials', CHECKOUT, PI_AI);
});

test('an assistant turn the adapter produced is replayed through the replacement entry as the original adapter replays it, the carrier point the request\'s one difference', SHIPPED, (t) => {
  runShippedScenario(t, 'replay-parity', CHECKOUT, PI_AI);
});

test('the two entries the package exports resolve by name through the profile\'s runtime resolution: the host entry is unchanged and the opt-in pi-ai entry is a plugin of its own with the profile schema, injecting the llm service under a name that is not the original\'s', SHIPPED, (t) => {
  runShippedScenario(t, 'entries', CHECKOUT, PI_AI);
});

test('a carrier is told by its opening text alone: the wording quoted or after other text is no carrier, and a message that opens with it is given the point, which changes the cache marker only', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-identification', CHECKOUT, PI_AI);
});

test('the reported sequence H C1 C2 C3 A, the rewarm as A grows and the seal that replaces A with C4, as payload shapes: each request\'s last carrier ends in a marker and the content ahead of C4 reads the same as the content ahead of the rewarmed A (no claim of an upstream cache hit)', SHIPPED, (t) => {
  runShippedScenario(t, 'rewarm-then-seal', CHECKOUT, PI_AI);
});

test('the four native points of the OAuth lane include the one ending a carrier that is the last message: the request is the original adapter\'s and no warning is written', SHIPPED, (t) => {
  runShippedScenario(t, 'anthropic-carrier-last-on-full-lane', CHECKOUT, PI_AI);
});

test('both the original llm-pi-ai row and the replacement on, which the activation composition never does: the replacement serves no route and declares no directory entry, and the original alone serves its routes', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-both-rows-on', CHECKOUT, PI_AI);
});

test('a source configuration the replacement cannot use, over the real Loader: one the schema refuses, one the adapter\'s own resolution refuses and one holding a !!js node each leave it serving no route and declaring no directory entry, naming source-invalid on its service and writing no value of the configuration', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-source-invalid', CHECKOUT, PI_AI);
});

test('a source row the Loader cannot resolve leaves the replacement serving no route with source-missing on its service, while a row with no configuration at all is the dormant original and no failure', SHIPPED, (t) => {
  runShippedScenario(t, 'source-missing', CHECKOUT, PI_AI);
});

test('the integration status over the real RPC channel with the host and the replacement as siblings of one context: no failure with no replacement mounted or with one serving, and its cause with none of a session', { ...SHIPPED, timeout: 240_000 }, (t) => {
  runShippedScenario(t, 'integration-status', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('both rows on, the original adapter serving: the host prices a route that declares long retention under the long lifetime through Settings, the failed replacement holding no authority over it', SHIPPED, (t) => {
  runShippedScenario(t, 'loader-both-rows-on-pricing', CHECKOUT, PI_AI);
});

test('every closed result the wrapped hook leaves, over the real pi-ai serializers and loopback endpoints and read through the scope around the stream: the point added, a native point reused at the same position, and each reason a carrier was checked and given none', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-evidence-results', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('the evidence of a request is the one of the scope around its own stream: overlapping scopes of one adapter and an unscoped request are told apart, results keep their order, the list is bounded, and a service that cannot record leaves the request as it was', { ...SHIPPED, timeout: 240_000 }, (t) => {
  runShippedScenario(t, 'carrier-evidence-binding', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('the switch over the real Loader, plugin manager and Connection of an isolated profile: the carrier bundle selected takes the routes over, which the next request shows, and deselected gives them back to the native adapter, whose restoration the host reports as proven', { ...SHIPPED, timeout: 240_000 }, (t) => {
  runShippedScenario(t, 'carrier-switch-takeover', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('a selection of the carrier bundle that does not end in a confirmed takeover is rolled back by deselecting it, and what the rollback verified of the saved selection and the running composition names the outcome: rolled back with the native adapter proven, withdrawn with its restoration unconfirmed, or rollback failed', { ...SHIPPED, timeout: 240_000 }, (t) => {
  runShippedScenario(t, 'carrier-switch-rollback', CHECKOUT, { ...PI_AI, timeout: 240_000 });
});

test('a selection the plugin manager reports as waiting for a restart is unchecked, so the switch withdraws what it saved instead of leaving a substitution for the next start: a startup-only profile and a manager whose answer is restart-required for a change that took effect both end rolled back with the restart named as the reason, the native adapter serving', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-restart', CHECKOUT, PI_AI);
});

test('a startup-only profile that started with the carrier bundle selected keeps the replacement mounted after a deselection: the status is pending and never off, an applied answer that left it mounted is a failure, and withdrawing an unconfirmed selection with it still mounted is a failed rollback; the page\'s store reads the same', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-started-selected', CHECKOUT, PI_AI);
});

test('a third adapter that takes a route the moment the original releases it leaves the replacement refused and the original unmounted, so the withdrawn replacement is reported with the original\'s restoration unconfirmed even though the route list still names the route', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-competitor', CHECKOUT, PI_AI);
});

test('a confirmed takeover is read again from the running composition at each status: an edit of the dictionary the replacement does not follow, and the original row switched on again beside it, each take the on away', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-drift', CHECKOUT, PI_AI);
});

test('the carrier bundle is managed by the owner alone: a guest peer or none reaches neither the status nor the manager, the owner\'s peer is let through, the body cannot name another target, and a request with no session never reaches the handler', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-auth', CHECKOUT, PI_AI);
});

test('one selection of the carrier bundle runs at a time: a second request meanwhile is answered busy and reaches no manager, and the guard is released after a selection that failed', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-guard', CHECKOUT, PI_AI);
});

test('a profile with no plugin manager, or whose manager does not list the carrier bundle, has no switch: status and selection answer unavailable and change nothing', SHIPPED, (t) => {
  runShippedScenario(t, 'carrier-switch-unavailable', CHECKOUT, PI_AI);
});
