// public/lib/redaction.js — front-end copy of redactCmd (defense-in-depth at the DOM/clipboard sink)
// Keep in sync with lib/measure.js redactCmd — shared test asserts identical output.

/**
 * Privacy scrubbing for display/clipboard. Applied as defense-in-depth over server extraction.
 * Masks: env secrets, CLI token flags, Bearer tokens, HTTP basic-auth, home paths, user@ip.
 */
export function redactCmd(cmd) {
  return String(cmd)
    .replace(/\b[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)\s*=\s*\S+/gi, (m) => m.split('=')[0] + '=***')
    .replace(/(--?(?:token|api[-_]?key|password|pass|secret)[=\s]+)\S+/gi, '$1***')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 ***')
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@')
    .replace(/\/(home|Users|root)\/[^/\s]+/g, '~')
    .replace(/\b\w+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***@<ip>');
}
