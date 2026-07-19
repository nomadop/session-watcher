import test from 'node:test';
import assert from 'node:assert/strict';
import { charsToTokens, CJK_RE, canonicalizePath, extractToolResultText, parseBashFileRead, BUILTIN_ADAPTERS, matchAdapter, BRebuild, applyResidual, emaStep, gEffective } from '../lib/measure.js';

const CLAUDE = { ascii: 2.45, cjk: 0.59 };

test('charsToTokens: pure ASCII uses ascii CTP', () => {
  const s = 'abcdefghij'; // 10 chars
  assert.ok(Math.abs(charsToTokens(s, CLAUDE) - 10 / 2.45) < 1e-9);
});

test('charsToTokens: mixed CJK splits ascii and cjk components', () => {
  const s = 'ab你好'; // 2 ascii + 2 cjk
  const expected = 2 / 2.45 + 2 / 0.59;
  assert.ok(Math.abs(charsToTokens(s, CLAUDE) - expected) < 1e-9);
});

test('charsToTokens: asciiOnly fast path ignores CJK scan', () => {
  const s = 'ab你好';
  assert.ok(Math.abs(charsToTokens(s, CLAUDE, { asciiOnly: true }) - s.length / 2.45) < 1e-9);
});

test('charsToTokens: empty string is zero', () => {
  assert.equal(charsToTokens('', CLAUDE), 0);
});

test('CJK_RE is a global regex (reusable per call without lastIndex leakage in match())', () => {
  assert.ok(CJK_RE.global);
});

