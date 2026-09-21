// lib/harness/claude-code/cache-ttl.js — the prompt-cache lifetime this host requests for what it writes.
// The lifetime is an attribute of the harness's own request rather than of the model: the host chooses how
// long a cache entry should live and the provider prices that choice, so the declaration is reported
// verbatim and no price is named here. Which lifetime maps to which ratio belongs to the model policy
// table, and the one fallback there covers both a lifetime this application prices no write under and the
// absent declaration reported when the host asks for no lifetime of its own — which is what keeps this
// module free of a vocabulary the host can change without telling it. Surrounding whitespace is the one
// thing stripped, because a padded declaration names the same lifetime and the policy table keys on the
// token itself. An absent variable is the one spelling of a host that declared nothing.
//
// The sub-agent declaration governs a context this application never measures: a sidechain row emits no
// observation (test/claude-code.transcript-observation.test.js `a sidechain row emits no observation`), so
// the measured Context Stock is the main agent's alone and follows the main agent's declaration.
export function resolveClaudeCodeCacheTtl(env = process.env) {
  return env.CLAUDE_CODE_PROMPT_CACHE_TTL?.trim() ?? null;
}