test('canonicalizePath: relative and ./ variants collapse to one absolute key', () => {
  const cwd = '/Users/me/project';
  const a = canonicalizePath('src/auth.js', cwd);
  const b = canonicalizePath('./src/auth.js', cwd);
  const c = canonicalizePath('/Users/me/project/src/auth.js', cwd);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('extractToolResultText: string passthrough', () => {
  assert.equal(extractToolResultText({ content: 'hello' }), 'hello');
});

test('extractToolResultText: array-of-parts joins text, drops non-text', () => {
  const block = { content: [
    { type: 'text', text: 'line1' },
    { type: 'image', source: {} },
    { type: 'text', text: 'line2' },
  ] };
  assert.equal(extractToolResultText(block), 'line1\nline2');
});

test('extractToolResultText: unknown shape → empty string', () => {
  assert.equal(extractToolResultText({ content: 42 }), '');
  assert.equal(extractToolResultText({}), '');
});

test('parseBashFileRead: cat → fullSet, head → head', () => {
  assert.deepEqual(parseBashFileRead('cat src/a.js'), { type: 'cat', path: 'src/a.js', effectiveCwd: null });
  assert.equal(parseBashFileRead('head -n 20 ./b.js').type, 'head');
});

test('parseBashFileRead: grep -n accepted, grep without -n skipped', () => {
  const g = parseBashFileRead('grep -n foo src/a.js');
  assert.equal(g.type, 'grep-n');
  assert.equal(g.path, 'src/a.js');
  assert.equal(parseBashFileRead('grep foo src/a.js'), null);
});

test('parseBashFileRead: tail skipped (no reliable line numbers)', () => {
  assert.equal(parseBashFileRead('tail -n 5 src/a.js'), null);
});

test('parseBashFileRead: cd prefix resolves effectiveCwd (last cd wins)', () => {
  const r = parseBashFileRead('cd src && cat a.js');
  assert.equal(r.type, 'cat');
  assert.equal(r.effectiveCwd, 'src');
});

test('parseBashFileRead: non-file commands → null', () => {
  assert.equal(parseBashFileRead('npm test'), null);
  assert.equal(parseBashFileRead('git log --oneline'), null);
});

// --- Heredoc / redirection patterns (not file reads) ---

test('parseBashFileRead: cat heredoc without redirect → null (no target file)', () => {
  assert.equal(parseBashFileRead("cat <<'EOF'\nhello\nEOF"), null);
  assert.equal(parseBashFileRead('cat <<EOF'), null);
  assert.equal(parseBashFileRead('cat <<"EOF"'), null);
  assert.equal(parseBashFileRead('cat <<-EOF'), null);
});

test('parseBashFileRead: cat heredoc with redirect → cat-write', () => {
  const r1 = parseBashFileRead("cat << 'EOF' > /tmp/file.py\nprint('hi')\nEOF");
  assert.equal(r1.type, 'cat-write');
  assert.equal(r1.path, '/tmp/file.py');
  assert.equal(r1.heredocBody, "print('hi')");

  const r2 = parseBashFileRead("cat <<EOF > src/config.js\nmodule.exports = {};\nEOF");
  assert.equal(r2.type, 'cat-write');
  assert.equal(r2.path, 'src/config.js');
  assert.equal(r2.heredocBody, 'module.exports = {};');

  // Indented heredoc (<<-)
  const r3 = parseBashFileRead("cat <<-END > /tmp/test.sh\necho hello\nEND");
  assert.equal(r3.type, 'cat-write');
  assert.equal(r3.path, '/tmp/test.sh');

  // Quoted marker variants
  const r4 = parseBashFileRead('cat <<"MARKER" > out.txt\nline1\nline2\nMARKER');
  assert.equal(r4.type, 'cat-write');
  assert.equal(r4.heredocBody, 'line1\nline2');
});

test('parseBashFileRead: cat heredoc write with shell expansion in path → null', () => {
  assert.equal(parseBashFileRead("cat <<EOF > $HOME/file.txt\ndata\nEOF"), null);
  assert.equal(parseBashFileRead("cat <<EOF > ~/file.txt\ndata\nEOF"), null);
});

test('parseBashFileRead: cat heredoc write with unterminated marker → null', () => {
  assert.equal(parseBashFileRead("cat <<EOF > /tmp/file.py\nno end marker"), null);
});

test('parseBashFileRead: heredoc body line that looks like a heredoc header is not false-matched', () => {
  // Body contains "cat <<INNER > /tmp/other.py" — must NOT match as header
  const cmd = "cat <<EOF > /tmp/file.py\ncat <<INNER > /tmp/other.py\nbody\nINNER\nmore\nEOF";
  const r = parseBashFileRead(cmd);
  assert.equal(r.type, 'cat-write');
  assert.equal(r.path, '/tmp/file.py');
  assert.equal(r.heredocBody, 'cat <<INNER > /tmp/other.py\nbody\nINNER\nmore');
});

test('parseBashFileRead: cat heredoc write with cd prefix → effectiveCwd', () => {
  const r = parseBashFileRead("cd src && cat <<EOF > config.js\nconst x = 1;\nEOF");
  assert.equal(r.type, 'cat-write');
  assert.equal(r.path, 'config.js');
  assert.equal(r.effectiveCwd, 'src');
  assert.equal(r.heredocBody, 'const x = 1;');
});

test('parseBashFileRead: cat with output redirection (no heredoc) → null', () => {
  assert.equal(parseBashFileRead('cat > file.txt'), null);
  assert.equal(parseBashFileRead('cat >> output.log'), null);
});

test('parseBashFileRead: leading comment line stripped (same as bashFeature)', () => {
  // Leading # comments are now stripped — grep/cat/head after comments is detected correctly.
  const r1 = parseBashFileRead('# Read the config\ncat config.json');
  assert.equal(r1.type, 'cat');
  assert.equal(r1.path, 'config.json');
  const r2 = parseBashFileRead('# check\ngrep -n "foo" src/a.js');
  assert.equal(r2.type, 'grep-n');
  assert.equal(r2.path, 'src/a.js');
});

// --- False-positive regression tests (corpus scan 2026-07-17) ---

test('parseBashFileRead: $() command substitution in cat/head → null', () => {
  // 18 occurrences in corpus. Regex captures "$(git" as a literal path.
  assert.equal(parseBashFileRead('cat "$(git rev-parse --show-toplevel)/.superpowers/sdd/progress.md" 2>/dev/null'), null);
  assert.equal(parseBashFileRead("cat '$(pwd)/file.js'"), null);
  assert.equal(parseBashFileRead('head -n 20 "$(dirname $0)/config.json"'), null);
});

test('parseBashFileRead: backtick command substitution → null', () => {
  assert.equal(parseBashFileRead('cat `git rev-parse --show-toplevel`/file.js'), null);
  assert.equal(parseBashFileRead('head -5 `pwd`/a.txt'), null);
});

test('parseBashFileRead: tilde path → null (cannot resolve without HOME)', () => {
  // 16 occurrences. canonicalizePath treats ~ as relative → "/workspace/~/.claude/..."
  assert.equal(parseBashFileRead('cat ~/.claude/settings.json'), null);
  assert.equal(parseBashFileRead('cat ~/.session-watcher/probe/nt-probe.jsonl'), null);
  assert.equal(parseBashFileRead('head -n 5 ~/some/file.txt'), null);
});

test('parseBashFileRead: grep with --include flag as last arg → skips flag, finds real path', () => {
  // 212 occurrences. "lastArg" heuristic picks --include="*.ts" instead of the directory.
  const r1 = parseBashFileRead('grep -rn "pattern" src/ --include="*.ts" --include="*.tsx"');
  assert.notEqual(r1, null);
  assert.equal(r1.path, 'src/');

  const r2 = parseBashFileRead('grep -rn "pattern" /workspace/ --include="*.js"');
  assert.notEqual(r2, null);
  assert.equal(r2.path, '/workspace/');

  // Also handle --exclude
  const r3 = parseBashFileRead('grep -rn "foo" lib/ --exclude="*.test.js"');
  assert.notEqual(r3, null);
  assert.equal(r3.path, 'lib/');
});

test('parseBashFileRead: grep with glob in path → null', () => {
  // 124 occurrences. Shell glob cannot be statically resolved.
  assert.equal(parseBashFileRead('grep -n "pattern" /path/to/*.py'), null);
  assert.equal(parseBashFileRead('grep -rn "foo" config/jest*'), null);
  assert.equal(parseBashFileRead('grep -n "bar" src/setupTests.*'), null);
});

test('parseBashFileRead: grep piped to grep -v → only considers first stage', () => {
  // 44 occurrences. Pipe not stripped, last token of "| grep -v pattern" becomes path.
  const r1 = parseBashFileRead('grep -n "deleteSession" /workspace/lib/store.js | grep -v "Stmt\\|prepare"');
  assert.notEqual(r1, null);
  assert.equal(r1.path, '/workspace/lib/store.js');

  const r2 = parseBashFileRead('grep -rn "foo" public/ --include="*.js" | grep -v ".test."');
  assert.notEqual(r2, null);
  assert.equal(r2.path, 'public/');

  const r3 = parseBashFileRead('grep -rn "bar" lib/watcher.js | grep -v "//\\|fallback"');
  assert.notEqual(r3, null);
  assert.equal(r3.path, 'lib/watcher.js');
});

test('parseBashFileRead: grep on "." (recursive, no specific file) → null', () => {
  // 14 occurrences. "." is the cwd directory, not a specific file target.
  assert.equal(parseBashFileRead('grep -rn "pattern" . --include="*.md"'), null);
  assert.equal(parseBashFileRead('grep -rn "foo" .'), null);
});

test('parseBashFileRead: /dev/null → null', () => {
  assert.equal(parseBashFileRead('grep -n "pattern" /dev/null'), null);
});

test('parseBashFileRead: cat/head with glob → null', () => {
  assert.equal(parseBashFileRead('cat /root/.session-watcher/*.json'), null);
  assert.equal(parseBashFileRead('cat /workspace/.claude/skills/*.md 2>/dev/null'), null);
  assert.equal(parseBashFileRead('head -5 src/setupTests.*'), null);
});

test('parseBashFileRead: grep pattern with spaces/special chars not mistaken for path', () => {
  // 349 occurrences. Grep patterns like "api/history\|paybackP\|kFitSlope }\]" contain
  // spaces that split incorrectly, plus / and . that pass the path heuristic.
  const r1 = parseBashFileRead('grep -n "api/history\\|paybackP\\|kFitSlope }\\]" /path/to/file.md');
  assert.notEqual(r1, null);
  assert.equal(r1.path, '/path/to/file.md');

  const r2 = parseBashFileRead('grep -n "app\\.use\\|renderHooks" /workspace/server.ts');
  assert.notEqual(r2, null);
  assert.equal(r2.path, '/workspace/server.ts');

  const r3 = parseBashFileRead("grep -n '§10\\.[0-9]\\|50 条' docs/spec.md");
  assert.notEqual(r3, null);
  assert.equal(r3.path, 'docs/spec.md');

  const r4 = parseBashFileRead('grep -nE "oz/user|留缺口" docs/spec.md');
  assert.notEqual(r4, null);
  assert.equal(r4.path, 'docs/spec.md');
});

const cwd = '/proj';

test('matchAdapter: Read/Write/Edit/Grep/Bash/Skill resolve; unknown → null', () => {
  for (const n of ['Read', 'Write', 'Edit', 'Grep', 'Bash', 'Skill']) assert.ok(matchAdapter(n), n);
  assert.equal(matchAdapter('mcp__serena__find_symbol'), null);
});

test('Read adapter: full read → fullSet parsed by actual line-number prefix', () => {
  const a = matchAdapter('Read');
  const result = '1\tconst a = 1;\n2\tconst b = 2;\n';
  const u = a.computeUpdate({ file_path: '/proj/a.js' }, result, cwd, CLAUDE);
  assert.equal(u.type, 'fullSet');
  assert.equal(u.lines.length, 2);
  assert.equal(u.lines[0][0], 1); // line number from prefix, not positional index
  assert.equal(u.overhead, 40);
});

test('Read adapter: wasted call (<100 chars, no newline) → null', () => {
  const a = matchAdapter('Read');
  assert.equal(a.computeUpdate({ file_path: '/proj/a.js' }, '<file too small hint>', cwd, CLAUDE), null);
});

test('Read adapter: truncated full read degrades to lineUpdate', () => {
  const a = matchAdapter('Read');
  const result = '1\tx\n2\ty\n(use offset to read more)';
  const u = a.computeUpdate({ file_path: '/proj/a.js' }, result, cwd, CLAUDE);
  assert.equal(u.type, 'lineUpdate');
});

test('Edit adapter: CJK swap produces non-zero token delta (Token-at-Ingestion)', () => {
  const a = matchAdapter('Edit');
  // 50 ASCII → 50 CJK: charsToTokens delta is +64 tok on Claude (spec §2.4), lineDelta 0.
  const u = a.computeUpdate({ old_string: 'a'.repeat(50), new_string: '好'.repeat(50) }, '', cwd, CLAUDE);
  assert.equal(u.type, 'editDelta');
  assert.ok(u.value > 60 && u.value < 70, `expected ~64, got ${u.value}`);
});

test('Grep adapter: multi-file result → grepMultiFile with canonicalized keys', () => {
  const a = matchAdapter('Grep');
  const result = 'src/a.js:10:foo()\nsrc/b.js:3:bar()\n';
  const u = a.computeUpdate({}, result, cwd, CLAUDE);
  assert.equal(u.type, 'grepMultiFile');
  assert.ok(u.files['/proj/src/a.js']);
  assert.equal(u.files['/proj/src/a.js'][0][0], 10);
});

test('Bash adapter: cat → fullSet, npm test → null', () => {
  const a = matchAdapter('Bash');
  const u = a.computeUpdate({ command: 'cat a.js' }, 'x\ny\n', cwd, CLAUDE);
  assert.equal(u.type, 'fullSet');
  assert.equal(a.computeUpdate({ command: 'npm test' }, 'ok', cwd, CLAUDE), null);
});

test('Bash adapter: cat heredoc write → write type with correct lines', () => {
  const a = matchAdapter('Bash');
  const cmd = "cat <<'EOF' > /tmp/test.py\nprint('hello')\nprint('world')\nEOF";
  const u = a.computeUpdate({ command: cmd }, '', cwd, CLAUDE);
  assert.equal(u.type, 'write');
  assert.equal(u.lines.length, 2);
  assert.equal(u.lines[0][0], 1);
  assert.equal(u.lines[1][0], 2);
  assert.ok(u.overhead === 90, 'uses Write overhead');
  assert.ok(u.spent > 0);
});

test('Bash adapter: cat heredoc write extractPath resolves target path', () => {
  const a = matchAdapter('Bash');
  const path = a.extractPath({ command: "cat <<EOF > src/app.js\nconst x=1;\nEOF" }, '/proj');
  assert.equal(path, '/proj/src/app.js');

  const path2 = a.extractPath({ command: "cd lib && cat <<EOF > util.js\nfoo\nEOF" }, '/proj');
  assert.equal(path2, '/proj/lib/util.js');
});

test('Bash adapter: cd sub && cat file resolves relative to session cwd, not process.cwd()', () => {
  const a = matchAdapter('Bash');
  const resolved = a.extractPath({ command: 'cd src && cat a.js' }, '/proj');
  assert.equal(resolved, '/proj/src/a.js'); // NOT <process.cwd()>/src/a.js
});

// --- BRebuild tests ---

test('BRebuild: fullSet then B() = dead + Σ path tokens', () => {
  const b = new BRebuild();
  b.setDead(1000);
  b.apply({ type: 'fullSet', lines: [[1, 10], [2, 20]], overhead: 40 }, '/a.js', 1);
  assert.equal(b.pathTotal('/a.js'), 10 + 20 + 40);
  assert.equal(b.B(), 1000 + 70);
});

test('BRebuild: lineUpdate overwrites observed lines (overlap = overwrite)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 10], [2, 20]], overhead: 40 }, '/a.js', 1);
  b.apply({ type: 'lineUpdate', lines: [[2, 5]], overhead: 40 }, '/a.js', 2);
  assert.equal(b.pathTotal('/a.js'), 10 + 5 + 40); // line 2 overwritten 20→5
});

test('BRebuild: fullSet resets editDelta to 0 and re-sets overhead', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40 }, '/a.js', 1);
  b.apply({ type: 'editDelta', value: 500 }, '/a.js', 2);
  assert.equal(b.pathTotal('/a.js'), 100 + 40 + 500);
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40 }, '/a.js', 3); // re-Read corrects
  assert.equal(b.pathTotal('/a.js'), 100 + 40);
});

test('BRebuild: pathTotal clamps to 0 (repeated deletes cannot drive B negative)', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 100]], overhead: 40 }, '/a.js', 1);
  b.apply({ type: 'editDelta', value: -100000 }, '/a.js', 2);
  assert.equal(b.pathTotal('/a.js'), 0);
  assert.equal(b.B(), 0); // dead=0 default
});

test('BRebuild: grepMultiFile updates multiple paths; overhead distributed (not per-file)', () => {
  const b = new BRebuild();
  b.apply({ type: 'grepMultiFile', files: { '/a.js': [[1, 10]], '/b.js': [[2, 20]] }, overhead: 40 }, null, 1);
  // overhead=40 distributed across 2 files → 20 each (prevents B inflation on broad greps)
  assert.equal(b.pathTotal('/a.js'), 10 + 20);
  assert.equal(b.pathTotal('/b.js'), 20 + 20);
  assert.equal(b.B(), 10 + 20 + 20 + 20); // total overhead contribution = 40, not 80
});

test('BRebuild: clear() empties paths, snapshot() excludes zero paths and carries lastActiveTurn', () => {
  const b = new BRebuild();
  b.apply({ type: 'fullSet', lines: [[1, 10]], overhead: 40 }, '/a.js', 7);
  const snap = b.snapshot();
  assert.equal(snap[0].path, '/a.js');
  assert.equal(snap[0].lastActiveTurn, 7);
  b.clear();
  assert.equal(b.snapshot().length, 0);
});

// --- applyResidual / emaStep / gEffective tests ---

test('applyResidual: positive residual passes through, overshoot 0', () => {
  assert.deepEqual(applyResidual(1000, 300), { residual: 700, overshoot: 0 });
});

test('applyResidual: ΔResidual<0 clamps to 0 and accumulates overshoot', () => {
  assert.deepEqual(applyResidual(200, 500), { residual: 0, overshoot: 300 });
});

test('emaStep: converges toward residual with heavy smoothing', () => {
  let g = 100;
  for (let i = 0; i < 500; i++) g = emaStep(g, 1000, 0.03);
  assert.ok(Math.abs(g - 1000) < 1, `expected ≈1000, got ${g}`);
});

test('gEffective: floors at G_FLOOR', () => {
  assert.equal(gEffective(10), 100);
  assert.equal(gEffective(5000), 5000);
});
