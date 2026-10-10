import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ignore/index.js
var require_ignore = __commonJS({
  "node_modules/ignore/index.js"(exports, module2) {
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    var UNDEFINED = void 0;
    var EMPTY = "";
    var SPACE = " ";
    var ESCAPE = "\\";
    var REGEX_TEST_BLANK_LINE = /^\s+$/;
    var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    var REGEX_SPLITALL_CRLF = /\r?\n/g;
    var REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
    var REGEX_TEST_TRAILING_SLASH = /\/$/;
    var SLASH = "/";
    var TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = /* @__PURE__ */ Symbol.for("node-ignore");
    }
    var KEY_IGNORE = TMP_KEY_IGNORE;
    var define = (object, key, value) => {
      Object.defineProperty(object, key, { value });
      return value;
    };
    var REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
    var RETURN_FALSE = () => false;
    var sanitizeRange = (range) => range.replace(
      REGEX_REGEXP_RANGE,
      (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
    );
    var negateRange = (range) => range.startsWith("!") || range.startsWith("\\^") ? `^${range.slice(range[0] === "!" ? 1 : 2)}` : range;
    var cleanRangeBackSlash = (slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    };
    var REPLACERS = [
      [
        // Remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\?\s+)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // Replace (\ ) with ' '
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?)\s/g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^"
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/"
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*(?:\\\*\\\*\\\/)+/,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        /^(?=[^^])/,
        function startingReplacer() {
          return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
        }
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        }
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE
      ],
      [
        // > The range notation, e.g. [a-zA-Z],
        // > can be used to match one of the characters in a range.
        // `\` is escaped by step 3
        /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
        (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${negateRange(sanitizeRange(range))}${endEscape}]` : "[]" : "[]"
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        /(?:[^*])$/,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
      ]
    ];
    var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
    var MODE_IGNORE = "regex";
    var MODE_CHECK_IGNORE = "checkRegex";
    var UNDERSCORE = "_";
    var TRAILING_WILD_CARD_REPLACERS = {
      [MODE_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      },
      [MODE_CHECK_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      }
    };
    var makeRegexPrefix = (pattern) => REPLACERS.reduce(
      (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)),
      pattern
    );
    var isString = (subject) => typeof subject === "string";
    var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
    var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);
    var IgnoreRule = class {
      constructor(pattern, mark, body2, ignoreCase, negative, prefix) {
        this.pattern = pattern;
        this.mark = mark;
        this.negative = negative;
        define(this, "body", body2);
        define(this, "ignoreCase", ignoreCase);
        define(this, "regexPrefix", prefix);
      }
      get regex() {
        const key = UNDERSCORE + MODE_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_IGNORE, key);
      }
      get checkRegex() {
        const key = UNDERSCORE + MODE_CHECK_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_CHECK_IGNORE, key);
      }
      _make(mode, key) {
        const str = this.regexPrefix.replace(
          REGEX_REPLACE_TRAILING_WILDCARD,
          // It does not need to bind pattern
          TRAILING_WILD_CARD_REPLACERS[mode]
        );
        const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
        return define(this, key, regex);
      }
    };
    var createRule = ({
      pattern,
      mark
    }, ignoreCase) => {
      let negative = false;
      let body2 = pattern;
      if (body2.indexOf("!") === 0) {
        negative = true;
        body2 = body2.substr(1);
      }
      body2 = body2.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regexPrefix = makeRegexPrefix(body2);
      return new IgnoreRule(
        pattern,
        mark,
        body2,
        ignoreCase,
        negative,
        regexPrefix
      );
    };
    var RuleManager = class {
      constructor(ignoreCase) {
        this._ignoreCase = ignoreCase;
        this._rules = [];
      }
      _add(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules._rules);
          this._added = true;
          return;
        }
        if (isString(pattern)) {
          pattern = {
            pattern
          };
        }
        if (checkPattern(pattern.pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._add, this);
        return this._added;
      }
      // Test one single path without recursively checking parent directories
      //
      // - checkUnignored `boolean` whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`
      // @returns {TestResult} true if a file is ignored
      test(path3, checkUnignored, mode) {
        let ignored = false;
        let unignored = false;
        let matchedRule;
        this._rules.forEach((rule) => {
          const { negative } = rule;
          if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
            return;
          }
          const matched = rule[mode].test(path3);
          if (!matched) {
            return;
          }
          ignored = !negative;
          unignored = negative;
          matchedRule = negative ? UNDEFINED : rule;
        });
        const ret = {
          ignored,
          unignored
        };
        if (matchedRule) {
          ret.rule = matchedRule;
        }
        return ret;
      }
    };
    var throwError = (message, Ctor) => {
      throw new Ctor(message);
    };
    var checkPath = (path3, originalPath, doThrow) => {
      if (!isString(path3)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path3) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path3)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    };
    var isNotRelative = (path3) => REGEX_TEST_INVALID_PATH.test(path3);
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    var Ignore = class {
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = new RuleManager(ignoreCase);
        this._strictPathCheck = !allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      add(pattern) {
        if (this._rules.add(pattern)) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored, slices) {
        const path3 = originalPath && checkPath.convert(originalPath);
        checkPath(
          path3,
          originalPath,
          this._strictPathCheck ? throwError : RETURN_FALSE
        );
        return this._t(path3, cache, checkUnignored, slices);
      }
      checkIgnore(path3) {
        if (!REGEX_TEST_TRAILING_SLASH.test(path3)) {
          return this.test(path3);
        }
        const slices = path3.split(SLASH).filter(Boolean);
        slices.pop();
        if (slices.length) {
          const parent = this._t(
            slices.join(SLASH) + SLASH,
            this._testCache,
            true,
            slices
          );
          if (parent.ignored) {
            return parent;
          }
        }
        return this._rules.test(path3, false, MODE_CHECK_IGNORE);
      }
      _t(path3, cache, checkUnignored, slices) {
        if (path3 in cache) {
          return cache[path3];
        }
        if (!slices) {
          slices = path3.split(SLASH).filter(Boolean);
        }
        slices.pop();
        if (!slices.length) {
          return cache[path3] = this._rules.test(path3, checkUnignored, MODE_IGNORE);
        }
        const parent = this._t(
          slices.join(SLASH) + SLASH,
          cache,
          checkUnignored,
          slices
        );
        return cache[path3] = parent.ignored ? parent : this._rules.test(path3, checkUnignored, MODE_IGNORE);
      }
      ignores(path3) {
        return this._test(path3, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path3) => !this.ignores(path3);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path3) {
        return this._test(path3, this._testCache, true);
      }
    };
    var factory = (options) => new Ignore(options);
    var isPathValid = (path3) => checkPath(path3 && checkPath.convert(path3), path3, RETURN_FALSE);
    var setupWindows = () => {
      const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
      checkPath.convert = makePosix;
      const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path3) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path3) || isNotRelative(path3);
    };
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && process.platform === "win32"
    ) {
      setupWindows();
    }
    module2.exports = factory;
    factory.default = factory;
    module2.exports.isPathValid = isPathValid;
    define(module2.exports, /* @__PURE__ */ Symbol.for("setupWindows"), setupWindows);
  }
});

// dsh/src/index.js
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";

// lib/store.js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

// lib/constants.js
var RECENT_STOP_EVENTS_LIMIT = 32;
var RECENT_PROCESSED_HOOK_IDS_LIMIT = 128;
var DEFAULT_CACHE_TTL = "5m";
var LONG_CACHE_TTL = "1h";
var C_RATIO_TABLE = [
  // A keyed row prices its longer lifetime's cache write above its DEFAULT_CACHE_TTL one — equal entries do
  // not express invariance, a scalar row does, and a provider whose price does not move with the lifetime
  // takes one.
  // The quotient divides out the base input price, so one row covers every model a provider bills at the same
  // cache-write and cache-read multipliers, however far apart their absolute prices are; a model earns a row of
  // its own only where one of those multipliers differs. The lookup takes the first match, so such a row
  // precedes the broader one whose pattern also matches its ids.
  { match: /fable.?5.?1/i, ratio: { [DEFAULT_CACHE_TTL]: 50, [LONG_CACHE_TTL]: 80 } },
  { match: /(opus|sonnet).?5.?5/i, ratio: { [DEFAULT_CACHE_TTL]: 25, [LONG_CACHE_TTL]: 40 } },
  { match: /claude|opus|sonnet|haiku|fable/i, ratio: { [DEFAULT_CACHE_TTL]: 12.5, [LONG_CACHE_TTL]: 20 } },
  { match: /deepseek.*pro/i, ratio: 30 },
  { match: /deepseek/i, ratio: 50 }
];
var DEFAULT_C_RATIO = 10;
var MODEL_PRICING_PRESETS = [
  {
    id: "opus-4.8",
    label: "Claude Opus 4.8",
    readPrice: 0.5,
    writePrice: 6.25
  },
  { id: "sonnet-5", label: "Claude Sonnet 5", readPrice: 0.2, writePrice: 2.5 },
  {
    id: "sonnet-4.6",
    label: "Claude Sonnet 4.6",
    readPrice: 0.3,
    writePrice: 3.75
  },
  {
    id: "haiku-4.5",
    label: "Claude Haiku 4.5",
    readPrice: 0.1,
    writePrice: 1.25
  },
  { id: "fable-5", label: "Claude Fable 5", readPrice: 1, writePrice: 12.5 },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek v4 Flash",
    readPrice: 0.02,
    writePrice: 1
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek v4 Pro",
    readPrice: 0.025,
    writePrice: 3
  }
];
var CONTEXT_WINDOW_TABLE = [
  { match: /test-short-window/i, window: 2e5 },
  // test-only vehicle for cap-binding tests
  { match: /1m|-1m|opus-4-8/i, window: 1e6 },
  { match: /claude|opus|sonnet|haiku/i, window: 1e6 },
  { match: /deepseek/i, window: 1e6 }
];
var DEFAULT_CONTEXT_WINDOW = 1e6;
var RESERVED_OUTPUT = 32e3;
var CTX_SAFETY_MARGIN = 8e3;
var COALESCED_PERSIST_MS = 2e3;
var CTP_TABLE = [
  { match: /claude/i, ascii: 2.45, cjk: 0.59 },
  // Anthropic tokenizer (n=5881)
  { match: /deepseek/i, ascii: 3.24, cjk: 0.94 }
  // DeepSeek tokenizer (n=5265)
];
var DEFAULT_CTP = { ascii: 3, cjk: 1 };
var TOOL_OVERHEAD = { Read: 40, Write: 90, Edit: 85, Bash: 10, Grep: 40, Serena: 50 };
var DEPTH_HOT_LAP_COUNT = 3;
var ALPHA_EMA = 0.06;
var G_DELTA_CAP = 250;
var G_FLOOR = 100;
var MISS_CR_DROP = 0.95;
var GC_BATCH_LIMIT = 3;
var GC_REPLAY_MAX_FILE_BYTES = 5e7;
var GC_HANDOFF_MAX_AGE_DAYS = 90;
var HANDOFF_MAX_PATHS = 50;
var HANDOFF_MAX_SUMMARY_CHARS = 1e4;
var HANDOFF_MAX_NEXT_TASK_CHARS = 2e3;
var HANDOFF_HOOK_TTL_DAYS = 7;
var HANDOFF_HOOK_MAX_DISPLAY = 3;
var HANDOFF_HOOK_QUERY_LIMIT = HANDOFF_HOOK_MAX_DISPLAY + 1;
var HANDOFF_HOOK_TASK_PREVIEW_CHARS = 200;
var NOTE_TOKEN_LIMIT = 800;
var NOTE_PREVIEW_TOKENS = 100;
var HANDOFF_TOKEN_MAX_RETRIES = 5;

// lib/store.js
var yieldTick = () => new Promise((r) => setImmediate(r));
var ARCHIVE_PRIORITY = { snapshot: 1, replay: 2, live: 3 };
var SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  model       TEXT,
  project_id  TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS state (
  session_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lines (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  line_num   INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  PRIMARY KEY (session_id, path, line_num)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS paths (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  edit_delta  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS profile (
  session_id   TEXT PRIMARY KEY,
  archived_at  INTEGER NOT NULL,
  model        TEXT,
  project_id   TEXT,
  l_floor      REAL,
  b_total      REAL,
  l_peak       REAL,
  g_final      REAL,
  o_avg        REAL,
  c_ratio      REAL,
  turns        INTEGER,
  duration_ms  INTEGER,
  total_tokens_read REAL,
  mf           REAL,
  pp_exit      REAL,
  br_exit      REAL,
  br_peak      REAL,
  pp_peak      REAL,
  p0           REAL,
  b_axis       REAL,
  x_axis       REAL,
  g_min        REAL,
  turn_at_br_amber INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS profile_paths (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  tokens     REAL NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_project_id ON profile(project_id);
`;
function migrateProfileToSegment(db) {
  db.exec("ALTER TABLE profile RENAME TO profile_v1");
  db.exec(`CREATE TABLE profile (
    session_id TEXT NOT NULL, segment INTEGER NOT NULL, archived_at INTEGER NOT NULL,
    model TEXT, project_id TEXT, l_floor REAL, b_total REAL, l_peak REAL, g_final REAL,
    o_avg REAL, c_ratio REAL, turns INTEGER, duration_ms INTEGER, total_tokens_read REAL,
    mf REAL, pp_exit REAL, br_exit REAL, br_peak REAL, pp_peak REAL, p0 REAL, b_axis REAL,
    x_axis REAL, g_min REAL, turn_at_br_amber INTEGER, archive_source TEXT,
    archive_priority INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_id, segment)) WITHOUT ROWID`);
  db.exec(`INSERT INTO profile (
    session_id, segment, archived_at, model, project_id, l_floor, b_total, l_peak, g_final,
    o_avg, c_ratio, turns, duration_ms, total_tokens_read, mf, pp_exit, br_exit, br_peak,
    pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber, archive_source, archive_priority)
    SELECT session_id, 0, archived_at, model, project_id, l_floor, b_total, l_peak, g_final,
    o_avg, c_ratio, turns, duration_ms, total_tokens_read, mf, pp_exit, br_exit, br_peak,
    pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber, 'snapshot', 1 FROM profile_v1`);
  db.exec("DROP TABLE profile_v1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_profile_project_archived ON profile(project_id, archived_at DESC)");
}
function migrateProfilePaths(db) {
  db.exec("ALTER TABLE profile_paths RENAME TO profile_paths_v1");
  db.exec(`CREATE TABLE profile_paths (
    session_id TEXT NOT NULL, segment INTEGER NOT NULL, path TEXT NOT NULL, tokens REAL NOT NULL,
    PRIMARY KEY (session_id, segment, path)) WITHOUT ROWID`);
  db.exec("INSERT INTO profile_paths (session_id, segment, path, tokens) SELECT session_id, 0, path, tokens FROM profile_paths_v1");
  db.exec("DROP TABLE profile_paths_v1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_profile_paths_path ON profile_paths(path, session_id, segment)");
}
function createHandoffTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS handoff (
    handoff_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, segment INTEGER NOT NULL,
    load_token TEXT NOT NULL, created_at INTEGER NOT NULL, paths_to_keep TEXT NOT NULL,
    summary TEXT NOT NULL, next_task TEXT, summary_tokens INTEGER NOT NULL,
    kept_tokens REAL, discarded_tokens REAL, prepared_at_turn INTEGER,
    previous_stats TEXT, prepared_stats TEXT, search_terms TEXT, project_id TEXT,
    delivered_at INTEGER, delivered_segment INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_session ON handoff(session_id, created_at DESC)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_token ON handoff(load_token)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_created_at ON handoff(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff(project_id, created_at DESC)");
}
function createHandoffLoadTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS handoff_load (
    handoff_id         INTEGER NOT NULL,
    session_id         TEXT NOT NULL,
    loaded_at          INTEGER NOT NULL,
    loader_version     TEXT,
    claim_result       TEXT NOT NULL CHECK (claim_result IN ('primary','duplicate','legacy_unattributed')),
    primary_session_id TEXT,
    consumer_segment   INTEGER,
    PRIMARY KEY (handoff_id, session_id, loaded_at)
  ) WITHOUT ROWID`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_load_session ON handoff_load(session_id)");
}
function createTelemetryTables(db) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const wasMissing = [];
  if (!has("profile_path_event")) wasMissing.push("profile_path_event");
  if (!has("profile_step_usage")) wasMissing.push("profile_step_usage");
  db.exec(`CREATE TABLE IF NOT EXISTS profile_path_event (
    session_id    TEXT NOT NULL,
    segment       INTEGER NOT NULL,
    folded_seq    INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    path          TEXT NOT NULL,
    raw_path      TEXT,
    tool_type     TEXT NOT NULL,
    is_full_read  INTEGER CHECK (is_full_read IN (0,1) OR is_full_read IS NULL),
    PRIMARY KEY (session_id, segment, folded_seq, event_ordinal)
  ) WITHOUT ROWID`);
  db.exec(`CREATE TABLE IF NOT EXISTS profile_step_usage (
    session_id     TEXT NOT NULL,
    segment        INTEGER NOT NULL,
    folded_seq     INTEGER NOT NULL,
    ts             INTEGER,
    cache_read     REAL,
    cache_creation REAL,
    input          REAL,
    output         REAL,
    tool_calls     INTEGER,
    load_token     TEXT,
    PRIMARY KEY (session_id, segment, folded_seq)
  ) WITHOUT ROWID`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_step_usage_load_token ON profile_step_usage(load_token)");
  return wasMissing;
}
function ensureV5Shape(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_note (
    turn_note_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    source_session_id TEXT    NOT NULL,
    anchor_uuid       TEXT    NOT NULL,
    u_text            TEXT    NOT NULL,
    u_original_chars  INTEGER NOT NULL,
    note              TEXT,
    search_terms      TEXT    NOT NULL DEFAULT '',
    source_timestamp  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (source_session_id, anchor_uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_note_session
    ON turn_note(source_session_id, source_timestamp)`);
}
var V3_HANDOFF_COLUMNS = [
  ["delivered_session_id", "TEXT"],
  ["loader_version", "TEXT"],
  ["bucket_snapshot", "TEXT"],
  ["transcript_path", "TEXT"]
];
function addColumnIfMissing(db, table, name3, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name3)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name3} ${type}`);
}
function ensureV3Shape(db) {
  for (const [name3, type] of V3_HANDOFF_COLUMNS) addColumnIfMissing(db, "handoff", name3, type);
  addColumnIfMissing(db, "profile", "telemetry_status", "TEXT");
  addColumnIfMissing(db, "profile", "capture_source", "TEXT");
  createHandoffLoadTable(db);
  const recreated = createTelemetryTables(db);
  if (recreated.length) {
    db.prepare("UPDATE profile SET telemetry_status='pending' WHERE telemetry_status IN ('complete','complete_empty')").run();
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_delivered_session ON handoff(delivered_session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_profile_telemetry ON profile(telemetry_status, archived_at)");
}
var HANDOFF_FTS_OBJECTS = [
  "handoff_fts",
  "handoff_fts_insert",
  "handoff_fts_delete",
  "handoff_fts_update"
];
var TURN_NOTE_FTS_OBJECTS = [
  "turn_note_fts",
  "turn_note_fts_insert",
  "turn_note_fts_delete",
  "turn_note_fts_update"
];
function ftsObjectsPresent(db, names) {
  const holes = names.map(() => "?").join(",");
  const row = db.prepare(`SELECT COUNT(*) AS present FROM sqlite_master WHERE name IN (${holes})`).get(...names);
  return row.present === names.length;
}
function createHandoffFts(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS handoff_fts USING fts5(
    summary, next_task, load_token, search_terms,
    content='handoff', content_rowid='handoff_id')`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_insert AFTER INSERT ON handoff BEGIN
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_delete AFTER DELETE ON handoff BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_update AFTER UPDATE ON handoff
    WHEN old.summary IS NOT new.summary OR old.next_task IS NOT new.next_task
      OR old.load_token IS NOT new.load_token OR old.search_terms IS NOT new.search_terms
    BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
}
function createTurnNoteFts(db) {
  const wasIncomplete = !ftsObjectsPresent(db, TURN_NOTE_FTS_OBJECTS);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turn_note_fts USING fts5(
    u_text, note, search_terms, content='turn_note', content_rowid='turn_note_id')`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_insert AFTER INSERT ON turn_note BEGIN
    INSERT INTO turn_note_fts(rowid, u_text, note, search_terms)
    VALUES (new.turn_note_id, new.u_text, new.note, new.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_delete AFTER DELETE ON turn_note BEGIN
    INSERT INTO turn_note_fts(turn_note_fts, rowid, u_text, note, search_terms)
    VALUES ('delete', old.turn_note_id, old.u_text, old.note, old.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_update AFTER UPDATE ON turn_note BEGIN
    INSERT INTO turn_note_fts(turn_note_fts, rowid, u_text, note, search_terms)
    VALUES ('delete', old.turn_note_id, old.u_text, old.note, old.search_terms);
    INSERT INTO turn_note_fts(rowid, u_text, note, search_terms)
    VALUES (new.turn_note_id, new.u_text, new.note, new.search_terms);
  END`);
  if (wasIncomplete) db.exec(`INSERT INTO turn_note_fts(turn_note_fts) VALUES('rebuild')`);
}
function ensureV2Shape(db) {
  const hasHandoff = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff'").get();
  const profileCols = db.prepare("PRAGMA table_info(profile)").all().map((c) => c.name);
  const profileOk = profileCols.includes("segment") && profileCols.includes("archive_priority");
  if (!hasHandoff || !profileOk) {
    if (!profileOk && profileCols.includes("session_id") && !profileCols.includes("segment")) {
      migrateProfileToSegment(db);
      migrateProfilePaths(db);
    }
    if (!hasHandoff) createHandoffTable(db);
  }
}
function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? parseInt(row.value) : 0;
    if (version < 1) {
      db.exec(SCHEMA_V1_SQL);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    if (version < 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS profile_paths (
        session_id TEXT NOT NULL,
        path       TEXT NOT NULL,
        tokens     REAL NOT NULL,
        PRIMARY KEY (session_id, path)
      ) WITHOUT ROWID`);
      migrateProfileToSegment(db);
      migrateProfilePaths(db);
      createHandoffTable(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    if (version < 3) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    if (version < 4) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    ensureV2Shape(db);
    ensureV3Shape(db);
    ensureV5Shape(db);
    if (version < 5) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    db.exec("COMMIT");
  } catch (err2) {
    db.exec("ROLLBACK");
    throw err2;
  }
  let handoffFtsAvailable = false;
  let turnFtsAvailable = false;
  try {
    const wasIncomplete = !ftsObjectsPresent(db, HANDOFF_FTS_OBJECTS);
    createHandoffFts(db);
    if (wasIncomplete) db.exec("INSERT INTO handoff_fts(handoff_fts) VALUES('rebuild')");
    handoffFtsAvailable = true;
  } catch (ftsErr) {
    console.warn("[store] FTS5 unavailable, handoff search disabled:", ftsErr.message);
  }
  try {
    createTurnNoteFts(db);
    turnFtsAvailable = true;
  } catch (ftsErr) {
    console.warn("[store] FTS5 unavailable, turn-note locate disabled:", ftsErr.message);
  }
  return { handoffFtsAvailable, turnFtsAvailable };
}
var Store = class _Store {
  constructor(db) {
    this._db = db;
    this._closed = false;
    this._stmts = {
      touchSession: db.prepare(`INSERT INTO sessions (session_id, created_at, updated_at, model, project_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, model = COALESCE(excluded.model, sessions.model), project_id = COALESCE(excluded.project_id, sessions.project_id)`),
      load: db.prepare("SELECT value FROM state WHERE session_id = ? AND key = ?"),
      save: db.prepare(`INSERT INTO state (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
      delete: db.prepare("DELETE FROM state WHERE session_id = ? AND key = ?"),
      loadAll: db.prepare("SELECT key, value FROM state WHERE session_id = ?"),
      deleteSessionState: db.prepare("DELETE FROM state WHERE session_id = ?"),
      deleteSessionPaths: db.prepare("DELETE FROM paths WHERE session_id = ?"),
      deleteSessionLines: db.prepare("DELETE FROM lines WHERE session_id = ?"),
      deleteSessionRecord: db.prepare("DELETE FROM sessions WHERE session_id = ?"),
      // Config CRUD
      loadConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
      saveConfig: db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      deleteConfig: db.prepare("DELETE FROM config WHERE key = ?"),
      // Profile archival — v2 composite PK (session_id, segment)
      loadProfile: db.prepare("SELECT * FROM profile WHERE session_id = ? AND segment = 0"),
      loadAllProfiles: db.prepare("SELECT * FROM profile WHERE segment = 0 ORDER BY archived_at DESC"),
      archiveSegment: db.prepare(`INSERT INTO profile (session_id, segment, archived_at, model, project_id,
        l_floor, b_total, l_peak, g_final, o_avg, c_ratio, turns, duration_ms, total_tokens_read,
        mf, pp_exit, br_exit, br_peak, pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber,
        archive_source, archive_priority)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id, segment) DO UPDATE SET
          archived_at=excluded.archived_at, model=excluded.model, project_id=excluded.project_id,
          l_floor=excluded.l_floor, b_total=excluded.b_total, l_peak=excluded.l_peak,
          g_final=excluded.g_final, o_avg=excluded.o_avg, c_ratio=excluded.c_ratio,
          turns=excluded.turns, duration_ms=excluded.duration_ms, total_tokens_read=excluded.total_tokens_read,
          mf=excluded.mf, pp_exit=excluded.pp_exit, br_exit=excluded.br_exit, br_peak=excluded.br_peak,
          pp_peak=excluded.pp_peak, p0=excluded.p0, b_axis=excluded.b_axis, x_axis=excluded.x_axis,
          g_min=excluded.g_min, turn_at_br_amber=excluded.turn_at_br_amber,
          archive_source=excluded.archive_source, archive_priority=excluded.archive_priority
        WHERE excluded.archive_priority >= profile.archive_priority`),
      deleteSegmentPaths: db.prepare("DELETE FROM profile_paths WHERE session_id = ? AND segment = ?"),
      insertSegmentPath: db.prepare("INSERT OR REPLACE INTO profile_paths (session_id, segment, path, tokens) VALUES (?,?,?,?)"),
      loadProfileSegments: db.prepare("SELECT * FROM profile WHERE session_id = ? ORDER BY segment ASC"),
      // --- Segment telemetry (TXN2): profile_step_usage / profile_path_event + telemetry_status ---
      deleteSegmentStepUsage: db.prepare("DELETE FROM profile_step_usage WHERE session_id = ? AND segment = ?"),
      deleteSegmentPathEvents: db.prepare("DELETE FROM profile_path_event WHERE session_id = ? AND segment = ?"),
      // plain INSERT (not INSERT OR REPLACE) — after the per-segment DELETE the table is clear for
      //   this segment, so a duplicate (session,segment,folded_seq) can ONLY come from a real fold/replay
      //   bug; let it THROW → the txn rolls back → failed_retryable (observable), not silent overwrite.
      insertStepUsage: db.prepare(`INSERT INTO profile_step_usage
        (session_id, segment, folded_seq, ts, cache_read, cache_creation, input, output, tool_calls, load_token)
        VALUES (?,?,?,?,?,?,?,?,?,?)`),
      insertPathEvent: db.prepare(`INSERT INTO profile_path_event
        (session_id, segment, folded_seq, event_ordinal, path, raw_path, tool_type, is_full_read)
        VALUES (?,?,?,?,?,?,?,?)`),
      // capture_source stamped WITH the status so provenance and status move together.
      setTelemetryStatus: db.prepare("UPDATE profile SET telemetry_status = ?, capture_source = ? WHERE session_id = ? AND segment = ?"),
      // Task 8 TXN1 handshake: a just-(re)written profile is needs-telemetry until TXN2 flips it. Clear
      // capture_source too so a re-written pending row never shows the PRIOR capture's provenance
      // (a crash between TXN1 and TXN2 would otherwise leave pending + a stale cc-live/cc-replay source).
      markTelemetryPending: db.prepare("UPDATE profile SET telemetry_status = 'pending', capture_source = NULL WHERE session_id = ? AND segment = ?"),
      setTelemetryStatusOnly: db.prepare("UPDATE profile SET telemetry_status = ? WHERE session_id = ? AND segment = ?"),
      getTelemetryStatusRow: db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=?"),
      // Task 10 startup sweep: DISTINCT sessions with ANY pending/failed_retryable/NULL segment,
      // newest-first, capped by a SQL LIMIT. The (? IS NULL OR session_id <> ?) clause pushes the common
      // single-live-id exclusion into SQL so the excluded session's rows do NOT consume the LIMIT (a
      // multi-id Set is JS-filtered after). Session granularity — the production replay archives every
      // occurred segment of a session in one pass, so the sweep issues ONE replay per DISTINCT session.
      pendingTelemetrySessions: db.prepare(`SELECT DISTINCT session_id FROM profile
        WHERE (telemetry_status IS NULL OR telemetry_status IN ('pending','failed_retryable'))
          AND (? IS NULL OR session_id <> ?)
        ORDER BY MAX(archived_at) OVER (PARTITION BY session_id) DESC
        LIMIT ?`),
      // Handoff CRUD
      insertHandoff: db.prepare(`INSERT INTO handoff
        (session_id, segment, load_token, created_at, paths_to_keep, summary, next_task,
         summary_tokens, kept_tokens, discarded_tokens, prepared_at_turn, previous_stats, prepared_stats, search_terms, project_id, bucket_snapshot, transcript_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      // `AND delivered_at IS NULL` makes a DELIVERED handoff's telemetry immutable. `SessionWatcher.prepareHandoff` sends a
      // token it reads as delivered to the insert path without calling this, so changes===0 means the delivery landed
      // between that read and this write, and the call becomes a new handoff (never rewrites bucket_snapshot/hp at a
      // different instant than delivery).
      updateHandoff: db.prepare(`UPDATE handoff SET paths_to_keep = ?, summary = ?, next_task = ?,
         summary_tokens = ?, kept_tokens = ?, discarded_tokens = ?, prepared_at_turn = ?,
         previous_stats = ?, prepared_stats = ?, search_terms = ?, bucket_snapshot = ?, transcript_path = ?
         WHERE load_token = ? AND delivered_at IS NULL`),
      // Stamp ONLY paths_to_keep (per-entry telemetry back-fill: hp at prepare / hl at load). Keyed by
      // handoff_id so a load-side stamp does not need the token in scope.
      stampPathsToKeep: db.prepare("UPDATE handoff SET paths_to_keep = ? WHERE handoff_id = ?"),
      loadHandoffToken: db.prepare("SELECT * FROM handoff WHERE load_token = ?"),
      loadHandoffSession: db.prepare("SELECT * FROM handoff WHERE session_id = ? AND (project_id = ? OR ? IS NULL) ORDER BY created_at DESC LIMIT 1"),
      loadHandoffByProject: db.prepare(`SELECT * FROM handoff
        WHERE project_id = ? AND delivered_at IS NULL AND session_id <> ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 5`),
      // Two stamps. markDelivered is the CAS for a never-delivered row. markDeliveredLegacy binds the
      //   consumer of a v2 row that already has delivered_at but NULL consumer, WITHOUT touching the
      //   historical delivered_at (guarded on delivered_session_id IS NULL so it fires at most once).
      markDelivered: db.prepare("UPDATE handoff SET delivered_at = ?, delivered_session_id = ?, delivered_segment = ?, loader_version = ? WHERE handoff_id = ? AND delivered_at IS NULL"),
      markDeliveredLegacy: db.prepare("UPDATE handoff SET delivered_session_id = ?, delivered_segment = ?, loader_version = ? WHERE handoff_id = ? AND delivered_at IS NOT NULL AND delivered_session_id IS NULL"),
      insertHandoffLoad: db.prepare(`INSERT OR IGNORE INTO handoff_load
        (handoff_id, session_id, loaded_at, loader_version, claim_result, primary_session_id, consumer_segment)
        VALUES (?,?,?,?,?,?,?)`),
      // Lineage: the parent edge is the delivery a session consumed before it prepared its own
      // handoff. LIMIT 1 is replacement semantics, not a query optimization — when one child
      // session loaded several handoffs, only the newest qualifying delivery is its parent, and
      // the earlier ones' ancestor chains are NOT merged in. Same millisecond breaks by handoff_id.
      findParentDelivery: db.prepare(`SELECT h.* FROM handoff_load AS hl
        JOIN handoff AS h ON h.handoff_id = hl.handoff_id
       WHERE hl.session_id = ? AND hl.loaded_at <= ? AND h.project_id = ?
       ORDER BY hl.loaded_at DESC, hl.handoff_id DESC LIMIT 1`),
      findLatestDeliveryHandoff: db.prepare(`SELECT h.* FROM handoff_load AS hl
        JOIN handoff AS h ON h.handoff_id = hl.handoff_id
       WHERE hl.session_id = ? AND h.project_id = ?
       ORDER BY hl.loaded_at DESC, hl.handoff_id DESC LIMIT 1`),
      // A read tool resolves the head it should read from the running session's delivery facts alone.
      // No project predicate: the handoff a session actually loaded is the one it may read, and parent
      // traversal below still scopes itself by that head row's own project. Filtering here by the
      // watcher's project would answer "nothing loaded" about a cross-project handoff just delivered.
      // Select the delivery fact before joining its target: if GC removed that newest handoff, return
      // no head rather than letting the inner join silently fall back to an older delivery contract.
      findLatestDeliveryInSession: db.prepare(`SELECT h.* FROM (
        SELECT handoff_id FROM handoff_load
         WHERE session_id = ?
         ORDER BY loaded_at DESC, handoff_id DESC LIMIT 1
      ) AS latest JOIN handoff AS h ON h.handoff_id = latest.handoff_id`),
      getHandoff: db.prepare("SELECT * FROM handoff WHERE handoff_id = ?"),
      // Turn note CRUD
      // created_at is written on insert only and deliberately absent from the SET list: the first
      // write's timestamp is the row's own age, while a later submission only revises its content.
      upsertTurnNote: db.prepare(`INSERT INTO turn_note
        (source_session_id, anchor_uuid, u_text, u_original_chars, note, search_terms, source_timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_session_id, anchor_uuid) DO UPDATE SET
          u_text = excluded.u_text, u_original_chars = excluded.u_original_chars,
          note = excluded.note, search_terms = excluded.search_terms,
          source_timestamp = excluded.source_timestamp`),
      // No ORDER BY: the page orders by the runtime T it resolves after active-path projection,
      // so a DB order here would only look authoritative.
      listTurnNotes: db.prepare("SELECT * FROM turn_note WHERE source_session_id = ?"),
      // Sweep (GC)
      expiredSessions: db.prepare("SELECT session_id FROM sessions WHERE updated_at < ? ORDER BY updated_at ASC"),
      deleteOldHandoffs: db.prepare("DELETE FROM handoff WHERE created_at < ?"),
      // The sessions the age delete is about to take handoffs from — read before it runs, because once
      // those rows are gone nothing tells a session that just lost its last handoff apart from one that
      // never had a handoff to lose.
      sessionsWithExpiringHandoffs: db.prepare("SELECT DISTINCT session_id FROM handoff WHERE created_at < ?"),
      // Retirement granularity is the SOURCE SESSION, not the handoff: a note outlives any single
      // handoff and dies only when its session has none left. source_timestamp never decides this.
      // The NOT EXISTS is the rule, not a precaution: session scanning ages on the sweep's own window
      // while handoff retention ages on GC_HANDOFF_MAX_AGE_DAYS, so an ungated cascade would take notes
      // a handoff still loads (`store.turn-note.test.js` — `仍有存活 handoff 引用该会话时保留 turn_note`).
      deleteTurnNotesIfNoHandoff: db.prepare(`DELETE FROM turn_note
        WHERE source_session_id = ?
          AND NOT EXISTS (SELECT 1 FROM handoff AS h WHERE h.session_id = turn_note.source_session_id)`),
      loadSessionMeta: db.prepare("SELECT model, project_id FROM sessions WHERE session_id = ?"),
      insertProfilePath: db.prepare("INSERT OR REPLACE INTO profile_paths (session_id, segment, path, tokens) VALUES (?, 0, ?, ?)"),
      loadState: db.prepare("SELECT value FROM state WHERE session_id = ? AND key = ?"),
      // Line-level operations (paths + lines tables)
      clearLines: db.prepare("DELETE FROM lines WHERE session_id = ? AND path = ?"),
      insertLine: db.prepare(`INSERT INTO lines (session_id, path, line_num, chars) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path, line_num) DO UPDATE SET chars = excluded.chars`),
      upsertPath: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, 0, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET updated_at = excluded.updated_at`),
      setDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = excluded.edit_delta, updated_at = excluded.updated_at`),
      addDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = edit_delta + excluded.edit_delta, updated_at = excluded.updated_at`),
      pathTotal: db.prepare(`SELECT COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? AND p.path = ?`),
      allTotals: db.prepare(`SELECT p.path, COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? GROUP BY p.path`),
      clearPathMeta: db.prepare("DELETE FROM paths WHERE session_id = ? AND path = ?"),
      clearAllLines: db.prepare("DELETE FROM lines WHERE session_id = ?"),
      clearAllPathsMeta: db.prepare("DELETE FROM paths WHERE session_id = ?")
    };
  }
  load(sessionId, key) {
    const row = this._stmts.load.get(sessionId, key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  save(sessionId, key, value, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  saveBatch(sessionId, entries, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) {
        this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      }
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  delete(sessionId, key) {
    this._stmts.delete.run(sessionId, key);
  }
  loadSession(sessionId) {
    const rows = this._stmts.loadAll.all(sessionId);
    const map = /* @__PURE__ */ new Map();
    for (const row of rows) {
      try {
        map.set(row.key, JSON.parse(row.value));
      } catch {
      }
    }
    return map;
  }
  deleteSession(sessionId) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.deleteSessionState.run(sessionId);
      this._stmts.deleteSessionPaths.run(sessionId);
      this._stmts.deleteSessionLines.run(sessionId);
      this._stmts.deleteTurnNotesIfNoHandoff.run(sessionId);
      this._stmts.deleteSessionRecord.run(sessionId);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  // --- Config CRUD ---
  loadConfig(key) {
    const row = this._stmts.loadConfig.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  saveConfig(key, value) {
    this._stmts.saveConfig.run(key, JSON.stringify(value));
  }
  deleteConfig(key) {
    this._stmts.deleteConfig.run(key);
  }
  // --- Profile archival ---
  archiveSession(sessionId, snapshot) {
    const snap = { ...snapshot, archivedAt: Date.now(), archiveSource: snapshot.archiveSource || "snapshot" };
    this._db.exec("SAVEPOINT archive_session");
    try {
      this._archiveSegmentProfileInner(sessionId, 0, snap, []);
      this._db.exec("RELEASE archive_session");
    } catch (e) {
      this._db.exec("ROLLBACK TO archive_session");
      throw e;
    }
  }
  _segmentArgs(sessionId, segment, s) {
    const priority = ARCHIVE_PRIORITY[s.archiveSource] ?? 1;
    return [
      sessionId,
      segment,
      s.archivedAt ?? Date.now(),
      s.model ?? null,
      s.projectId ?? null,
      s.lFloor ?? null,
      s.bTotal ?? null,
      s.lPeak ?? null,
      s.gFinal ?? null,
      s.oAvg ?? null,
      s.cRatio ?? null,
      s.turns ?? null,
      s.durationMs ?? null,
      s.totalTokensRead ?? null,
      s.mf ?? null,
      s.ppExit ?? null,
      s.brExit ?? null,
      s.brPeak ?? null,
      s.ppPeak ?? null,
      s.p0 ?? null,
      s.bAxis ?? null,
      s.xAxis ?? null,
      s.gMin ?? null,
      s.turnAtBrAmber ?? null,
      s.archiveSource ?? null,
      priority
    ];
  }
  // R1-B: Single priority-guarded upsert. No `replace` flag — priority enforces in SQL.
  // A lower-priority writer can NEVER clobber a higher one. Paths are rewritten (DELETE+INSERT)
  // iff res.changes > 0 (a fresh insert or a qualifying higher-priority update).
  // Returns { status: 'archived' | 'already_archived', source } per R1-D.
  _archiveSegmentProfileInner(sessionId, segment, snapshot, paths) {
    const args2 = this._segmentArgs(sessionId, segment, snapshot);
    const res = this._stmts.archiveSegment.run(...args2);
    if (res.changes > 0) {
      this._stmts.deleteSegmentPaths.run(sessionId, segment);
      for (const p of paths) this._stmts.insertSegmentPath.run(sessionId, segment, p.path, p.tokens);
      this._stmts.markTelemetryPending.run(sessionId, segment);
      return { status: "archived", source: snapshot.archiveSource };
    }
    return { status: "already_archived", source: snapshot.archiveSource };
  }
  archiveSegmentProfile(sessionId, segment, snapshot, paths = []) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      const result = this._archiveSegmentProfileInner(sessionId, segment, snapshot, paths);
      this._db.exec("COMMIT");
      return result;
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  // One telemetry artifact, exactly as its producer detached it: `{ captureSource, payload }`. The Adapter
  // decomposes it and owns the row mapping, so a producer never spells a column name. `captureSource` is the
  // Projection's own capture label, recorded WITH the terminal status so provenance and status stay
  // consistent.
  archiveSegmentTelemetry(sessionId, segment, artifact) {
    const captureSource = artifact?.captureSource ?? null;
    const steps = artifact?.payload?.steps || [];
    const events = artifact?.payload?.events || [];
    let txnOpen = false;
    try {
      this._db.exec("BEGIN IMMEDIATE");
      txnOpen = true;
      const cur = this._stmts.getTelemetryStatusRow.get(sessionId, segment);
      if (cur && (cur.telemetry_status === "complete" || cur.telemetry_status === "complete_empty")) {
        this._db.exec("ROLLBACK");
        txnOpen = false;
        return { status: "skipped_stale" };
      }
      this._stmts.deleteSegmentStepUsage.run(sessionId, segment);
      this._stmts.deleteSegmentPathEvents.run(sessionId, segment);
      for (const s of steps) {
        this._stmts.insertStepUsage.run(
          sessionId,
          segment,
          s.foldedSeq,
          s.ts ?? null,
          s.cacheRead ?? null,
          s.cacheCreation ?? null,
          s.input ?? null,
          s.output ?? null,
          s.toolCalls ?? null,
          s.loadToken ?? null
        );
      }
      for (const e of events) {
        this._stmts.insertPathEvent.run(
          sessionId,
          segment,
          e.foldedSeq,
          e.eventOrdinal,
          e.path,
          e.rawPath ?? e.path ?? null,
          e.toolType,
          e.isFullRead ?? null
        );
      }
      const status = events.length === 0 ? "complete_empty" : "complete";
      this._stmts.setTelemetryStatus.run(status, captureSource, sessionId, segment);
      this._db.exec("COMMIT");
      txnOpen = false;
      return { status };
    } catch (e) {
      if (txnOpen) {
        try {
          this._db.exec("ROLLBACK");
        } catch {
        }
      }
      try {
        this._stmts.setTelemetryStatusOnly.run("failed_retryable", sessionId, segment);
      } catch (e2) {
        if (process.env.SW_DEBUG) console.error("[telemetry-status]", e2.message);
      }
      if (process.env.SW_DEBUG) console.error("[archiveSegmentTelemetry]", e.message);
      return { status: "failed_retryable" };
    }
  }
  // Startup compensating sweep (spec §Startup compensating sweep). Runs AFTER open; MUST NOT be called
  // inside the migration transaction. Selects DISTINCT sessions with any pending/failed/NULL segment and
  // calls the injected replaySession ONCE per session — the PRODUCTION replay (carry-sweep) re-reads the
  // transcript and archives every occurred segment through the application's own boundary path and TXN2.
  // A never-occurred segment never boundaries → stays pending (no observed flag). The in-txn guard makes
  // re-archiving an already-complete segment a no-op. Budgets on REAL wall-clock (performance.now());
  // yields between sessions (setImmediate) so it is genuinely chunked. Injected replaySession keeps
  // store.js free of any measurement-runtime import. Returns a work summary. ASYNC.
  async backfillPendingTelemetry({
    resolveTranscript,
    replaySession,
    excludeSessionIds = null,
    limit = 200,
    budgetMs = 1500,
    yieldBetweenSessions = true
  } = {}) {
    const empty = { examined: 0, replayed: 0, missing: 0, aborted: false };
    if (typeof resolveTranscript !== "function" || typeof replaySession !== "function") return empty;
    const excluded = excludeSessionIds == null ? /* @__PURE__ */ new Set() : excludeSessionIds instanceof Set ? excludeSessionIds : /* @__PURE__ */ new Set([excludeSessionIds]);
    const sqlExclude = excluded.size === 1 ? [...excluded][0] : null;
    const sessions = this._stmts.pendingTelemetrySessions.all(sqlExclude, sqlExclude, limit).map((r) => r.session_id).filter((sid) => !excluded.has(sid));
    const summary = { examined: 0, replayed: 0, missing: 0, aborted: false };
    const deadline = performance.now() + budgetMs;
    for (const session_id of sessions) {
      if (performance.now() >= deadline) {
        summary.aborted = true;
        break;
      }
      summary.examined += 1;
      try {
        let txPath;
        try {
          txPath = resolveTranscript(session_id);
        } catch {
          txPath = null;
        }
        if (!txPath) {
          summary.missing += 1;
          continue;
        }
        const res = replaySession(session_id, txPath);
        if (res == null) {
          summary.missing += 1;
          continue;
        }
        summary.replayed += 1;
      } catch (e) {
        summary.missing += 1;
        if (process.env.SW_DEBUG) console.error("[telemetry-sweep session]", session_id, e.message);
      }
      if (yieldBetweenSessions) await yieldTick();
    }
    return summary;
  }
  getProfileSegments(sessionId) {
    return this._stmts.loadProfileSegments.all(sessionId).map(_Store._camelizeProfile);
  }
  // #21: camelize profile rows from DB (snake_case columns -> camelCase JS API)
  static _camelizeProfile(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      segment: row.segment,
      archivedAt: row.archived_at,
      model: row.model,
      projectId: row.project_id,
      lFloor: row.l_floor,
      bTotal: row.b_total,
      lPeak: row.l_peak,
      gFinal: row.g_final,
      oAvg: row.o_avg,
      cRatio: row.c_ratio,
      turns: row.turns,
      durationMs: row.duration_ms,
      totalTokensRead: row.total_tokens_read,
      mf: row.mf,
      ppExit: row.pp_exit,
      brExit: row.br_exit,
      brPeak: row.br_peak,
      ppPeak: row.pp_peak,
      p0: row.p0,
      bAxis: row.b_axis,
      xAxis: row.x_axis,
      gMin: row.g_min,
      turnAtBrAmber: row.turn_at_br_amber,
      archiveSource: row.archive_source,
      archivePriority: row.archive_priority
    };
  }
  getProfile(sessionId) {
    return _Store._camelizeProfile(this._stmts.loadProfile.get(sessionId));
  }
  getAllProfiles() {
    return this._stmts.loadAllProfiles.all().map(_Store._camelizeProfile);
  }
  // --- Sweep (GC): replay-first archive-then-delete expired sessions ---
  sweep(maxAgeMs, {
    now = Date.now(),
    isLiveSession,
    resolveTranscriptPath,
    replaySession,
    limit = GC_BATCH_LIMIT
  } = {}) {
    try {
      const handoffCutoff = now - GC_HANDOFF_MAX_AGE_DAYS * 24 * 3600 * 1e3;
      this._db.exec("BEGIN IMMEDIATE");
      const candidates = this._stmts.sessionsWithExpiringHandoffs.all(handoffCutoff);
      this._stmts.deleteOldHandoffs.run(handoffCutoff);
      for (const { session_id } of candidates) this._stmts.deleteTurnNotesIfNoHandoff.run(session_id);
      this._db.exec("COMMIT");
    } catch (e) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
      }
      if (process.env.SW_DEBUG) console.error("[sweep] handoff GC", e.message);
    }
    const cutoff = now - maxAgeMs;
    const expired = this._stmts.expiredSessions.all(cutoff);
    let count = 0;
    for (const { session_id } of expired) {
      if (count >= limit) break;
      if (isLiveSession && isLiveSession(session_id)) continue;
      const transcriptPath = resolveTranscriptPath ? resolveTranscriptPath(session_id) : null;
      const canReplay = transcriptPath && replaySession && this._canReplay(transcriptPath);
      let archiveOk = false;
      try {
        if (canReplay) {
          replaySession(session_id, transcriptPath);
          archiveOk = true;
        } else {
          archiveOk = this._gcFromSnapshot(session_id);
        }
      } catch (e) {
        if (process.env.SW_DEBUG) console.error("[sweep] archive", session_id, e.message);
      }
      if (archiveOk) {
        this._cascadeDelete(session_id);
        count++;
      }
    }
    if (count > 0) {
      try {
        this._db.exec("PRAGMA incremental_vacuum");
      } catch {
      }
    }
    return count;
  }
  _canReplay(transcriptPath) {
    try {
      const st = statSync(transcriptPath);
      return st.isFile() && st.size <= GC_REPLAY_MAX_FILE_BYTES;
    } catch {
      return false;
    }
  }
  _gcFromSnapshot(sessionId) {
    const snapRow = this._stmts.loadState.get(sessionId, "profile_snapshot");
    const sessRow = this._stmts.loadSessionMeta.get(sessionId);
    if (!snapRow && !sessRow) return true;
    const snap = snapRow ? JSON.parse(snapRow.value) : {};
    this.archiveSegmentProfile(sessionId, snap.segment ?? 0, {
      archiveSource: "snapshot",
      model: snap.model || sessRow?.model || null,
      projectId: sessRow?.project_id || null,
      bTotal: snap.b_total,
      gFinal: snap.g_final,
      lPeak: snap.l_peak,
      cRatio: snap.c_ratio,
      turns: snap.turns,
      mf: snap.mf,
      brExit: snap.br_exit
    }, snap.paths || []);
    return true;
  }
  _cascadeDelete(sessionId) {
    this.deleteSession(sessionId);
  }
  // --- Line-level operations (paths + lines tables) ---
  setLines(sessionId, path3, entries) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.setDelta.run(sessionId, path3, 0, now);
      this._stmts.clearLines.run(sessionId, path3);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path3, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  updateLines(sessionId, path3, entries) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.upsertPath.run(sessionId, path3, now);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path3, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  addEditDelta(sessionId, path3, delta) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.addDelta.run(sessionId, path3, delta, now);
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  getPathTotal(sessionId, path3) {
    const row = this._stmts.pathTotal.get(sessionId, path3);
    return row ? row.total : 0;
  }
  getAllPathTotals(sessionId) {
    const rows = this._stmts.allTotals.all(sessionId);
    const map = /* @__PURE__ */ new Map();
    for (const row of rows) map.set(row.path, row.total);
    return map;
  }
  clearPath(sessionId, path3) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.clearLines.run(sessionId, path3);
      this._stmts.clearPathMeta.run(sessionId, path3);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  clearAllPaths(sessionId) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.clearAllLines.run(sessionId);
      this._stmts.clearAllPathsMeta.run(sessionId);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  // --- Handoff CRUD ---
  static _camelizeHandoff(r) {
    if (!r) return null;
    return {
      handoffId: r.handoff_id,
      sessionId: r.session_id,
      segment: r.segment,
      loadToken: r.load_token,
      createdAt: r.created_at,
      pathsToKeep: r.paths_to_keep,
      summary: r.summary,
      nextTask: r.next_task,
      summaryTokens: r.summary_tokens,
      keptTokens: r.kept_tokens,
      discardedTokens: r.discarded_tokens,
      preparedAtTurn: r.prepared_at_turn,
      previousStats: r.previous_stats,
      preparedStats: r.prepared_stats,
      searchTerms: r.search_terms,
      projectId: r.project_id,
      deliveredAt: r.delivered_at,
      deliveredSegment: r.delivered_segment,
      deliveredSessionId: r.delivered_session_id,
      loaderVersion: r.loader_version,
      bucketSnapshot: r.bucket_snapshot,
      transcriptPath: r.transcript_path
    };
  }
  insertHandoff(row) {
    const res = this._stmts.insertHandoff.run(
      row.sessionId,
      row.segment,
      row.loadToken,
      row.createdAt,
      row.pathsToKeep,
      row.summary,
      row.nextTask ?? null,
      row.summaryTokens,
      row.keptTokens ?? null,
      row.discardedTokens ?? null,
      row.preparedAtTurn ?? null,
      row.previousStats ?? null,
      row.preparedStats ?? null,
      row.searchTerms ?? null,
      row.projectId ?? null,
      row.bucketSnapshot ?? null,
      row.transcriptPath ?? null
    );
    return { handoffId: Number(res.lastInsertRowid) };
  }
  // Overwrite paths_to_keep with per-entry telemetry (content_hash_load stamping). Fire-and-forget:
  // the caller has already committed the claim; this is a post-txn back-fill of hl on the stored row.
  stampContentHashLoad(handoffId, pathsToKeepJson) {
    this._stmts.stampPathsToKeep.run(pathsToKeepJson, handoffId);
  }
  insertHandoffLoad({ handoffId, sessionId, loadedAt, loaderVersion, claimResult, primarySessionId, consumerSegment }) {
    this._stmts.insertHandoffLoad.run(
      handoffId,
      sessionId,
      loadedAt,
      loaderVersion ?? null,
      claimResult,
      primarySessionId ?? null,
      consumerSegment ?? null
    );
  }
  updateHandoff(token, row) {
    const res = this._stmts.updateHandoff.run(
      row.pathsToKeep,
      row.summary,
      row.nextTask ?? null,
      row.summaryTokens,
      row.keptTokens ?? null,
      row.discardedTokens ?? null,
      row.preparedAtTurn ?? null,
      row.previousStats ?? null,
      row.preparedStats ?? null,
      row.searchTerms ?? null,
      row.bucketSnapshot ?? null,
      row.transcriptPath ?? null,
      token
    );
    return res.changes > 0;
  }
  // PURE classifier: given the committed handoff row + this caller's session, what is the claim
  // relationship? Used by the txn body AND the catch path so both agree on committed state.
  static _classifyClaim(row, sessionId) {
    if (row.delivered_session_id != null && row.delivered_session_id !== sessionId) {
      return { claimResult: "duplicate", primarySessionId: row.delivered_session_id };
    }
    return { claimResult: "primary", primarySessionId: null };
  }
  // Delivery: read the handoff row, write the first primary binding when absent, write one `handoff_load`
  // attempt, and return the detached row — all in one transaction. Response composition is the caller's and
  // starts after commit, so a same-session retry recomposes rather than re-binds. Only the failure carries
  // `ok` (`ok: false`); a delivered row has no `ok` field and an unknown token returns null, so a caller
  // tells failure by `ok === false`.
  deliverHandoffByToken(token, opts = {}) {
    const row = this._stmts.loadHandoffToken.get(token);
    if (!row) return null;
    const { sessionId = null, loaderVersion = null, consumerSegment = null } = opts;
    if (sessionId == null) {
      const out3 = _Store._camelizeHandoff(row);
      out3.claimResult = "primary";
      out3.claimedNow = false;
      return out3;
    }
    const now = Date.now();
    let claimResult = "primary";
    let primarySessionId = null;
    let claimedNow = false;
    let legacyBind = false;
    try {
      this._db.exec("BEGIN IMMEDIATE");
      if (row.delivered_at == null) {
        const { changes } = this._stmts.markDelivered.run(now, sessionId, consumerSegment, loaderVersion, row.handoff_id);
        if (changes > 0) {
          claimedNow = true;
          row.delivered_at = now;
          row.delivered_session_id = sessionId;
          row.delivered_segment = consumerSegment;
          row.loader_version = loaderVersion;
        } else {
          Object.assign(row, this._stmts.loadHandoffToken.get(token));
        }
      } else if (row.delivered_session_id == null) {
        const { changes } = this._stmts.markDeliveredLegacy.run(sessionId, consumerSegment, loaderVersion, row.handoff_id);
        if (changes > 0) {
          legacyBind = true;
          claimedNow = true;
          row.delivered_session_id = sessionId;
          row.delivered_segment = consumerSegment;
          row.loader_version = loaderVersion;
        } else {
          Object.assign(row, this._stmts.loadHandoffToken.get(token));
        }
      }
      ({ claimResult, primarySessionId } = _Store._classifyClaim(row, sessionId));
      if (legacyBind) claimResult = "legacy_unattributed";
      this._stmts.insertHandoffLoad.run(
        row.handoff_id,
        sessionId,
        now,
        loaderVersion ?? null,
        claimResult,
        primarySessionId ?? null,
        consumerSegment ?? null
      );
      this._db.exec("COMMIT");
    } catch (e) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
      }
      if (process.env.SW_DEBUG) console.error("[handoff_load]", e.message);
      return { ok: false, error: "handoff_delivery_unavailable", retryable: true };
    }
    const out2 = _Store._camelizeHandoff(row);
    out2.claimResult = claimResult;
    out2.claimedNow = claimedNow;
    return out2;
  }
  // The row a load_token names, delivered or not, or null. `getHandoff` is the lookup by handoff_id.
  getHandoffByToken(token) {
    return _Store._camelizeHandoff(this._stmts.loadHandoffToken.get(token));
  }
  // R1-H: project-scoped — filters by project_id when provided (NULL = any project).
  loadHandoffBySession(sid, { projectId = null } = {}) {
    return _Store._camelizeHandoff(this._stmts.loadHandoffSession.get(sid, projectId, projectId));
  }
  // The undelivered handoffs of one project this session may auto-match, as one of three answers. It is
  // READ-ONLY: nothing may be stamped while more than one candidate matches, so the decision and the write
  // are separate operations.
  findPendingHandoffsByProject(projectId, sessionId, { ttlMs = 7 * 864e5 } = {}) {
    if (!projectId) return { status: "none" };
    const cutoff = Date.now() - ttlMs;
    const rows = this._stmts.loadHandoffByProject.all(projectId, sessionId, cutoff).map(_Store._camelizeHandoff);
    if (rows.length === 0) return { status: "none" };
    if (rows.length > 1) return { status: "ambiguous", rows };
    return { status: "unique", row: rows[0] };
  }
  // R1-H: project-scoped FTS search. Statement prepared LAZILY (handoff_fts may not exist).
  searchHandoff(matchExpr, { projectId = null, limit = 3 } = {}) {
    if (!this.ftsAvailable) return [];
    if (!this._searchStmt) {
      this._searchStmt = this._db.prepare(`SELECT h.load_token, h.created_at, h.next_task,
        substr(h.summary, 1, 200) AS summary_preview
        FROM handoff_fts JOIN handoff h ON h.handoff_id = handoff_fts.rowid
        WHERE handoff_fts MATCH ? AND (h.project_id = ? OR ? IS NULL)
        ORDER BY rank LIMIT ?`);
    }
    return this._searchStmt.all(matchExpr, projectId, projectId, limit).map((r) => ({
      loadToken: r.load_token,
      createdAt: r.created_at,
      nextTask: r.next_task,
      summaryPreview: r.summary_preview
    }));
  }
  // The handoff whose delivery into `sessionId` happened no later than `createdAt` — i.e. the
  // parent of the handoff that `sessionId` went on to prepare at `createdAt`.
  findParentDelivery(projectId, sessionId, createdAt) {
    return _Store._camelizeHandoff(this._stmts.findParentDelivery.get(sessionId, createdAt, projectId));
  }
  // The latest handoff delivered into `sessionId` with no cutoff — the head for a running session.
  findLatestDeliveryHandoff(projectId, sessionId) {
    return _Store._camelizeHandoff(this._stmts.findLatestDeliveryHandoff.get(sessionId, projectId));
  }
  // The newest handoff this session actually loaded, across every project — the head the turn read
  // tools resolve without being handed one.
  findLatestDeliveryInSession(sessionId) {
    return _Store._camelizeHandoff(this._stmts.findLatestDeliveryInSession.get(sessionId));
  }
  // An explicit handoff_id already names one row, so no caller project filter is applied; the
  // returned row's projectId is the scope the lineage walk then uses.
  getHandoff(handoffId) {
    return _Store._camelizeHandoff(this._stmts.getHandoff.get(handoffId));
  }
  // --- Turn note CRUD ---
  static _camelizeTurnNote(r) {
    if (!r) return null;
    return {
      turnNoteId: r.turn_note_id,
      sourceSessionId: r.source_session_id,
      anchorUuid: r.anchor_uuid,
      uText: r.u_text,
      uOriginalChars: r.u_original_chars,
      note: r.note,
      searchTerms: r.search_terms,
      sourceTimestamp: r.source_timestamp,
      createdAt: r.created_at
    };
  }
  // Whole-batch atomicity: one bad row rolls the entire submission back, so a caller never has to
  // reason about a half-written turn queue. exec, not prepare — prepare('BEGIN IMMEDIATE') only
  // compiles the statement and would silently leave every write outside a transaction.
  upsertTurnNotes(rows) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) this._stmts.upsertTurnNote.run(
        r.sourceSessionId,
        r.anchorUuid,
        r.uText,
        r.uOriginalChars,
        r.note ?? null,
        r.searchTerms,
        r.sourceTimestamp,
        Date.now()
      );
      this._db.exec("COMMIT");
    } catch (err2) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
      }
      throw err2;
    }
  }
  listTurnNotes(sessionId) {
    return this._stmts.listTurnNotes.all(sessionId).map(_Store._camelizeTurnNote);
  }
  // FTS locate across a lineage's sessions. The IN list is variable-length (lineage depth), so the
  // statement is built and prepared per call — the set is tiny. No LIMIT: the top rows are taken
  // after the caller validates each anchor against the active path, which can drop matches.
  locateTurnNotes(sessionIds, matchExpr) {
    if (!sessionIds || sessionIds.length === 0) return [];
    const holes = sessionIds.map(() => "?").join(",");
    const sql = `SELECT tn.* FROM turn_note_fts
      JOIN turn_note AS tn ON tn.turn_note_id = turn_note_fts.rowid
     WHERE turn_note_fts MATCH ? AND tn.source_session_id IN (${holes})
     ORDER BY bm25(turn_note_fts) ASC, tn.source_timestamp DESC, tn.source_session_id, tn.anchor_uuid`;
    return this._db.prepare(sql).all(matchExpr, ...sessionIds).map(_Store._camelizeTurnNote);
  }
  turnFtsAvailable() {
    return this._turnFtsAvailable === true;
  }
  resetForTesting() {
    closeStoreGlobal();
  }
};
function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 3e3 });
  try {
    const walResult = db.prepare("PRAGMA journal_mode=WAL").get();
    const actualMode = String(walResult.journal_mode ?? "").toLowerCase();
    if (actualMode !== "wal" && dbPath !== ":memory:") {
      console.error(`[store] WAL unavailable (got ${actualMode}). Check local filesystem.`);
    }
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    const fts = migrate(db);
    const store = new Store(db);
    store.ftsAvailable = fts.handoffFtsAvailable;
    store._turnFtsAvailable = fts.turnFtsAvailable;
    return store;
  } catch (err2) {
    try {
      db.close();
    } catch {
    }
    throw err2;
  }
}
function closeStore(store) {
  if (store._closed) return;
  store._closed = true;
  store._db.close();
}
var _instance = null;
function defaultDbPath() {
  return join(homedir(), ".session-watcher", "store.sqlite");
}
function initStore(dbPath) {
  if (_instance) closeStore(_instance);
  _instance = openStore(dbPath || defaultDbPath());
  return _instance;
}
function getStore() {
  if (!_instance) throw new Error("Store not initialized");
  return _instance;
}
function closeStoreGlobal() {
  if (_instance) {
    closeStore(_instance);
    _instance = null;
  }
}

// gitignore-loader.js
var import_ignore = __toESM(require_ignore(), 1);
import fs2 from "node:fs";
import path from "node:path";
function findGitRoot(cwd) {
  let dir = cwd;
  for (let i2 = 0; i2 < 64 && dir; i2++) {
    if (fs2.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function dirsRootToCwd(root, cwd) {
  const out2 = [];
  let dir = cwd;
  while (dir && dir.length >= root.length) {
    out2.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out2;
}
function loadIsIgnored(cwd) {
  try {
    const root = findGitRoot(cwd) || cwd;
    const ig = (0, import_ignore.default)();
    let found = false;
    for (const dir of dirsRootToCwd(root, cwd)) {
      const gi = path.join(dir, ".gitignore");
      if (fs2.existsSync(gi)) {
        ig.add(fs2.readFileSync(gi, "utf8"));
        found = true;
      }
    }
    const exclude = path.join(root, ".git", "info", "exclude");
    if (fs2.existsSync(exclude)) {
      ig.add(fs2.readFileSync(exclude, "utf8"));
      found = true;
    }
    if (!found) return null;
    return (rel) => {
      const abs = path.resolve(cwd, rel);
      const relToRoot = path.relative(root, abs);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return false;
      const posix2 = relToRoot.split(path.sep).join("/");
      return posix2 ? ig.ignores(posix2) : false;
    };
  } catch {
    return null;
  }
}

// lib/project-key.js
import { resolve } from "node:path";
function resolveProjectKey({ claudeProjectDir, cwd } = {}) {
  const raw = claudeProjectDir || cwd;
  if (!raw) return null;
  return resolve(raw);
}

// lib/harness/dsh/cache-ttl.js
function cacheTtlForRetention(retention) {
  return retention === "long" ? LONG_CACHE_TTL : null;
}

// dsh/src/composition.js
import { tmpdir } from "node:os";
import { join as join6 } from "node:path";

// lib/session-watcher.js
import { join as join3 } from "node:path";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync, appendFileSync, rmSync } from "node:fs";

// lib/resource-policy.js
import path2 from "node:path";
var SKILL_RESOURCE_PREFIX = "skill:";
function createResourcePolicy({ projectRoot = null, isIgnored = null } = {}) {
  const root = projectRoot || null;
  const ignoreMatcher = typeof isIgnored === "function" ? isIgnored : null;
  function outsideProject(absolute) {
    if (!root || !absolute) return false;
    const relative = path2.relative(root, absolute);
    return relative.startsWith("..") || path2.isAbsolute(relative);
  }
  function discardReasonFor(resourceKey) {
    if (typeof resourceKey !== "string" || resourceKey.length === 0) return null;
    if (resourceKey.startsWith(SKILL_RESOURCE_PREFIX)) return null;
    const absolute = path2.isAbsolute(resourceKey) ? resourceKey : root ? path2.resolve(root, resourceKey) : resourceKey;
    if (outsideProject(absolute)) return "outside-project";
    const relative = root ? path2.relative(root, absolute) : resourceKey;
    if (relative && ignoreMatcher && ignoreMatcher(relative)) return "gitignore";
    return null;
  }
  function resolve3(resourceKey) {
    const defaultDiscardReason = discardReasonFor(resourceKey);
    return { selectedByDefault: defaultDiscardReason === null, defaultDiscardReason };
  }
  const stateOf = (resourceKey, overrides) => overrides[resourceKey] || (discardReasonFor(resourceKey) === null ? "include" : "exclude");
  function infer({ newResourceKeys = [], resourceKeys = [], overrides = {} } = {}) {
    const effective = { ...overrides };
    const inferred = {};
    for (const newKey of newResourceKeys) {
      if (typeof newKey !== "string" || newKey.length === 0) continue;
      if (newKey.startsWith(SKILL_RESOURCE_PREFIX)) continue;
      if (effective[newKey]) continue;
      const lastSlash = newKey.lastIndexOf("/");
      if (lastSlash < 0) continue;
      const parentDir = newKey.slice(0, lastSlash + 1);
      if (root && parentDir === root.replace(/\/$/, "") + "/") continue;
      let unanimous = null;
      let sawSibling = false;
      for (const key of resourceKeys) {
        if (key === newKey) continue;
        const keySlash = key.lastIndexOf("/");
        if (keySlash < 0 || key.slice(0, keySlash + 1) !== parentDir) continue;
        const state = stateOf(key, effective);
        if (!sawSibling) {
          unanimous = state;
          sawSibling = true;
          continue;
        }
        if (state !== unanimous) {
          unanimous = null;
          break;
        }
      }
      if (!sawSibling || unanimous === null) continue;
      if (unanimous === stateOf(newKey, effective)) continue;
      inferred[newKey] = unanimous;
      effective[newKey] = unanimous;
    }
    return inferred;
  }
  return { resolve: resolve3, infer };
}

// lib/dialogue-fold.js
function createGroup(role, observation) {
  return {
    role,
    sourceOrdinal: observation.sourceOrdinal,
    // Empty is not a usable key — capture rejects a head carrying one — so it reaches a fold as no identity.
    sourceEntryId: observation.sourceEntryId || null,
    timestamp: observation.timestamp ?? null,
    text: null,
    hasVisibleText: false,
    // The row currently accumulating text, and its accumulation. One native row writes each content
    // block as its own observation, so the row's visible text is the concatenation of its text blocks —
    // and a later row bearing text supersedes the group's text wholesale.
    textRowOrdinal: null,
    rowText: "",
    toolUseIds: [],
    toolByUseId: /* @__PURE__ */ new Map()
  };
}
function absorbText(group, observation) {
  if (group.textRowOrdinal !== observation.sourceOrdinal) {
    group.textRowOrdinal = observation.sourceOrdinal;
    group.rowText = "";
  }
  group.rowText += observation.text;
  group.text = group.rowText;
  if (!group.hasVisibleText) {
    group.hasVisibleText = true;
    group.sourceOrdinal = observation.sourceOrdinal;
    group.sourceEntryId = observation.sourceEntryId || group.sourceEntryId;
    group.timestamp = observation.timestamp ?? group.timestamp;
  }
}
function absorbToolUse(group, observation) {
  const id = observation.toolUseId;
  if (!group.toolByUseId.has(id)) group.toolUseIds.push(id);
  group.toolByUseId.set(id, {
    name: observation.name,
    input: observation.input,
    cwd: observation.cwd ?? null,
    sourceOrdinal: observation.sourceOrdinal,
    sourceEntryId: observation.sourceEntryId || null,
    timestamp: observation.timestamp ?? null
  });
}
function projectDialogue(observations) {
  const groups = [];
  const assistantGroups = /* @__PURE__ */ new Map();
  const pendingResults = /* @__PURE__ */ new Map();
  let turnBoundaryOrdinal = null;
  let openHumanGroup = null;
  for (const observation of observations) {
    if (observation.type === "turn-boundary") {
      turnBoundaryOrdinal = observation.sourceOrdinal;
      continue;
    }
    if (observation.type === "text") {
      if (observation.role === "assistant") {
        openHumanGroup = null;
        let group = assistantGroups.get(observation.messageId);
        if (!group) {
          group = createGroup("assistant", observation);
          assistantGroups.set(observation.messageId, group);
          groups.push(group);
        }
        absorbText(group, observation);
        continue;
      }
      if (observation.sourceOrdinal !== turnBoundaryOrdinal) continue;
      if (!openHumanGroup || openHumanGroup.sourceOrdinal !== observation.sourceOrdinal) {
        openHumanGroup = createGroup("human", observation);
        openHumanGroup.hasVisibleText = true;
        openHumanGroup.text = "";
        groups.push(openHumanGroup);
      }
      openHumanGroup.rowText += observation.text;
      openHumanGroup.text = openHumanGroup.rowText;
      continue;
    }
    if (observation.type === "tool-use") {
      openHumanGroup = null;
      let group = assistantGroups.get(observation.messageId);
      if (!group) {
        group = createGroup("assistant", observation);
        assistantGroups.set(observation.messageId, group);
        groups.push(group);
      }
      absorbToolUse(group, observation);
      continue;
    }
    if (observation.type === "tool-result") {
      openHumanGroup = null;
      pendingResults.set(observation.toolUseId, observation);
    }
  }
  const folds = groups.map((group, ordinal) => ({
    ordinal,
    role: group.role,
    sourceOrdinal: group.sourceOrdinal,
    sourceEntryId: group.sourceEntryId,
    timestamp: group.timestamp,
    // message===null is how a tool-only fold says "no visible body here". Its tool evidence still
    // travels, and every line consumer walks it the same way.
    message: group.hasVisibleText ? { role: group.role, text: group.text } : null,
    toolPairs: group.toolUseIds.map((id) => pairFor(id, group.toolByUseId.get(id), pendingResults))
  }));
  return { folds };
}
function pairFor(toolUseId, use, pendingResults) {
  const result = pendingResults.get(toolUseId);
  if (result !== void 0) pendingResults.delete(toolUseId);
  return {
    toolUseId,
    name: use.name,
    input: use.input,
    // The row that issued the surviving payload — the row `T` names for this line.
    sourceOrdinal: use.sourceOrdinal,
    sourceEntryId: use.sourceEntryId,
    timestamp: use.timestamp,
    // A tool use's own working directory, carried uninterpreted: the Harness Adapter resolves the native
    // target from this pair and attaches the `resourceKey` shared Turn History reads.
    cwd: use.cwd,
    resourceKey: null,
    // null means "no result row paired with this tool use", which is not the same as a result row that
    // carried no annotation — that one has a `resultMeta` whose annotation is absent.
    result: result === void 0 ? null : result.content,
    // undefined means "no native is_error to report"; an unpaired tool use has none either.
    isError: result === void 0 ? void 0 : result.isError,
    resultMeta: result === void 0 ? null : result.resultMeta,
    resultSourceOrdinal: result === void 0 ? null : result.sourceOrdinal,
    resultSourceEntryId: result === void 0 ? null : result.sourceEntryId || null,
    resultTimestamp: result === void 0 ? null : result.timestamp ?? null
  };
}
function dialogueFoldLines(fold) {
  const lines = [];
  if (fold.message) {
    lines.push({
      kind: "visible",
      foldOrdinal: fold.ordinal,
      sourceOrdinal: fold.sourceOrdinal,
      sourceEntryId: fold.sourceEntryId,
      timestamp: fold.timestamp,
      message: fold.message,
      tool: null
    });
  }
  for (const tool of fold.toolPairs || []) {
    lines.push({
      kind: "tool",
      foldOrdinal: fold.ordinal,
      sourceOrdinal: tool.sourceOrdinal,
      sourceEntryId: tool.sourceEntryId,
      timestamp: tool.timestamp,
      message: null,
      tool
    });
  }
  return lines;
}
function enumerateDialogueLines(folds) {
  if (!Array.isArray(folds)) return [];
  return folds.flatMap((fold) => dialogueFoldLines(fold));
}

// lib/turn.js
import { basename } from "node:path";
import { createHash as createHash2 } from "node:crypto";

// lib/handoff.js
import { posix, isAbsolute, join as join2, normalize, resolve as resolvePath } from "node:path";
import { homedir as homedir2 } from "node:os";
import { readFileSync, statSync as statSync2 } from "node:fs";
import { createHash, randomInt as cryptoRandomInt } from "node:crypto";

// lib/landmarks.js
function nucleus(cRatio, g, bDefault) {
  if (cRatio <= 0 || g <= 0 || bDefault <= 0) return 0;
  return Math.sqrt(2 * cRatio * g / bDefault);
}

// lib/bill-regret.js
var BR_AMBER = 0.1;
var BR_RED = 0.25;
function computeMovableFrac(cRatio, lBase, kStable) {
  if (!(cRatio > 0) || !(lBase > 0) || !(kStable > 0)) return NaN;
  const arm = Math.sqrt(2 * cRatio * lBase * kStable);
  return arm / (arm + lBase + cRatio * kStable);
}
function computeBr(x, dhat, mf) {
  const d = x - 1;
  if (!(d > 0) || !(dhat > 0) || !(mf >= 0)) return NaN;
  const u = d / dhat;
  const ppFrac = (u - 1) * (u - 1) / (2 * u);
  return mf * ppFrac;
}
function computePp(x, dhat) {
  if (!Number.isFinite(x) || !Number.isFinite(dhat) || dhat <= 0) return null;
  const u = (x - 1) / dhat;
  if (!Number.isFinite(u) || u <= 0) return null;
  return (u - 1) * (u - 1) / (2 * u);
}
function uAtBr(mf, brTarget) {
  if (!Number.isFinite(mf) || mf <= 0) return Infinity;
  if (!Number.isFinite(brTarget)) return Infinity;
  if (brTarget <= 0) return 1;
  const a = mf;
  const b = -(2 * mf + 2 * brTarget);
  const c = mf;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  return (-b + Math.sqrt(disc)) / (2 * a);
}
function walletIntervalFor(mf, brTarget) {
  const u = uAtBr(mf, brTarget);
  if (!Number.isFinite(u)) return Infinity;
  return u * u;
}
function uLeftAtBr(mf, brTarget) {
  return 1 / uAtBr(mf, brTarget);
}
function lampZone(br, { u, mf }) {
  if (!Number.isFinite(br)) return "white";
  if (u < 1) return u >= uLeftAtBr(mf, BR_AMBER) ? "green" : "white";
  if (br >= BR_RED) return "red";
  if (br >= BR_AMBER) return "amber";
  return "green";
}
function wallPositionFor(cRatio) {
  return 1 + cRatio;
}

// lib/token-estimate.js
var CJK_RE = /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;
function charsToTokens(text, ctp, { asciiOnly = false } = {}) {
  if (!text) return 0;
  if (asciiOnly) return text.length / ctp.ascii;
  const cjkCount = (text.match(CJK_RE) || []).length;
  if (cjkCount === 0) return text.length / ctp.ascii;
  return (text.length - cjkCount) / ctp.ascii + cjkCount / ctp.cjk;
}
function countsToTokens({ chars, cjk }, ctp) {
  if (chars === 0) return 0;
  if (cjk === 0) return chars / ctp.ascii;
  return (chars - cjk) / ctp.ascii + cjk / ctp.cjk;
}

// lib/handoff.js
var STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "let",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  "out",
  "up",
  "down",
  "off",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "about",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "we",
  "they",
  "them",
  "my",
  "our",
  "your",
  "his",
  "her",
  "what",
  "which",
  "implement",
  "add",
  "fix",
  "update",
  "refactor",
  "create",
  "make",
  "use",
  "using",
  "new",
  "file",
  "code",
  "function",
  "method"
]);
var SUFFIX_WORDS = [
  // animals (40)
  "fox",
  "owl",
  "elk",
  "hare",
  "wren",
  "lynx",
  "seal",
  "moth",
  "crab",
  "toad",
  "hawk",
  "deer",
  "bass",
  "crow",
  "dove",
  "frog",
  "goat",
  "lark",
  "mule",
  "newt",
  "puma",
  "slug",
  "swan",
  "wasp",
  "wolf",
  "bear",
  "colt",
  "duck",
  "finch",
  "heron",
  "orca",
  "pike",
  "robin",
  "stoat",
  "crane",
  "grebe",
  "egret",
  "bison",
  "raven",
  "shark",
  // colors (24)
  "blue",
  "jade",
  "rust",
  "teal",
  "plum",
  "gold",
  "ruby",
  "sage",
  "amber",
  "coral",
  "ivory",
  "peach",
  "blush",
  "azure",
  "cedar",
  "onyx",
  "opal",
  "mauve",
  "wine",
  "lilac",
  "mocha",
  "khaki",
  "cream",
  "ebony",
  // materials (24)
  "iron",
  "oak",
  "clay",
  "silk",
  "tin",
  "wax",
  "jute",
  "lime",
  "flint",
  "steel",
  "brass",
  "hemp",
  "linen",
  "glass",
  "stone",
  "slate",
  "pine",
  "birch",
  "maple",
  "ash",
  "wool",
  "suede",
  "tweed",
  "balsa",
  // weather & sky (24)
  "rain",
  "mist",
  "dusk",
  "dawn",
  "snow",
  "hail",
  "gale",
  "frost",
  "storm",
  "sleet",
  "fog",
  "cloud",
  "dew",
  "blaze",
  "lunar",
  "solar",
  "comet",
  "flare",
  "wind",
  "north",
  "south",
  "east",
  "west",
  "gust",
  // nature & terrain (40)
  "reef",
  "dune",
  "moss",
  "fern",
  "peak",
  "cove",
  "glen",
  "bay",
  "cliff",
  "ridge",
  "creek",
  "lake",
  "pond",
  "marsh",
  "brook",
  "grove",
  "vale",
  "knoll",
  "bluff",
  "ledge",
  "shoal",
  "delta",
  "gorge",
  "field",
  "trail",
  "basin",
  "heath",
  "scrub",
  "peat",
  "ford",
  "cape",
  "isle",
  "spur",
  "mesa",
  "falls",
  "inlet",
  "shore",
  "gully",
  "atoll",
  "fjord",
  // food & plants (24)
  "mint",
  "fig",
  "plumb",
  "seed",
  "root",
  "herb",
  "grain",
  "berry",
  "olive",
  "mango",
  "basil",
  "thyme",
  "pecan",
  "cocoa",
  "clove",
  "acorn",
  "gourd",
  "kelp",
  "lotus",
  "tulip",
  "poppy",
  "daisy",
  "ivy",
  "palm",
  // tools & objects (24)
  "axle",
  "gear",
  "reel",
  "bell",
  "lens",
  "flag",
  "coin",
  "rope",
  "knot",
  "ring",
  "lamp",
  "nail",
  "hook",
  "arch",
  "hinge",
  "lever",
  "wheel",
  "valve",
  "gauge",
  "lathe",
  "anvil",
  "wedge",
  "clamp",
  "prism",
  // shapes & concepts (24)
  "cube",
  "node",
  "grid",
  "mesh",
  "link",
  "loop",
  "dome",
  "arc",
  "span",
  "tier",
  "slab",
  "core",
  "edge",
  "axis",
  "plane",
  "helix",
  "facet",
  "nexus",
  "orbit",
  "pulse",
  "surge",
  "flux",
  "drift",
  "spark",
  // music & sound (16)
  "harp",
  "lute",
  "flute",
  "horn",
  "chime",
  "tempo",
  "chord",
  "fife",
  "lyric",
  "hymn",
  "tune",
  "note",
  "gong",
  "viola",
  "cello",
  "oboe",
  // misc (16)
  "latch",
  "quill",
  "torch",
  "flask",
  "pouch",
  "staff",
  "crown",
  "badge",
  "crest",
  "manor",
  "forge",
  "vault",
  "haven",
  "guild",
  "helm",
  "craft"
];
var SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /^[A-Z_]{2,}=[^\s]{4,}$/gm
];
function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out2 = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out2 = out2.replace(re, "[REDACTED]");
  }
  return out2;
}
function generateLoadToken(summary, nextTask, randomInt) {
  const source = nextTask && nextTask.trim() || String(summary || "").split("\n")[0] || "";
  const words = (source.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((w) => !STOP_WORDS.has(w) && w.length > 3).slice(0, 2);
  while (words.length < 2) words.push(SUFFIX_WORDS[randomInt(SUFFIX_WORDS.length)]);
  const suffix = SUFFIX_WORDS[randomInt(SUFFIX_WORDS.length)];
  return [...words, suffix].join("-").toLowerCase();
}
function normalizeKeepPath(p, projectDir) {
  const raw = String(p || "").replace(/\\/g, "/");
  const norm = posix.normalize(raw);
  if (norm.startsWith("..") || norm.split("/").includes(".."))
    return { path: norm, invalid: true };
  if (projectDir && norm.startsWith("/")) {
    const pd = projectDir.replace(/\/+$/, "");
    if (norm === pd || norm.startsWith(pd + "/"))
      return { path: norm.slice(pd.length + 1) || ".", invalid: false };
    return { path: norm, invalid: false, external: true };
  }
  if (norm.startsWith("/"))
    return { path: norm, invalid: false, external: true };
  return { path: norm.replace(/^\/+/, ""), invalid: false };
}
var isCjk = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 13312 && c <= 40959 || c >= 12352 && c <= 12543 || c >= 44032 && c <= 55203 || c >= 63744 && c <= 64255;
};
function cjkBigrams(text) {
  const out2 = [];
  const s = String(text || "");
  let run2 = "";
  const flush = () => {
    for (let i2 = 0; i2 + 1 < run2.length; i2++) out2.push(run2.slice(i2, i2 + 2));
    run2 = "";
  };
  for (const ch of s) {
    if (isCjk(ch)) run2 += ch;
    else flush();
  }
  flush();
  return out2.join(" ");
}
function buildFtsMatch(query, mode = "plain") {
  const q = String(query || "");
  if (mode === "advanced") return q;
  const terms = q.split(/\s+/).filter(Boolean);
  const parts2 = [];
  for (const t of terms) {
    let seg = "", segCjk = null;
    const emit = (s, isCjkSeg) => {
      const bg = isCjkSeg && cjkBigrams(s);
      if (bg) parts2.push(...bg.split(" ").map((b) => `"${b.replace(/"/g, "")}"`));
      else parts2.push(`"${s.replace(/"/g, "")}"`);
    };
    for (const ch of t) {
      const c = isCjk(ch);
      if (segCjk === null) {
        seg = ch;
        segCjk = c;
      } else if (c !== segCjk) {
        emit(seg, segCjk);
        seg = ch;
        segCjk = c;
      } else seg += ch;
    }
    if (seg) emit(seg, segCjk);
  }
  return parts2.join(" ");
}
var HASH_MAX_BYTES = 8 * 1024 * 1024;
function hashFileContent(absPath) {
  try {
    const st = statSync2(absPath);
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}
var AGENT_ENTRY_KEYS = ["path", "symbols", "lines", "symbolRanges", "resolvedSymbols"];
function projectEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out2 = {};
  for (const key of AGENT_ENTRY_KEYS) if (entry[key] !== void 0) out2[key] = entry[key];
  return out2;
}
function canonicalResourcePath(rawPath, base) {
  let p = rawPath;
  if (p === "~" || p.startsWith("~/")) p = join2(homedir2(), p.slice(1));
  const abs = isAbsolute(p) ? p : resolvePath(base || "/", p);
  return normalize(abs).split("\\").join("/");
}
function collapseLineRanges(lineNumbers) {
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  if (sorted.length === 0) return void 0;
  const ranges = [];
  let start2 = sorted[0];
  let end = sorted[0];
  for (let i2 = 1; i2 < sorted.length; i2++) {
    if (sorted[i2] <= end + 1) {
      end = sorted[i2];
      continue;
    }
    ranges.push([start2, end]);
    start2 = sorted[i2];
    end = sorted[i2];
  }
  ranges.push([start2, end]);
  return ranges;
}
var flatRanges = (ranges) => ranges.map(([a, b]) => `${a}-${b}`).join(", ");
function createHandoffComposition({
  readBytes = (absPath) => readFileSync(absPath),
  statFile = statSync2,
  hashFile = hashFileContent,
  now = Date.now,
  randomInt = (bound) => cryptoRandomInt(bound)
} = {}) {
  function countFileLinesBounded(absPath) {
    try {
      const stat = statFile(absPath);
      if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return null;
      if (stat.size === 0) return 0;
      const buffer = readBytes(absPath);
      let newlines = 0;
      for (let i2 = 0; i2 < buffer.length; i2++) if (buffer[i2] === 10) newlines++;
      return buffer[buffer.length - 1] === 10 ? newlines : newlines + 1;
    } catch {
      return null;
    }
  }
  function normalizeSkills(skillsToKeep) {
    return Array.isArray(skillsToKeep) ? [...new Set(skillsToKeep.filter((name3) => typeof name3 === "string" && name3.length > 0))] : [];
  }
  function payloadOf(entries, skills) {
    return skills.length ? { paths: entries, skills } : entries;
  }
  function readPayload(json) {
    const payload = JSON.parse(json);
    return Array.isArray(payload) ? { entries: payload, skills: [] } : { entries: payload.paths, skills: payload.skills ?? [] };
  }
  const redactNextTask = (nextTask) => nextTask != null && String(nextTask) !== "" ? redactSecrets(String(nextTask)) : null;
  function checkInput({ pathsToKeep, summary, nextTask }, { creating }) {
    if (pathsToKeep == null) {
      if (creating) return { status: "error", error: "paths_to_keep_required", instruction: newHandoffInstruction };
    } else if (!Array.isArray(pathsToKeep)) {
      return { status: "error", error: "invalid_paths_to_keep" };
    } else if (pathsToKeep.length > HANDOFF_MAX_PATHS) {
      return { status: "error", error: "too_many_paths", max_paths: HANDOFF_MAX_PATHS, actual_paths: pathsToKeep.length };
    }
    if (summary != null || creating) {
      if (typeof summary !== "string" || summary.length === 0) {
        return { status: "error", error: "summary_required", instruction: newHandoffInstruction };
      }
      if (summary.length > HANDOFF_MAX_SUMMARY_CHARS) {
        return {
          status: "error",
          error: "summary_too_long",
          max_chars: HANDOFF_MAX_SUMMARY_CHARS,
          actual_chars: summary.length,
          instruction: "Compress the summary and call prepare_handoff again."
        };
      }
    }
    if (nextTask != null && String(nextTask).length > HANDOFF_MAX_NEXT_TASK_CHARS) {
      return {
        status: "error",
        error: "next_task_too_long",
        max_chars: HANDOFF_MAX_NEXT_TASK_CHARS,
        actual_chars: String(nextTask).length
      };
    }
    return null;
  }
  function composeText({ summary, nextTask, ctp }) {
    return {
      summaryTokens: Math.round(charsToTokens(summary, ctp || DEFAULT_CTP)),
      searchTerms: [cjkBigrams(summary), nextTask ? cjkBigrams(nextTask) : ""].filter(Boolean).join(" ")
    };
  }
  function composePaths({ pathsToKeep, skills, measurement, filePaths, ctp, projectRoot, symbolRangesFor, rateForKept }) {
    const snapshotPaths = filePaths.map((row, index) => ({
      id: "b" + index,
      raw_path: row.path,
      canonical_path: null,
      whole_ctp: row.tokens,
      // a scope-labelled estimate, not a bound
      whole_bytes: null,
      lastTurn: row.lastTurn ?? null
    }));
    const invalidPaths = [];
    const unknownPaths = [];
    const keptEntries = [];
    const seenPaths = /* @__PURE__ */ new Set();
    for (const raw of pathsToKeep) {
      if (!raw || typeof raw !== "object" || typeof raw.path !== "string") {
        invalidPaths.push(raw);
        continue;
      }
      const { path: path3, invalid } = normalizeKeepPath(raw.path, projectRoot);
      if (invalid) {
        invalidPaths.push(raw);
        continue;
      }
      if (seenPaths.has(path3)) continue;
      seenPaths.add(path3);
      const symbols = Array.isArray(raw.symbols) ? raw.symbols.filter((name3) => typeof name3 === "string") : void 0;
      keptEntries.push({ path: path3, symbols: symbols && symbols.length ? symbols : void 0 });
    }
    const canonicalBase = projectRoot || process.cwd();
    const keptCanon = (relative) => canonicalResourcePath(relative, canonicalBase);
    for (const entry of keptEntries) {
      const absolute = keptCanon(entry.path);
      const exact = snapshotPaths.filter((candidate) => candidate.canonical_path === absolute || candidate.raw_path === absolute || candidate.raw_path === entry.path);
      const suffix = snapshotPaths.filter((candidate) => candidate.canonical_path && candidate.canonical_path.endsWith("/" + entry.path) || candidate.raw_path.endsWith("/" + entry.path));
      const matches = exact.length ? exact : suffix;
      let hashTarget = null;
      if (matches.length === 1) {
        entry.bucket_id = matches[0].id;
        entry.match_status = "exact";
        if (matches[0].canonical_path == null) matches[0].canonical_path = keptCanon(matches[0].raw_path);
        if (matches[0].whole_bytes == null) {
          try {
            const stat = statFile(matches[0].canonical_path);
            if (stat.isFile()) matches[0].whole_bytes = stat.size;
          } catch {
          }
        }
        hashTarget = matches[0].canonical_path;
      } else if (matches.length > 1) {
        entry.bucket_id = null;
        entry.match_status = "ambiguous";
        entry.candidate_bucket_ids = matches.map((candidate) => candidate.id);
      } else {
        entry.bucket_id = null;
        entry.match_status = "unmatched";
      }
      entry.hp = hashTarget ? hashFile(hashTarget) : null;
      entry.total_line_count = hashTarget ? countFileLinesBounded(hashTarget) : null;
    }
    const known = new Map(filePaths.map((row) => [row.path, { tokens: row.tokens, lastTurn: row.lastTurn }]));
    const resolvedPaths = [];
    const keptKeys = [];
    let keptTokens = 0;
    for (const entry of keptEntries) {
      const matches = [];
      for (const [key, info2] of known) {
        if (key === entry.path || key.endsWith("/" + entry.path)) matches.push({ key, ...info2 });
      }
      if (matches.length > 1) {
        matches.sort((a, b) => b.lastTurn - a.lastTurn);
        keptTokens += matches[0].tokens;
        keptKeys.push(matches[0].key);
        resolvedPaths.push({ from: entry.path, to: matches[0].key });
      } else if (matches.length === 1) {
        keptTokens += matches[0].tokens;
        keptKeys.push(matches[0].key);
      } else {
        unknownPaths.push(entry.path);
      }
    }
    for (const entry of keptEntries) {
      const row = filePaths.find((candidate) => candidate.path === entry.path) ?? filePaths.find((candidate) => candidate.path.endsWith("/" + entry.path));
      if (!row) continue;
      const lineNumbers = Array.isArray(row.lineNumbers) ? row.lineNumbers : [];
      if (!row.fullSnapshot && lineNumbers.length > 0) entry.lines = collapseLineRanges(lineNumbers);
      if (entry.symbols && entry.symbols.length > 0) {
        const ranges = symbolRangesFor({ path: row.path, symbols: entry.symbols, lineNumbers });
        if (ranges && Object.keys(ranges).length > 0) {
          entry.symbolRanges = ranges;
          delete entry.symbols;
        }
      }
    }
    for (const entry of keptEntries) {
      if (Array.isArray(entry.lines) && entry.lines.length > 0) {
        entry.selected_line_count = entry.lines.reduce((n, [a, b]) => n + (b - a + 1), 0);
      } else if (entry.symbolRanges && typeof entry.symbolRanges === "object") {
        const allRanges = Object.values(entry.symbolRanges).flat().sort((a, b) => a[0] - b[0]);
        let count = 0;
        let prevEnd = -1;
        for (const [a, b] of allRanges) {
          const start2 = Math.max(a, prevEnd + 1);
          if (start2 <= b) count += b - start2 + 1;
          prevEnd = Math.max(prevEnd, b);
        }
        entry.selected_line_count = count;
      } else {
        entry.selected_line_count = entry.total_line_count ?? null;
      }
    }
    const bucketSnapshot = JSON.stringify({
      v: 1,
      ctp_version: ctp.version,
      root: projectRoot || null,
      total_candidates: snapshotPaths.length,
      paths: snapshotPaths
    });
    let allPathTokens = 0;
    for (const row of filePaths) allPathTokens += row.tokens || 0;
    const discardedTokens = Math.max(0, allPathTokens - keptTokens);
    const m = measurement.measurement;
    const bDefault = m.B > 0 && m.cRatio > 0 ? m.bDefault : m.B;
    const dead = m.dead;
    const sessionFloor = m.sessionFloor || dead;
    const previousStats = {
      b_full: m.B,
      b_default: bDefault,
      g: m.gBar,
      mf: m.mf,
      br_exit: m.br,
      pp_exit: m.pp,
      turns: measurement.turnSeq,
      total_l: m.L,
      dead,
      session_floor: sessionFloor,
      residual: Math.max(0, m.L - m.B)
    };
    const bKept = keptTokens > 0 ? keptTokens + sessionFloor : null;
    const preparedStats = bKept && m.cRatio > 0 ? (() => {
      const gKept = rateForKept(keptKeys);
      const dhatKept = nucleus(m.cRatio, gKept, bKept);
      const mfKept = computeMovableFrac(m.cRatio, bKept, gKept);
      const xKept = m.L / bKept;
      const brKept = dhatKept > 0 && Number.isFinite(mfKept) ? computeBr(xKept, dhatKept, mfKept) : null;
      return { b_kept: bKept, dead, session_floor: sessionFloor, g: gKept, mf: mfKept, br: brKept, pp: computePp(xKept, dhatKept), dhat: dhatKept, x: xKept };
    })() : null;
    return {
      payload: JSON.stringify(payloadOf(keptEntries, skills)),
      keptPaths: keptEntries.length,
      keptTokens,
      discardedTokens,
      preparedAtTurn: measurement.turnSeq,
      previousStats: JSON.stringify(previousStats),
      preparedStats: preparedStats ? JSON.stringify(preparedStats) : null,
      bucketSnapshot,
      unknownPaths,
      invalidPaths,
      resolvedPaths
    };
  }
  function composePrepared({ input, measurement, filePaths, ctp, projectRoot, symbolRangesFor, rateForKept }) {
    const { pathsToKeep, skillsToKeep, summary, nextTask } = input ?? {};
    const invalid = checkInput({ pathsToKeep, summary, nextTask }, { creating: true });
    if (invalid) return invalid;
    const redSummary = redactSecrets(summary);
    const redNext = redactNextTask(nextTask);
    const text = composeText({ summary: redSummary, nextTask: redNext, ctp });
    const paths = composePaths({
      pathsToKeep,
      skills: normalizeSkills(skillsToKeep),
      measurement,
      filePaths,
      ctp,
      projectRoot,
      symbolRangesFor,
      rateForKept
    });
    return {
      row: {
        pathsToKeep: paths.payload,
        summary: redSummary,
        nextTask: redNext,
        summaryTokens: text.summaryTokens,
        keptTokens: paths.keptTokens,
        discardedTokens: paths.discardedTokens,
        preparedAtTurn: paths.preparedAtTurn,
        previousStats: paths.previousStats,
        preparedStats: paths.preparedStats,
        searchTerms: text.searchTerms,
        bucketSnapshot: paths.bucketSnapshot
      },
      response: {
        kept_paths: paths.keptPaths,
        kept_tokens: paths.keptTokens,
        discarded_tokens: paths.discardedTokens,
        summary_tokens: text.summaryTokens,
        unknown_paths: paths.unknownPaths,
        invalid_paths: paths.invalidPaths
      },
      resolvedPaths: paths.resolvedPaths,
      tokenSeed: { summary: redSummary, nextTask: redNext }
    };
  }
  function composePatched({
    stored,
    input,
    measurement,
    filePaths,
    ctp,
    projectRoot,
    symbolRangesFor,
    rateForKept,
    transcriptPath
  }) {
    const { pathsToKeep, skillsToKeep, summary, nextTask } = input ?? {};
    const patched = [["summary", summary], ["next_task", nextTask], ["paths_to_keep", pathsToKeep], ["skills_to_keep", skillsToKeep]].filter(([, value]) => value != null).map(([name3]) => name3);
    if (patched.length === 0) return { status: "error", error: "nothing_to_patch", instruction: nothingToPatchInstruction };
    const invalid = checkInput({ pathsToKeep, summary, nextTask }, { creating: false });
    if (invalid) return invalid;
    const row = {
      pathsToKeep: stored.pathsToKeep,
      summary: stored.summary,
      nextTask: stored.nextTask,
      summaryTokens: stored.summaryTokens,
      keptTokens: stored.keptTokens,
      discardedTokens: stored.discardedTokens,
      preparedAtTurn: stored.preparedAtTurn,
      previousStats: stored.previousStats,
      preparedStats: stored.preparedStats,
      searchTerms: stored.searchTerms,
      bucketSnapshot: stored.bucketSnapshot,
      transcriptPath: stored.transcriptPath
    };
    if (summary != null || nextTask != null) {
      const effective = {
        summary: summary != null ? redactSecrets(summary) : stored.summary,
        nextTask: nextTask != null ? redactNextTask(nextTask) : stored.nextTask
      };
      Object.assign(row, effective, composeText({ ...effective, ctp }));
    }
    let paths = null;
    let keptPaths;
    if (pathsToKeep != null) {
      paths = composePaths({
        pathsToKeep,
        skills: skillsToKeep != null ? normalizeSkills(skillsToKeep) : readPayload(stored.pathsToKeep).skills,
        measurement,
        filePaths,
        ctp,
        projectRoot,
        symbolRangesFor,
        rateForKept
      });
      Object.assign(row, {
        pathsToKeep: paths.payload,
        keptTokens: paths.keptTokens,
        discardedTokens: paths.discardedTokens,
        preparedAtTurn: paths.preparedAtTurn,
        previousStats: paths.previousStats,
        preparedStats: paths.preparedStats,
        bucketSnapshot: paths.bucketSnapshot,
        transcriptPath
      });
      keptPaths = paths.keptPaths;
    } else {
      const { entries } = readPayload(stored.pathsToKeep);
      if (skillsToKeep != null) row.pathsToKeep = JSON.stringify(payloadOf(entries, normalizeSkills(skillsToKeep)));
      keptPaths = entries.length;
    }
    const response = {
      kept_paths: keptPaths,
      kept_tokens: row.keptTokens,
      discarded_tokens: row.discardedTokens,
      summary_tokens: row.summaryTokens
    };
    if (paths) {
      response.unknown_paths = paths.unknownPaths;
      response.invalid_paths = paths.invalidPaths;
    }
    return { row, response, resolvedPaths: paths ? paths.resolvedPaths : [], patched };
  }
  function* candidateTokens(tokenSeed) {
    for (let attempt = 0; attempt < HANDOFF_TOKEN_MAX_RETRIES; attempt++) {
      yield generateLoadToken(tokenSeed.summary, tokenSeed.nextTask, randomInt);
    }
  }
  const newHandoffInstruction = "A new handoff needs both summary and paths_to_keep; to revise an undelivered handoff, pass its load_token with only the parameters to change.";
  const nothingToPatchInstruction = "Pass at least one of summary, next_task, paths_to_keep, skills_to_keep.";
  const instructionFor = (loadToken) => `Handoff prepared. Token: ${loadToken}. Please use the context reset the host offers when ready.`;
  const searchExpression = (query, queryMode) => buildFtsMatch(String(query ?? ""), queryMode === "advanced" ? "advanced" : "plain");
  function searchResponse(results) {
    if (!results.length) return { found: false };
    return {
      found: true,
      mode: "search",
      results: results.map((row) => ({
        load_token: row.loadToken,
        created_at: row.createdAt,
        next_task: row.nextTask,
        summary_preview: row.summaryPreview
      })),
      instruction: "Multiple matches. Call load_handoff with the desired load_token for the full package."
    };
  }
  function ambiguityResponse(rows) {
    return {
      found: false,
      ambiguous: true,
      candidates: rows.map((row) => ({
        load_token: row.loadToken,
        created_at: row.createdAt,
        next_task_preview: row.nextTask ? row.nextTask.slice(0, HANDOFF_HOOK_TASK_PREVIEW_CHARS) : null
      }))
    };
  }
  function renderResolution(storedRanges, facts) {
    const stored = Object.entries(storedRanges);
    if (!facts.parsed) {
      return stored.map(([name3, ranges]) => `${name3} \u2014 parser not ready; originally at lines ${flatRanges(ranges)}`);
    }
    if (!facts.readable) {
      return stored.map(([name3, ranges]) => `${name3} \u2014 file removed; originally at lines ${flatRanges(ranges)}`);
    }
    if (facts.resolved.length === 0 && facts.stale.length > 0) {
      const allNames = facts.stale.map((entry) => entry.name).join(", ");
      return [`\u26A0\uFE0F all symbols stale (${allNames}) \u2014 file may have been refactored`].concat(
        facts.stale.map(({ name: name3, storedRanges: ranges }) => `${name3} \u2014 symbol not found; originally at lines ${flatRanges(ranges)}`)
      );
    }
    const output = [];
    for (const { name: name3, startLine, endLine } of facts.resolved) output.push(`${name3} (lines ${startLine}-${endLine})`);
    for (const { name: name3, storedRanges: ranges } of facts.stale) {
      output.push(`${name3} \u2014 symbol not found in current file; originally at lines ${flatRanges(ranges)}`);
    }
    return output;
  }
  async function projectDelivered(row, { resolveSymbols }) {
    let parsed;
    try {
      parsed = JSON.parse(row.pathsToKeep || "{}");
    } catch {
      return { found: false, status: "error", error: "corrupt_handoff" };
    }
    const rawPaths = Array.isArray(parsed) ? parsed : parsed.paths || [];
    const paths = [];
    for (const entry of Array.isArray(rawPaths) ? rawPaths : []) {
      const projected = projectEntry(entry);
      if (entry.symbolRanges && typeof entry.symbolRanges === "object") {
        const facts = entry.path ? await resolveSymbols({ path: entry.path, symbolRanges: entry.symbolRanges, projectDir: row.projectId }) : null;
        projected.resolvedSymbols = facts ? renderResolution(entry.symbolRanges, facts) : [];
        delete projected.symbolRanges;
      }
      paths.push(projected);
    }
    const skills = Array.isArray(parsed) ? void 0 : parsed.skills?.length ? parsed.skills : void 0;
    const out2 = {
      found: true,
      handoff_id: row.handoffId,
      load_token: row.loadToken,
      created_at: row.createdAt,
      summary: row.summary,
      paths_to_keep: paths
    };
    if (row.projectId) out2.project_dir = row.projectId;
    if (skills) out2.skills_to_keep = skills;
    return out2;
  }
  function stampLoadHashes(row, { projectRoot, force }) {
    let payload;
    try {
      payload = JSON.parse(row.pathsToKeep || "null");
    } catch {
      return null;
    }
    const entries = Array.isArray(payload) ? payload : payload && Array.isArray(payload.paths) ? payload.paths : null;
    if (!entries) return null;
    const missing = entries.some((entry) => entry && typeof entry.path === "string" && !("hl" in entry));
    if (!force && !missing) return null;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string") continue;
      entry.hl = hashFile(resolvePath(projectRoot || process.cwd(), entry.path));
    }
    return JSON.stringify(payload);
  }
  return {
    composePrepared,
    composePatched,
    candidateTokens,
    createdAt: () => now(),
    instructionFor,
    searchExpression,
    searchResponse,
    ambiguityResponse,
    projectDelivered,
    stampLoadHashes,
    countFileLinesBounded
  };
}

// lib/dialogue-tool.js
function stableStringify(value) {
  if (value === null || value === void 0) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  if (typeof value === "object") {
    const pairs = Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}
function serializeResult(result) {
  if (result == null) return { resultStr: null, encoding: "text" };
  if (typeof result === "string") return { resultStr: result, encoding: "text" };
  if (Array.isArray(result)) {
    const allText = result.every((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string");
    if (allText) return { resultStr: result.map((b) => b.text).join("\n"), encoding: "text" };
    return { resultStr: stableStringify(result), encoding: "json" };
  }
  return { resultStr: stableStringify(result), encoding: "json" };
}

// lib/turn-history-budget.js
var HISTORY_EXCERPT_CHARS = 200;
var HISTORY_TOKEN_BUDGET = 5e3;
function safePrefix(text, limit) {
  let end = Math.min(text.length, limit);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 55296 && code <= 56319) end--;
  return text.slice(0, end);
}
function safeSuffix(text, limit) {
  let start2 = Math.max(0, text.length - limit);
  const code = text.charCodeAt(start2);
  if (start2 > 0 && code >= 56320 && code <= 57343) start2++;
  return text.slice(start2);
}
function truncationMarker(originalChars) {
  return ` [truncated; ${originalChars} chars]`;
}
function estimateWireTokens(payload, ctp) {
  return Math.round(charsToTokens(JSON.stringify(payload), ctp));
}
function isWithinHistoryBudget(tokens) {
  return tokens <= HISTORY_TOKEN_BUDGET;
}
var CJK_ONE = new RegExp(CJK_RE.source);
function truncateToTokens(text, tokenLimit, ctp) {
  let chars = 0, cjk = 0;
  for (let i2 = 0; i2 < text.length; i2++) {
    const isCjk2 = CJK_ONE.test(text[i2]);
    if (countsToTokens({ chars: chars + 1, cjk: cjk + (isCjk2 ? 1 : 0) }, ctp) > tokenLimit) {
      return safePrefix(text, i2);
    }
    chars += 1;
    if (isCjk2) cjk += 1;
  }
  return text;
}

// lib/turn.js
var U_HEAD_CHARS = 200;
var A_CUT_CHARS = 128;
var AGG_PATH_CAP = 6;
var U_TEXT_TOKENS = 200;
var TURN_ADDRESS_RE = /^S(\d+):(\d+)$/;
var turnAddress = (label, sourceOrdinal) => `${label}:${sourceOrdinal}`;
function parseTurnAddress(raw) {
  if (typeof raw !== "string") return null;
  const match = TURN_ADDRESS_RE.exec(raw);
  return match ? { label: `S${match[1]}`, sourceOrdinal: Number(match[2]) } : null;
}
var TURN_PAGE_BOUNDARY_RE = /^S(\d+)(?::(\d+))?$/;
function parseTurnPageBoundary(raw) {
  if (typeof raw !== "string") return null;
  const match = TURN_PAGE_BOUNDARY_RE.exec(raw);
  if (!match) return null;
  return { label: `S${match[1]}`, sourceOrdinal: match[2] === void 0 ? null : Number(match[2]) };
}
function labelHistorySources(lineage) {
  return lineage.map((entry, index) => ({ ...entry, label: `S${index + 1}`, index }));
}
async function readHistorySource({ dialogueSource, dialogueProjection }, sourceLocator) {
  const read = await dialogueSource.read(sourceLocator);
  if (read.status !== "ok") return { readable: false, folds: [], turns: [] };
  const { folds } = dialogueProjection.project(read.observations);
  return { readable: true, folds, turns: dialogueProjection.groupTurns(enumerateDialogueLines(folds)) };
}
var PASS = Object.freeze({ kind: "PASS" });
var ABSORB = Object.freeze({ kind: "ABSORB" });
function applyHeadRules(line, rules) {
  for (const rule of rules) {
    const result = rule(line);
    if (result.kind !== "PASS") return result;
  }
  return PASS;
}
function groupTurns(lines, rules) {
  const turns = [];
  for (const line of lines) {
    const result = applyHeadRules(line, rules);
    if (result.kind === "HEAD" || result.kind === "ACK") {
      turns.push({
        sourceOrdinal: line.sourceOrdinal,
        sourceEntryId: line.sourceEntryId,
        timestamp: line.timestamp,
        cleanedU: result.text,
        classification: result.kind,
        lines: [line],
        hasAssistantActivity: false
      });
      continue;
    }
    if (turns.length === 0) continue;
    const turn = turns[turns.length - 1];
    turn.lines.push(line);
    if (turn.classification !== "ACK" && (line.kind === "tool" || line.kind === "visible" && line.message.role === "assistant")) {
      turn.hasAssistantActivity = true;
    }
  }
  return turns;
}
var headCut = (s, n) => s.length > n ? safePrefix(s, n) + "\u2026" : s;
var tailCut = (s, n) => s.length > n ? "\u2026" + safeSuffix(s, n) : s;
function buildSkeleton(turns, sessionId) {
  const head = `CONTEXT EPOCH  session ${sessionId}   turns ${turns.length}`;
  const blocks = turns.map((turn) => {
    const assistantIdx = turn.lines.reduce((acc, line, i2) => {
      if (i2 > 0 && line.kind !== "tool" && line.message?.role !== "human") acc.push(i2);
      return acc;
    }, []);
    const shown = new Set(assistantIdx.length > 1 ? [assistantIdx[0], assistantIdx[assistantIdx.length - 1]] : assistantIdx);
    const headCutAt = assistantIdx.length > 1 ? assistantIdx[0] : -1;
    let toolCalls = 0;
    const basenames = /* @__PURE__ */ new Set();
    const rows = turn.lines.flatMap((line, i2) => {
      const t = String(line.sourceOrdinal).padStart(4);
      if (i2 === 0) {
        const normalized2 = turn.cleanedU.replace(/\r\n?/g, "\n");
        return headCut(normalized2, U_HEAD_CHARS).split("\n").map((part) => `T ${t} | U   : ${part}`);
      }
      if (line.kind === "tool") {
        toolCalls++;
        if (line.tool.resourceKey) basenames.add(basename(line.tool.resourceKey));
        return [];
      }
      if (line.message.role !== "human" && !shown.has(i2)) return [];
      const role = line.message.role === "human" ? "U  " : "A  ";
      const normalized = line.message.text.replace(/\r\n?/g, "\n");
      const text = line.message.role === "human" ? headCut(normalized, U_HEAD_CHARS) : i2 === headCutAt ? headCut(normalized, A_CUT_CHARS) : tailCut(normalized, A_CUT_CHARS);
      return text.split("\n").map((part) => `T ${t} | ${role} : ${part}`);
    });
    if (turn.hasAssistantActivity) {
      const names = [...basenames];
      const shownNames = names.slice(0, AGG_PATH_CAP).join(",");
      const more = names.length > AGG_PATH_CAP ? ` +${names.length - AGG_PATH_CAP}` : "";
      const tools = toolCalls === 0 ? "" : ` \xB7 ${toolCalls} tools${shownNames ? `: ${shownNames}${more}` : ""}`;
      rows.push(`${" ".repeat(6)}| A\xD7${assistantIdx.length}${tools}`);
      rows.push(`${" ".repeat(6)}| NOTE[${turn.sourceOrdinal}]: ____`);
    }
    return rows.join("\n");
  });
  return [head, ...blocks].join("\n\n");
}
var NOTE_SECTION_RE = /^## NOTE\[(\d+)\]\s*$/;
var TURN_NOTE_PROTOCOL = "Read skeleton_path, then write one note into each `## NOTE[T]` section of notes_path. The headings are already written; put each note under its own heading and leave the heading lines exactly as they are. On a first pass one Write of the whole file is enough. After a re-fetch, Edit the empty sections instead \u2014 a whole-file Write would replace notes that file already holds. Then call submit_turn_notes with snapshot_id alone: it reads notes_path itself and accepts no note text.";
function renderNoteSections(slotKeys, bodies) {
  return slotKeys.map((key) => {
    const body2 = bodies?.get(key);
    return body2 ? `## NOTE[${key}]

${body2}
` : `## NOTE[${key}]
`;
  }).join("\n");
}
function slotKeysOf(turns) {
  return turns.filter((turn) => turn.hasAssistantActivity).map((turn) => String(turn.sourceOrdinal));
}
function parseNoteSections(text, slotKeys) {
  const slots = new Set(slotKeys);
  const sections = /* @__PURE__ */ new Map();
  const issues = [];
  if (text == null) return { sections, issues };
  let current = null;
  let buffer = [];
  const close = () => {
    if (current != null) sections.set(current, buffer.join("\n").trim());
  };
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const match = NOTE_SECTION_RE.exec(line);
    const key = match ? String(Number(match[1])) : null;
    if (!slots.has(key)) {
      if (current != null) buffer.push(line);
      continue;
    }
    close();
    if (sections.has(key)) issues.push({ t: Number(key), message: "duplicate NOTE section for this T" });
    current = key;
    buffer = [];
  }
  close();
  return { sections, issues };
}
function snapshotDigest(turns) {
  const canonical = turns.map((turn) => ({
    t: turn.sourceOrdinal,
    anchor: turn.sourceEntryId,
    ts: turn.timestamp,
    u: turn.cleanedU,
    lines: turn.lines.map((l) => l.kind === "tool" ? { k: "t", a: l.sourceEntryId, n: l.tool.name, p: l.tool.resourceKey ?? null } : { k: "v", a: l.sourceEntryId, r: l.message.role, x: l.message.text })
  }));
  return createHash2("sha256").update(stableStringify(canonical)).digest("hex");
}
function storedUText(cleanedU) {
  return { uText: truncateToTokens(cleanedU, U_TEXT_TOKENS, DEFAULT_CTP), uOriginalChars: cleanedU.length };
}
function buildSearchTerms({ uText, note, turn }) {
  const bigrams = cjkBigrams(`${uText}
${note ?? ""}`);
  const keys = /* @__PURE__ */ new Set();
  for (const line of turn.lines) {
    if (line.kind !== "tool") continue;
    if (line.tool.resourceKey) keys.add(line.tool.resourceKey);
  }
  return [bigrams, ...keys].filter(Boolean).join(" ");
}
function projectTurnRecord(row, ordinals) {
  const t = ordinals ? ordinals.get(row.anchorUuid) ?? null : null;
  const suffix = row.uOriginalChars > row.uText.length ? truncationMarker(row.uOriginalChars) : "";
  const out2 = { t, u: row.uText + suffix };
  if (row.note != null) out2.note = row.note;
  return out2;
}
function activePathOrdinals(turns) {
  const map = /* @__PURE__ */ new Map();
  for (const turn of turns) {
    if (turn.sourceEntryId && !map.has(turn.sourceEntryId)) map.set(turn.sourceEntryId, turn.sourceOrdinal);
  }
  return map;
}

// lib/turn-note.js
function captureCurrentEpochTurns({ observations, dialogueProjection }) {
  let boundaryAt = -1;
  for (let i2 = 0; i2 < observations.length; i2++) {
    if (observations[i2].type === "epoch-boundary") boundaryAt = i2;
  }
  const { folds } = dialogueProjection.project(observations.slice(boundaryAt + 1));
  const turns = dialogueProjection.groupTurns(enumerateDialogueLines(folds));
  return { turns: turns.slice(0, -1) };
}
function captureIsPersistable(turns) {
  const seen = /* @__PURE__ */ new Set();
  for (const turn of turns) {
    if (!turn.sourceEntryId || turn.timestamp == null) return false;
    if (seen.has(turn.sourceEntryId)) return false;
    seen.add(turn.sourceEntryId);
  }
  return true;
}
function collectNoteIssues({ turns, sections, storedNotes }) {
  const covered = new Set(turns.filter((turn) => storedNotes.has(turn.sourceEntryId)).map((turn) => String(turn.sourceOrdinal)));
  const issues = [];
  for (const key of slotKeysOf(turns)) {
    const note = sections.get(key);
    if (!note) {
      if (!covered.has(key)) issues.push({ t: Number(key), message: "missing note for this NOTE slot" });
      continue;
    }
    if (Math.round(charsToTokens(note, DEFAULT_CTP)) > NOTE_TOKEN_LIMIT) {
      issues.push({ t: Number(key), message: `note exceeds ${NOTE_TOKEN_LIMIT} tokens` });
    }
  }
  return issues;
}
function buildTurnNoteRows({ turns, sections, storedNotes, sessionId }) {
  return turns.map((turn) => {
    const { uText, uOriginalChars } = storedUText(turn.cleanedU);
    const note = sections.get(String(turn.sourceOrdinal)) || storedNotes.get(turn.sourceEntryId) || null;
    return {
      sourceSessionId: sessionId,
      anchorUuid: turn.sourceEntryId,
      uText,
      uOriginalChars,
      note,
      searchTerms: buildSearchTerms({ uText, note, turn }),
      sourceTimestamp: turn.timestamp
    };
  });
}

// lib/session-watcher.js
var DIAGNOSTIC_SCOPE = "session-watcher";
function invariant(ok, message) {
  if (!ok) throw new Error(`session watcher invariant: ${message}`);
}
function diagnostic(code, message) {
  return { scope: DIAGNOSTIC_SCOPE, code, message };
}
function safeSegment(value) {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || /[/\\\0]/.test(text) || text.includes("..")) return "__invalid_session__";
  return text;
}
function readPolicy(modelPolicyFor2, modelId) {
  let raw = null;
  try {
    raw = modelPolicyFor2(modelId);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const { ctp } = raw;
  if (ctp === null || typeof ctp !== "object") return null;
  for (const key of ["ascii", "cjk", "version"]) {
    if (!(typeof ctp[key] === "number" && Number.isFinite(ctp[key]))) return null;
  }
  return raw;
}
var RESIDUAL_FAMILIES = /* @__PURE__ */ new Set(["bash", "mcp", "agent", "tool"]);
var SessionWatcher = class {
  constructor({
    sessionId = null,
    sourceLocator = null,
    projectId = null,
    projectRoot = null,
    turnNotesRoot,
    resourcePolicy,
    resourceEnrichment,
    handoffComposition,
    loaderVersion,
    store,
    dialogueSource,
    dialogueProjection,
    createEngine,
    createMeasurementProjection: createMeasurementProjection2,
    modelPolicyFor: modelPolicyFor2,
    now = () => Date.now()
  } = {}) {
    invariant(store !== null && typeof store === "object", "store is required");
    invariant(dialogueProjection !== null && typeof dialogueProjection === "object", "dialogueProjection is required");
    invariant(
      dialogueSource !== null && typeof dialogueSource === "object" && typeof dialogueSource.read === "function",
      "dialogueSource is required and exposes read"
    );
    invariant(
      resourcePolicy !== null && typeof resourcePolicy === "object" && typeof resourcePolicy.resolve === "function" && typeof resourcePolicy.infer === "function",
      "resourcePolicy is required and exposes resolve and infer"
    );
    invariant(resourceEnrichment !== null && typeof resourceEnrichment === "object", "resourceEnrichment is required");
    invariant(handoffComposition !== null && typeof handoffComposition === "object", "handoffComposition is required");
    invariant(typeof loaderVersion === "string" && loaderVersion.length > 0, "loaderVersion is required");
    invariant(typeof turnNotesRoot === "string" && turnNotesRoot.length > 0, "turnNotesRoot is required and has no fallback");
    invariant(typeof createEngine === "function", "createEngine must be a function");
    invariant(typeof createMeasurementProjection2 === "function", "createMeasurementProjection must be a function");
    invariant(typeof modelPolicyFor2 === "function", "modelPolicyFor must be a function");
    invariant(typeof now === "function", "now must be a function");
    this._projectId = projectId;
    this._projectRoot = projectRoot;
    this._turnNotesRoot = turnNotesRoot;
    this._loaderVersion = loaderVersion;
    this._store = store;
    this._dialogueSource = dialogueSource;
    this._dialogueProjection = dialogueProjection;
    this._policy = resourcePolicy;
    this._enrichment = resourceEnrichment;
    this._handoff = handoffComposition;
    this._createEngine = createEngine;
    this._createProjection = createMeasurementProjection2;
    this._modelPolicyFor = modelPolicyFor2;
    this._now = now;
    this._startMs = now();
    this._sessionId = sessionId;
    this._sourceLocator = sourceLocator;
    this._ratioOverride = null;
    this._hasObservedSource = false;
    this._streamRevision = 0;
    this._pendingNewResourceKeys = /* @__PURE__ */ new Set();
    this._applying = false;
    this._liveMark = false;
    this._resolveModelPolicy = (modelId) => {
      let policy = readPolicy(this._modelPolicyFor, modelId);
      if (policy === null) policy = readPolicy(this._modelPolicyFor, null) ?? this._modelPolicyFor(null);
      if (this._ratioOverride == null) return policy;
      return { ...policy, cRatio: this._ratioOverride };
    };
    this._resolveResourcePolicy = (resourceKey) => this._policy.resolve(resourceKey);
    this._engine = this._createEngine({
      resolveModelPolicy: this._resolveModelPolicy,
      resolveResourcePolicy: this._resolveResourcePolicy
    });
    this._projection = this._createProjection(this._sourceLocator, this._resolveModelPolicy);
  }
  // ── Frame application ──────────────────────────────────────────────────────
  /**
   * Apply one HarnessFrame. The only source-state mutation Interface.
   *
   * @param {{ transition: 'append'|'replace'|'rotate', batches: object[][], sourceObserved: boolean,
   *           captureMode: 'live'|'replay', sourceLocator?: *, sessionId?: string }} frame
   * @returns {{ changed: boolean, diagnostics: object[] }}
   */
  applyHarnessFrame(frame) {
    invariant(frame !== null && typeof frame === "object", "frame must be an object");
    invariant(this._applying === false, "reentrant applyHarnessFrame is not supported");
    this._applying = true;
    try {
      const diagnostics = [];
      const captureMode = frame.captureMode === "replay" ? "replay" : "live";
      let runtimeReplaced = false;
      if (frame.transition === "replace") {
        this._installFreshRuntime(frame.sourceLocator);
        runtimeReplaced = true;
        this._hasObservedSource = this._hasObservedSource || frame.sourceObserved === true;
        this._streamRevision += 1;
      } else if (frame.transition === "rotate") {
        this._rotate(frame, captureMode, diagnostics);
        this._hasObservedSource = frame.sourceObserved === true;
        this._streamRevision += 1;
      } else {
        invariant(frame.transition === "append", `unsupported frame transition: ${String(frame.transition)}`);
        const observedBefore = this._hasObservedSource;
        this._hasObservedSource = observedBefore || frame.sourceObserved === true;
        if (!observedBefore && this._hasObservedSource) this._streamRevision += 1;
      }
      let newCalls = 0;
      let revisedCalls = 0;
      for (const batch of frame.batches ?? []) {
        for (const observation of batch) {
          const projected = this._projection.project(observation);
          for (const entry of projected.diagnostics) diagnostics.push(entry);
          for (const record of projected.records) {
            if (record.type === "epoch") this._flushResourcePolicy(diagnostics);
            const result = this._engine.ingest([record]);
            for (const entry of result.diagnostics) diagnostics.push(entry);
            newCalls += result.newCalls;
            revisedCalls += result.revisedCalls;
            for (const key of result.newResourceKeys) this._pendingNewResourceKeys.add(key);
            if (record.type === "epoch") this._consumeClosedSegment(result, captureMode, diagnostics);
          }
        }
      }
      this._flushResourcePolicy(diagnostics);
      if (captureMode === "live") this._liveMark = true;
      return { changed: newCalls > 0 || revisedCalls > 0 || runtimeReplaced, diagnostics };
    } finally {
      this._applying = false;
    }
  }
  /**
   * Close the current segment as a terminal application operation. It is not a Source transition and
   * synthesizes no epoch record. The segment archives as `live` when a live frame has completed since the
   * segment opened, where a `replace` counts as opening a segment, and as `replay` otherwise.
   *
   * @returns {{ diagnostics: object[] }}
   */
  closeCurrentSegment() {
    const captureMode = this._liveMark ? "live" : "replay";
    const diagnostics = [];
    this._flushResourcePolicy(diagnostics);
    const result = this._engine.closeCurrentSegment();
    for (const entry of result.diagnostics) diagnostics.push(entry);
    this._consumeClosedSegment(result, captureMode, diagnostics);
    return { diagnostics };
  }
  _installFreshRuntime(sourceLocator) {
    this._pendingNewResourceKeys = /* @__PURE__ */ new Set();
    this._liveMark = false;
    this._sourceLocator = sourceLocator ?? null;
    this._engine = this._createEngine({
      resolveModelPolicy: this._resolveModelPolicy,
      resolveResourcePolicy: this._resolveResourcePolicy
    });
    this._projection = this._createProjection(this._sourceLocator, this._resolveModelPolicy);
  }
  // The candidate Projection is bound to the new locator BEFORE the old segment closes, so the closing
  // segment's telemetry is joined by the Projection that collected it while the replacement already exists.
  // A blocking finalization failure discards the candidate and leaves the old identity and runtime intact.
  _rotate(frame, captureMode, diagnostics) {
    const candidate = this._createProjection(frame.sourceLocator ?? null, this._resolveModelPolicy);
    this._flushResourcePolicy(diagnostics);
    const result = this._engine.closeCurrentSegment();
    for (const entry of result.diagnostics) diagnostics.push(entry);
    this._consumeClosedSegment(result, captureMode, diagnostics);
    this._projection = candidate;
    this._sessionId = frame.sessionId ?? this._sessionId;
    this._sourceLocator = frame.sourceLocator ?? null;
  }
  // The one closed-segment consumer behind a successful epoch, a rotate and an explicit close.
  _consumeClosedSegment(result, captureMode, diagnostics) {
    this._liveMark = false;
    const closedSegment = result.closedSegments[0] ?? null;
    const finished = this._projection.finishSegment(closedSegment, { captureMode });
    for (const entry of finished.diagnostics) diagnostics.push(entry);
    if (closedSegment == null) return;
    if (!this._sessionId) return;
    const archivedAt = captureMode === "replay" ? lastValidStepTimestamp(closedSegment) ?? this._now() : this._now();
    const snapshot = {
      ...closedSegment.metrics,
      model: closedSegment.epochModel,
      projectId: this._projectId,
      archiveSource: captureMode,
      archivedAt
    };
    let profile;
    try {
      profile = this._store.archiveSegmentProfile(this._sessionId, closedSegment.segment, snapshot, closedSegment.paths);
    } catch (error) {
      diagnostics.push(diagnostic(
        "segment_profile_persist_failed",
        `segment ${closedSegment.segment} profile persistence failed: ${error.message}`
      ));
      return;
    }
    if (profile?.status !== "archived" && profile?.status !== "already_archived") return;
    if (!finished.artifact) return;
    try {
      const telemetry = this._store.archiveSegmentTelemetry(this._sessionId, closedSegment.segment, finished.artifact);
      if (telemetry?.status === "failed_retryable") {
        diagnostics.push(diagnostic(
          "segment_telemetry_persist_failed",
          `segment ${closedSegment.segment} telemetry persistence is retryable`
        ));
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        "segment_telemetry_persist_failed",
        `segment ${closedSegment.segment} telemetry persistence failed: ${error.message}`
      ));
    }
  }
  // ── Resource-policy flush ──────────────────────────────────────────────────
  // One complete resource snapshot per flush, taken while the epoch that created the pending keys is still
  // open. Baseline inference read the resident set once per newly created path, which made a batch of
  // siblings order-dependent against itself; one snapshot per flush is what the approved delta names.
  _flushResourcePolicy(diagnostics) {
    if (this._pendingNewResourceKeys.size === 0) return;
    const pendingKeys = [...this._pendingNewResourceKeys];
    const bucket = this._engine.getBucketData();
    const resourceKeys = [];
    const overrides = {};
    for (const row of bucket.paths) {
      resourceKeys.push(row.path);
      if (row.userOverride) overrides[row.path] = row.userOverride;
    }
    const inferred = this._policy.infer({ newResourceKeys: pendingKeys, resourceKeys, overrides });
    const merged = { ...overrides, ...inferred };
    const replaced = this._engine.replaceResourceOverrides(merged);
    for (const entry of replaced.diagnostics ?? []) diagnostics.push(entry);
    if (replaced.warnings?.length > 0) {
      diagnostics.push(diagnostic(
        "resource_override_merge_warned",
        `${replaced.warnings.length} inferred resource override entries were not applied`
      ));
    }
    this._enrichment.warm(pendingKeys);
    this._pendingNewResourceKeys = /* @__PURE__ */ new Set();
  }
  // ── Named reads ────────────────────────────────────────────────────────────
  // The C ratio a read reports. The Engine holds no epoch policy until the epoch's first measured step, so
  // it answers null until then; a read model resolves a policy for the model it is displaying, which is what
  // makes the ratio finite from the first poll and a runtime override visible before any step has landed.
  // The effective resolver already substitutes the override's ratio, so one call covers both. It fires ONLY
  // on a null, so a resolved epoch policy is never masked.
  _readCRatio(engineCRatio, modelId) {
    if (engineCRatio != null) return engineCRatio;
    return this._resolveModelPolicy(modelId ?? "").cRatio;
  }
  getStatus() {
    const status = this._engine.getStatus();
    const rateLamp = status.rateLamp.reliable ? status.rateLamp : {
      ...status.rateLamp,
      unavailableReason: status.apiCalls === 0 && !this._hasObservedSource ? "no_transcript" : "insufficient_data"
    };
    return {
      L: status.L,
      B: status.B,
      bDefault: status.bDefault,
      g: status.g,
      x: status.x,
      dhat: status.dhat,
      xSweet: status.xSweet,
      u: status.u,
      pp: status.pp,
      mf: status.mf,
      br: status.br,
      // The displayed model identity is the latest measured step's, while every policy value the reads
      // derive comes from the epoch model.
      model: status.latestMeasuredModel ?? "",
      cRatio: this._readCRatio(status.cRatio, status.latestMeasuredModel),
      segment: status.segment,
      apiCalls: status.apiCalls,
      uptime: Math.floor((this._now() - this._startMs) / 1e3),
      rateLamp,
      sourceLocator: this._sourceLocator
    };
  }
  getHistory() {
    return this._engine.getHistory().map((point) => ({
      // The Engine holds normalized integers so nothing but a number crosses the Harness seam; the retained
      // wire form is the source's own ISO text, which round-trips through this conversion.
      ts: point.ts == null ? null : new Date(point.ts).toISOString(),
      segment: point.segment,
      L: point.L,
      B: point.B,
      g: point.g,
      bDefault: point.bDefault,
      u: point.u,
      pp: point.pp,
      miss: point.miss,
      cacheRead: point.cacheRead,
      cacheCreation: point.cacheWrite,
      turnSeq: point.turnSeq,
      foldedSeq: point.foldedSeq
    }));
  }
  // The only bucket/resource query. It reads the Engine first, then passes only default-selected file rows
  // to Resource Enrichment — a row the position basis excludes buys no symbols, and a Skill has no file.
  getBucketData({ includeSymbols = false } = {}) {
    const bucket = this._engine.getBucketData();
    const skills = [];
    const paths = [];
    for (const row of bucket.paths) {
      const { path: path3, lineNumbers, fullSnapshot, ...common } = row;
      if (path3.startsWith(SKILL_RESOURCE_PREFIX)) {
        skills.push({ name: path3.slice(SKILL_RESOURCE_PREFIX.length), ...common });
        continue;
      }
      const entry = { path: path3, ...common };
      if (includeSymbols && row.defaultSelected) {
        const activeSymbols = this._enrichment.activeSymbols({ path: path3, lineNumbers, fullSnapshot });
        if (activeSymbols) entry.activeSymbols = activeSymbols;
      }
      paths.push(entry);
    }
    const residual = { bash: [], mcp: [], agent: [], tool: [] };
    for (const group of bucket.residual) {
      const family = group.meta?.kind;
      if (!RESIDUAL_FAMILIES.has(family)) continue;
      const tokens = Math.round(group.tokens);
      if (tokens <= 0) continue;
      const common = { tokens, count: group.count, lastTurn: group.lastTurn, lastCallSeq: group.lastCallSeq, touchSeqs: group.touchSeqs };
      if (family === "mcp") residual.mcp.push({ tool: group.groupKey, ...common });
      else residual[family].push({ name: group.groupKey, detail: group.meta.detail || "", ...common });
    }
    for (const family of Object.keys(residual)) residual[family].sort((a, b) => b.tokens - a.tokens);
    return {
      dead: bucket.dead,
      skills,
      paths,
      residual,
      totalB: bucket.totalB,
      totalL: bucket.totalL,
      bDefault: bucket.bDefault,
      totalResidualRaw: bucket.totalResidualRaw,
      totalResidual: bucket.totalResidual,
      currentTurnSeq: bucket.currentTurnSeq,
      segment: bucket.segment
    };
  }
  // The value host wiring persists unchanged as `profile_snapshot`. `b_total` is the UNCAPPED resident total:
  // the read-time cap belongs to the live dashboard, while persistence needs the belief its own path rows sum
  // into, or `dead + Σ paths` would exceed the total it is stored beside.
  getTerminalSnapshot() {
    const status = this._engine.getStatus();
    const bucket = this._engine.getBucketData();
    const paths = bucket.paths.map(({ path: path3, tokens }) => ({ path: path3, tokens }));
    let bTotal = bucket.dead;
    for (const { tokens } of paths) bTotal += tokens;
    return {
      b_total: bTotal,
      g_final: status.g,
      l_peak: status.L,
      c_ratio: this._readCRatio(status.cRatio, status.latestMeasuredModel),
      turns: status.turnSeq,
      mf: status.mf,
      br_exit: status.br,
      paths,
      model: status.latestMeasuredModel ?? "",
      segment: status.segment
    };
  }
  getCurrentModel() {
    return this._engine.getStatus().latestMeasuredModel;
  }
  // The EPOCH model: the first measured step's model in the current epoch, which is what every
  // model-DEPENDENT value resolves its policy from. Distinct from `getCurrentModel()`, the latest measured
  // step's identity, which is what a status display shows. The two genuinely differ within one epoch, and a
  // consumer that keys persistent state on the model needs this one — keying on the latest identity would
  // move the key mid-epoch. Deliberately NOT a member of `getStatus()`: that result's shape is compared
  // key-for-key, so widening it would itself be a wire change.
  getEpochModel() {
    return this._engine.getStatus().model;
  }
  getCurrentCtp() {
    return this._resolveModelPolicy(this.getCurrentModel()).ctp;
  }
  readRateLampFrame(sinceFoldedSeq) {
    return { ...this._engine.readRateLampFrame(sinceFoldedSeq), streamRevision: this._streamRevision };
  }
  replaceUserOverrides(entries) {
    return this._engine.replaceResourceOverrides(entries);
  }
  // The same fold under a CANDIDATE override set. It validates through the same parse Apply does and mutates
  // nothing, so the position a consumer previews is the position the Apply it may follow with then reads.
  readScenario(overrides) {
    return this._engine.readScenario(overrides);
  }
  // The runtime ratio override. It moves the policy signature, so the Engine re-stamps every step of the
  // open segment under the new price. It recomputes no closed segment's extremum, leaves the Rate Lamp
  // ledger's integral as it stands and does not move `streamRevision`, so the ledger keeps what it already
  // integrated and the re-stamped increments reach it with the frames drained after the change. The Engine
  // finalizer freezes the effective close-time ratio in the closed segment.
  setRatioOverride(value) {
    this._ratioOverride = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    return this._engine.refreshReadPolicies();
  }
  // The resolver's inputs changed outside the watcher, so the Engine re-reads them; no override value moves.
  refreshReadPolicies() {
    return this._engine.refreshReadPolicies();
  }
  // ── Handoff operations ─────────────────────────────────────────────────────
  prepareHandoff({ pathsToKeep, skillsToKeep, summary, nextTask, observedSegment, loadToken } = {}) {
    const engineMeasurement = this._engine.getHandoffMeasurement();
    const measurement = {
      ...engineMeasurement,
      measurement: {
        ...engineMeasurement.measurement,
        cRatio: this._readCRatio(engineMeasurement.measurement.cRatio, engineMeasurement.epochModel)
      }
    };
    if (typeof observedSegment === "number" && observedSegment !== measurement.segment) {
      return {
        status: "error",
        error: "stale_bucket_summary",
        instruction: "Call get_bucket_summary again before preparing handoff."
      };
    }
    const hasToken = typeof loadToken === "string" && loadToken.length > 0;
    const stored = hasToken ? this._store.getHandoffByToken(loadToken) : null;
    if (hasToken && !stored) {
      return {
        status: "error",
        error: "token_not_found",
        instruction: "The provided load_token does not exist. Omit it to create a new handoff."
      };
    }
    const filePaths = measurement.paths.filter((row2) => !row2.path.startsWith(SKILL_RESOURCE_PREFIX));
    const request = {
      input: { pathsToKeep, skillsToKeep, summary, nextTask },
      measurement,
      filePaths,
      ctp: this._resolveModelPolicy(measurement.epochModel).ctp,
      projectRoot: this._projectRoot,
      symbolRangesFor: (symbolRequest) => this._enrichment.symbolRanges(symbolRequest),
      // The kept scenario: every file resource the handoff keeps is carried, every other one is left out
      // as excess. Skills keep their default selection — the kept-token total counts files alone.
      rateForKept: (keptKeys) => {
        const kept = new Set(keptKeys);
        const overrides = {};
        for (const row2 of filePaths) overrides[row2.path] = kept.has(row2.path) ? "include" : "exclude";
        const scenario = this._engine.readScenario(overrides);
        return scenario.reliable ? scenario.gBar : 0;
      }
    };
    if (stored && stored.deliveredAt == null) {
      const patch = this._handoff.composePatched({ ...request, stored, transcriptPath: this._sourceLocator ?? null });
      if (patch.status === "error") return patch;
      if (this._store.updateHandoff(loadToken, patch.row)) return this._readyReply(loadToken, patch);
    }
    const composed = this._handoff.composePrepared(request);
    if (composed.status === "error") return composed;
    const row = {
      ...composed.row,
      sessionId: this._sessionId,
      segment: measurement.segment,
      projectId: this._projectId || null,
      transcriptPath: this._sourceLocator ?? null
    };
    const written = this._writeHandoffRow(row, composed);
    if (written.status === "error") return written;
    return this._readyReply(written.loadToken, composed);
  }
  _readyReply(loadToken, composed) {
    const out2 = { status: "ready", load_token: loadToken, ...composed.response };
    if (composed.patched) out2.patched = composed.patched;
    out2.instruction = this._handoff.instructionFor(loadToken);
    if (composed.resolvedPaths.length > 0) out2.resolved_paths = composed.resolvedPaths;
    return out2;
  }
  // Always an insert under a freshly minted token: a patch is `updateHandoff`'s, and a delivered row has
  // immutable telemetry, so it is never rewritten at a different instant than its recorded delivery.
  _writeHandoffRow(row, composed) {
    for (const candidate of this._handoff.candidateTokens(composed.tokenSeed)) {
      try {
        this._store.insertHandoff({ ...row, loadToken: candidate, createdAt: this._handoff.createdAt() });
        return { loadToken: candidate };
      } catch (error) {
        if (error.errcode !== 2067) throw error;
      }
    }
    return { status: "error", error: "token_collision" };
  }
  searchHandoffs({ query, queryMode } = {}) {
    if (!this._store.ftsAvailable) return { status: "error", error: "search_unavailable" };
    let results;
    try {
      results = this._store.searchHandoff(this._handoff.searchExpression(query, queryMode), { projectId: this._projectId });
    } catch {
      return { status: "error", error: "invalid_query" };
    }
    return this._handoff.searchResponse(results);
  }
  // One session, segment and project captured at entry: the response is composed after the delivery
  // transaction commits, and it must describe the consumer that actually claimed the row.
  async deliverHandoff({ loadToken } = {}) {
    const sessionId = this._sessionId;
    const projectId = this._projectId;
    const consumerSegment = this._engine.getStatus().segment;
    let token = loadToken;
    if (typeof token !== "string" || token.length === 0) {
      if (!projectId) return { found: false };
      const pending = this._store.findPendingHandoffsByProject(projectId, sessionId, {
        ttlMs: HANDOFF_HOOK_TTL_DAYS * 24 * 3600 * 1e3
      });
      if (pending.status === "none") return { found: false };
      if (pending.status === "ambiguous") return this._handoff.ambiguityResponse(pending.rows);
      token = pending.row.loadToken;
    }
    const delivered = this._store.deliverHandoffByToken(token, {
      sessionId,
      loaderVersion: this._loaderVersion,
      consumerSegment
    });
    if (!delivered) return { found: false };
    if (delivered.ok === false) return delivered;
    this._stampLoadHashes(delivered, sessionId);
    return this._handoff.projectDelivered(delivered, {
      resolveSymbols: (request) => this._enrichment.resolveSymbols(request)
    });
  }
  // Re-hash each kept path on THIS machine so a consumer can tell a carried file that moved from one that
  // did not. Only the bound primary stamps, so a duplicate consumer can never clobber the primary's record,
  // and a failure is a display loss rather than a delivery one.
  _stampLoadHashes(delivered, sessionId) {
    const isBoundPrimary = delivered.deliveredSessionId != null && delivered.deliveredSessionId === sessionId;
    if (!delivered.claimedNow && !isBoundPrimary) return;
    try {
      const stamped = this._handoff.stampLoadHashes(delivered, {
        projectRoot: this._projectRoot,
        force: delivered.claimedNow === true
      });
      if (stamped) this._store.stampContentHashLoad(delivered.handoffId, stamped);
    } catch (error) {
      if (process.env.SW_DEBUG) console.error("[content_hash_load]", error.message);
    }
  }
  // ── Turn Notes ─────────────────────────────────────────────────────────────
  // One capture behind both entry points, so the skeleton and the submission can never see different Turns.
  // The read status travels with it: an unavailable Source has an empty capture, which is otherwise
  // indistinguishable from a genuinely empty epoch whose submission would commit nothing.
  async _captureTurns() {
    const read = await this._dialogueSource.read(this._sourceLocator);
    if (read.status !== "ok") return { status: read.status, turns: [] };
    return { status: "ok", ...captureCurrentEpochTurns({ observations: read.observations, dialogueProjection: this._dialogueProjection }) };
  }
  // The two files' one address, derived here and nowhere else. The key is the Context Epoch — this session
  // plus the epoch's first anchor — so a re-fetch after the epoch grew still finds the notes already
  // written, where a content fingerprint would rename the file on every new Turn.
  _turnNotePaths(turns) {
    const dir = join3(
      this._turnNotesRoot,
      `${safeSegment(this._sessionId)}-${safeSegment(turns[0]?.sourceEntryId ?? "empty")}`
    );
    return { dir, skeletonPath: join3(dir, "skeleton.txt"), notesPath: join3(dir, "notes.md") };
  }
  // This session's Turn Records by anchor. The Store is the durable copy of a committed epoch's notes: the
  // notes file is retired the moment those rows land, while the next handoff in the same session keeps the
  // epoch key and therefore lands on that same, now absent, path.
  _storedNotes() {
    return new Map(this._store.listTurnNotes(this._sessionId).map((row) => [row.anchorUuid, row.note]));
  }
  async getTurnSkeleton() {
    const { status, turns } = await this._captureTurns();
    if (status !== "ok") throw new Error("transcript is not readable; no turn skeleton can be captured");
    if (!captureIsPersistable(turns)) {
      throw new Error("captured turn heads carry no persistable identity; no turn skeleton can be captured");
    }
    const { dir, skeletonPath, notesPath } = this._turnNotePaths(turns);
    mkdirSync2(dir, { recursive: true });
    let existing = null;
    try {
      existing = readFileSync2(notesPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`turn notes file cannot be read: ${notesPath}`);
    }
    const stored = this._storedNotes();
    writeFileSync(skeletonPath, buildSkeleton(turns, this._sessionId));
    const slots = slotKeysOf(turns);
    const { sections } = parseNoteSections(existing, slots);
    const missing = slots.filter((key) => !sections.has(key));
    const prefill = new Map(turns.filter((turn) => stored.get(turn.sourceEntryId)).map((turn) => [String(turn.sourceOrdinal), stored.get(turn.sourceEntryId)]));
    if (existing == null) writeFileSync(notesPath, renderNoteSections(missing, prefill));
    else if (missing.length > 0) {
      appendFileSync(notesPath, `${existing.endsWith("\n") ? "" : "\n"}
${renderNoteSections(missing, prefill)}`);
    }
    return {
      snapshot_id: snapshotDigest(turns),
      skeleton_path: skeletonPath,
      notes_path: notesPath,
      protocol: TURN_NOTE_PROTOCOL
    };
  }
  async submitTurnNotes({ snapshot_id: snapshotId } = {}) {
    const { status, turns } = await this._captureTurns();
    if (status !== "ok") return { committed: false, error: "invalid_snapshot" };
    if (snapshotDigest(turns) !== snapshotId) return { committed: false, error: "stale_snapshot" };
    if (!captureIsPersistable(turns)) return { committed: false, error: "invalid_snapshot" };
    const slots = slotKeysOf(turns);
    const { dir, notesPath } = this._turnNotePaths(turns);
    let raw = null;
    try {
      raw = readFileSync2(notesPath, "utf8");
    } catch {
    }
    const { sections, issues } = parseNoteSections(raw, slots);
    let stored;
    try {
      stored = this._storedNotes();
    } catch (error) {
      if (process.env.SW_DEBUG) console.error("[turn-note-read]", error?.message || error);
      return { committed: false, error: "storage_unavailable", retryable: true };
    }
    issues.push(...collectNoteIssues({ turns, sections, storedNotes: stored }));
    if (issues.length > 0) return { committed: false, error: "invalid_notes", issues };
    const rows = buildTurnNoteRows({ turns, sections, storedNotes: stored, sessionId: this._sessionId });
    try {
      this._store.upsertTurnNotes(rows);
    } catch (error) {
      if (process.env.SW_DEBUG) console.error("[turn-note-write]", error?.message || error);
      return { committed: false, error: "storage_unavailable", retryable: true };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.env.SW_DEBUG) console.error("[turn-note-cleanup]", error?.message || error);
    }
    return { committed: true };
  }
};
function lastValidStepTimestamp(closedSegment) {
  for (let i2 = closedSegment.steps.length - 1; i2 >= 0; i2--) {
    const timestamp = closedSegment.steps[i2].timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

// lib/resource-enrichment.js
import { extname, isAbsolute as isAbsolute2, join as join5 } from "node:path";
import { readFileSync as readFileSync4 } from "node:fs";

// node_modules/web-tree-sitter/web-tree-sitter.js
var __defProp2 = Object.defineProperty;
var __name = (target, value) => __defProp2(target, "name", { value, configurable: true });
var Edit = class {
  static {
    __name(this, "Edit");
  }
  /** The start position of the change. */
  startPosition;
  /** The end position of the change before the edit. */
  oldEndPosition;
  /** The end position of the change after the edit. */
  newEndPosition;
  /** The start index of the change. */
  startIndex;
  /** The end index of the change before the edit. */
  oldEndIndex;
  /** The end index of the change after the edit. */
  newEndIndex;
  constructor({
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition,
    oldEndPosition,
    newEndPosition
  }) {
    this.startIndex = startIndex >>> 0;
    this.oldEndIndex = oldEndIndex >>> 0;
    this.newEndIndex = newEndIndex >>> 0;
    this.startPosition = startPosition;
    this.oldEndPosition = oldEndPosition;
    this.newEndPosition = newEndPosition;
  }
  /**
   * Edit a point and index to keep it in-sync with source code that has been edited.
   *
   * This function updates a single point's byte offset and row/column position
   * based on an edit operation. This is useful for editing points without
   * requiring a tree or node instance.
   */
  editPoint(point, index) {
    let newIndex = index;
    const newPoint = { ...point };
    if (index >= this.oldEndIndex) {
      newIndex = this.newEndIndex + (index - this.oldEndIndex);
      const originalRow = point.row;
      newPoint.row = this.newEndPosition.row + (point.row - this.oldEndPosition.row);
      newPoint.column = originalRow === this.oldEndPosition.row ? this.newEndPosition.column + (point.column - this.oldEndPosition.column) : point.column;
    } else if (index > this.startIndex) {
      newIndex = this.newEndIndex;
      newPoint.row = this.newEndPosition.row;
      newPoint.column = this.newEndPosition.column;
    }
    return { point: newPoint, index: newIndex };
  }
  /**
   * Edit a range to keep it in-sync with source code that has been edited.
   *
   * This function updates a range's start and end positions based on an edit
   * operation. This is useful for editing ranges without requiring a tree
   * or node instance.
   */
  editRange(range) {
    const newRange = {
      startIndex: range.startIndex,
      startPosition: { ...range.startPosition },
      endIndex: range.endIndex,
      endPosition: { ...range.endPosition }
    };
    if (range.endIndex >= this.oldEndIndex) {
      if (range.endIndex !== Number.MAX_SAFE_INTEGER) {
        newRange.endIndex = this.newEndIndex + (range.endIndex - this.oldEndIndex);
        newRange.endPosition = {
          row: this.newEndPosition.row + (range.endPosition.row - this.oldEndPosition.row),
          column: range.endPosition.row === this.oldEndPosition.row ? this.newEndPosition.column + (range.endPosition.column - this.oldEndPosition.column) : range.endPosition.column
        };
        if (newRange.endIndex < this.newEndIndex) {
          newRange.endIndex = Number.MAX_SAFE_INTEGER;
          newRange.endPosition = { row: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
        }
      }
    } else if (range.endIndex > this.startIndex) {
      newRange.endIndex = this.startIndex;
      newRange.endPosition = { ...this.startPosition };
    }
    if (range.startIndex >= this.oldEndIndex) {
      newRange.startIndex = this.newEndIndex + (range.startIndex - this.oldEndIndex);
      newRange.startPosition = {
        row: this.newEndPosition.row + (range.startPosition.row - this.oldEndPosition.row),
        column: range.startPosition.row === this.oldEndPosition.row ? this.newEndPosition.column + (range.startPosition.column - this.oldEndPosition.column) : range.startPosition.column
      };
      if (newRange.startIndex < this.newEndIndex) {
        newRange.startIndex = Number.MAX_SAFE_INTEGER;
        newRange.startPosition = { row: Number.MAX_SAFE_INTEGER, column: Number.MAX_SAFE_INTEGER };
      }
    } else if (range.startIndex > this.startIndex) {
      newRange.startIndex = this.startIndex;
      newRange.startPosition = { ...this.startPosition };
    }
    return newRange;
  }
};
var SIZE_OF_SHORT = 2;
var SIZE_OF_INT = 4;
var SIZE_OF_CURSOR = 4 * SIZE_OF_INT;
var SIZE_OF_NODE = 5 * SIZE_OF_INT;
var SIZE_OF_POINT = 2 * SIZE_OF_INT;
var SIZE_OF_RANGE = 2 * SIZE_OF_INT + 2 * SIZE_OF_POINT;
var ZERO_POINT = { row: 0, column: 0 };
var INTERNAL = /* @__PURE__ */ Symbol("INTERNAL");
function assertInternal(x) {
  if (x !== INTERNAL) throw new Error("Illegal constructor");
}
__name(assertInternal, "assertInternal");
function isPoint(point) {
  return !!point && typeof point.row === "number" && typeof point.column === "number";
}
__name(isPoint, "isPoint");
function setModule(module2) {
  C = module2;
}
__name(setModule, "setModule");
var C;
var LookaheadIterator = class {
  static {
    __name(this, "LookaheadIterator");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  language;
  /** @internal */
  constructor(internal, address, language) {
    assertInternal(internal);
    this[0] = address;
    this.language = language;
  }
  /** Get the current symbol of the lookahead iterator. */
  get currentTypeId() {
    return C._ts_lookahead_iterator_current_symbol(this[0]);
  }
  /** Get the current symbol name of the lookahead iterator. */
  get currentType() {
    return this.language.types[this.currentTypeId] || "ERROR";
  }
  /** Delete the lookahead iterator, freeing its resources. */
  delete() {
    C._ts_lookahead_iterator_delete(this[0]);
    this[0] = 0;
  }
  /**
   * Reset the lookahead iterator.
   *
   * This returns `true` if the language was set successfully and `false`
   * otherwise.
   */
  reset(language, stateId) {
    if (C._ts_lookahead_iterator_reset(this[0], language[0], stateId)) {
      this.language = language;
      return true;
    }
    return false;
  }
  /**
   * Reset the lookahead iterator to another state.
   *
   * This returns `true` if the iterator was reset to the given state and
   * `false` otherwise.
   */
  resetState(stateId) {
    return Boolean(C._ts_lookahead_iterator_reset_state(this[0], stateId));
  }
  /**
   * Returns an iterator that iterates over the symbols of the lookahead iterator.
   *
   * The iterator will yield the current symbol name as a string for each step
   * until there are no more symbols to iterate over.
   */
  [Symbol.iterator]() {
    return {
      next: /* @__PURE__ */ __name(() => {
        if (C._ts_lookahead_iterator_next(this[0])) {
          return { done: false, value: this.currentType };
        }
        return { done: true, value: "" };
      }, "next")
    };
  }
};
function getText(tree, startIndex, endIndex, startPosition) {
  const length = endIndex - startIndex;
  let result = tree.textCallback(startIndex, startPosition);
  if (result) {
    startIndex += result.length;
    while (startIndex < endIndex) {
      const string = tree.textCallback(startIndex, startPosition);
      if (string && string.length > 0) {
        startIndex += string.length;
        result += string;
      } else {
        break;
      }
    }
    if (startIndex > endIndex) {
      result = result.slice(0, length);
    }
  }
  return result ?? "";
}
__name(getText, "getText");
var Tree = class _Tree {
  static {
    __name(this, "Tree");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  textCallback;
  /** The language that was used to parse the syntax tree. */
  language;
  /** @internal */
  constructor(internal, address, language, textCallback) {
    assertInternal(internal);
    this[0] = address;
    this.language = language;
    this.textCallback = textCallback;
  }
  /** Create a shallow copy of the syntax tree. This is very fast. */
  copy() {
    const address = C._ts_tree_copy(this[0]);
    return new _Tree(INTERNAL, address, this.language, this.textCallback);
  }
  /** Delete the syntax tree, freeing its resources. */
  delete() {
    C._ts_tree_delete(this[0]);
    this[0] = 0;
  }
  /** Get the root node of the syntax tree. */
  get rootNode() {
    C._ts_tree_root_node_wasm(this[0]);
    return unmarshalNode(this);
  }
  /**
   * Get the root node of the syntax tree, but with its position shifted
   * forward by the given offset.
   */
  rootNodeWithOffset(offsetBytes, offsetExtent) {
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, offsetBytes, "i32");
    marshalPoint(address + SIZE_OF_INT, offsetExtent);
    C._ts_tree_root_node_with_offset_wasm(this[0]);
    return unmarshalNode(this);
  }
  /**
   * Edit the syntax tree to keep it in sync with source code that has been
   * edited.
   *
   * You must describe the edit both in terms of byte offsets and in terms of
   * row/column coordinates.
   */
  edit(edit) {
    marshalEdit(edit);
    C._ts_tree_edit_wasm(this[0]);
  }
  /** Create a new {@link TreeCursor} starting from the root of the tree. */
  walk() {
    return this.rootNode.walk();
  }
  /**
   * Compare this old edited syntax tree to a new syntax tree representing
   * the same document, returning a sequence of ranges whose syntactic
   * structure has changed.
   *
   * For this to work correctly, this syntax tree must have been edited such
   * that its ranges match up to the new tree. Generally, you'll want to
   * call this method right after calling one of the [`Parser::parse`]
   * functions. Call it on the old tree that was passed to parse, and
   * pass the new tree that was returned from `parse`.
   */
  getChangedRanges(other) {
    if (!(other instanceof _Tree)) {
      throw new TypeError("Argument must be a Tree");
    }
    C._ts_tree_get_changed_ranges_wasm(this[0], other[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
  /** Get the included ranges that were used to parse the syntax tree. */
  getIncludedRanges() {
    C._ts_tree_included_ranges_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
};
var TreeCursor = class _TreeCursor {
  static {
    __name(this, "TreeCursor");
  }
  /** @internal */
  // @ts-expect-error: never read
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [1] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [2] = 0;
  // Internal handle for Wasm
  /** @internal */
  // @ts-expect-error: never read
  [3] = 0;
  // Internal handle for Wasm
  /** @internal */
  tree;
  /** @internal */
  constructor(internal, tree) {
    assertInternal(internal);
    this.tree = tree;
    unmarshalTreeCursor(this);
  }
  /** Creates a deep copy of the tree cursor. This allocates new memory. */
  copy() {
    const copy = new _TreeCursor(INTERNAL, this.tree);
    C._ts_tree_cursor_copy_wasm(this.tree[0]);
    unmarshalTreeCursor(copy);
    return copy;
  }
  /** Delete the tree cursor, freeing its resources. */
  delete() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_delete_wasm(this.tree[0]);
    this[0] = this[1] = this[2] = 0;
  }
  /** Get the tree cursor's current {@link Node}. */
  get currentNode() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_current_node_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the numerical field id of this tree cursor's current node.
   *
   * See also {@link TreeCursor#currentFieldName}.
   */
  get currentFieldId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_field_id_wasm(this.tree[0]);
  }
  /** Get the field name of this tree cursor's current node. */
  get currentFieldName() {
    return this.tree.language.fields[this.currentFieldId];
  }
  /**
   * Get the depth of the cursor's current node relative to the original
   * node that the cursor was constructed with.
   */
  get currentDepth() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_depth_wasm(this.tree[0]);
  }
  /**
   * Get the index of the cursor's current node out of all of the
   * descendants of the original node that the cursor was constructed with.
   */
  get currentDescendantIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_descendant_index_wasm(this.tree[0]);
  }
  /** Get the type of the cursor's current node. */
  get nodeType() {
    return this.tree.language.types[this.nodeTypeId] || "ERROR";
  }
  /** Get the type id of the cursor's current node. */
  get nodeTypeId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_type_id_wasm(this.tree[0]);
  }
  /** Get the state id of the cursor's current node. */
  get nodeStateId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_state_id_wasm(this.tree[0]);
  }
  /** Get the id of the cursor's current node. */
  get nodeId() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_id_wasm(this.tree[0]);
  }
  /**
   * Check if the cursor's current node is *named*.
   *
   * Named nodes correspond to named rules in the grammar, whereas
   * *anonymous* nodes correspond to string literals in the grammar.
   */
  get nodeIsNamed() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_is_named_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if the cursor's current node is *missing*.
   *
   * Missing nodes are inserted by the parser in order to recover from
   * certain kinds of syntax errors.
   */
  get nodeIsMissing() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_current_node_is_missing_wasm(this.tree[0]) === 1;
  }
  /** Get the string content of the cursor's current node. */
  get nodeText() {
    marshalTreeCursor(this);
    const startIndex = C._ts_tree_cursor_start_index_wasm(this.tree[0]);
    const endIndex = C._ts_tree_cursor_end_index_wasm(this.tree[0]);
    C._ts_tree_cursor_start_position_wasm(this.tree[0]);
    const startPosition = unmarshalPoint(TRANSFER_BUFFER);
    return getText(this.tree, startIndex, endIndex, startPosition);
  }
  /** Get the start position of the cursor's current node. */
  get startPosition() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_start_position_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the end position of the cursor's current node. */
  get endPosition() {
    marshalTreeCursor(this);
    C._ts_tree_cursor_end_position_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the start index of the cursor's current node. */
  get startIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_start_index_wasm(this.tree[0]);
  }
  /** Get the end index of the cursor's current node. */
  get endIndex() {
    marshalTreeCursor(this);
    return C._ts_tree_cursor_end_index_wasm(this.tree[0]);
  }
  /**
   * Move this cursor to the first child of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there were no children.
   */
  gotoFirstChild() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the last child of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there were no children.
   *
   * Note that this function may be slower than
   * {@link TreeCursor#gotoFirstChild} because it needs to
   * iterate through all the children to compute the child's position.
   */
  gotoLastChild() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the parent of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no parent node (the cursor was already on the
   * root node).
   *
   * Note that the node the cursor was constructed with is considered the root
   * of the cursor, and the cursor cannot walk outside this node.
   */
  gotoParent() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the next sibling of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no next sibling node.
   *
   * Note that the node the cursor was constructed with is considered the root
   * of the cursor, and the cursor cannot walk outside this node.
   */
  gotoNextSibling() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the previous sibling of its current node.
   *
   * This returns `true` if the cursor successfully moved, and returns
   * `false` if there was no previous sibling node.
   *
   * Note that this function may be slower than
   * {@link TreeCursor#gotoNextSibling} due to how node
   * positions are stored. In the worst case, this will need to iterate
   * through all the children up to the previous sibling node to recalculate
   * its position. Also note that the node the cursor was constructed with is
   * considered the root of the cursor, and the cursor cannot walk outside this node.
   */
  gotoPreviousSibling() {
    marshalTreeCursor(this);
    const result = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move the cursor to the node that is the nth descendant of
   * the original node that the cursor was constructed with, where
   * zero represents the original node itself.
   */
  gotoDescendant(goalDescendantIndex) {
    marshalTreeCursor(this);
    C._ts_tree_cursor_goto_descendant_wasm(this.tree[0], goalDescendantIndex);
    unmarshalTreeCursor(this);
  }
  /**
   * Move this cursor to the first child of its current node that contains or
   * starts after the given byte offset.
   *
   * This returns `true` if the cursor successfully moved to a child node, and returns
   * `false` if no such child was found.
   */
  gotoFirstChildForIndex(goalIndex) {
    marshalTreeCursor(this);
    C.setValue(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalIndex, "i32");
    const result = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Move this cursor to the first child of its current node that contains or
   * starts after the given byte offset.
   *
   * This returns the index of the child node if one was found, and returns
   * `null` if no such child was found.
   */
  gotoFirstChildForPosition(goalPosition) {
    marshalTreeCursor(this);
    marshalPoint(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalPosition);
    const result = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
    return result === 1;
  }
  /**
   * Re-initialize this tree cursor to start at the original node that the
   * cursor was constructed with.
   */
  reset(node) {
    marshalNode(node);
    marshalTreeCursor(this, TRANSFER_BUFFER + SIZE_OF_NODE);
    C._ts_tree_cursor_reset_wasm(this.tree[0]);
    unmarshalTreeCursor(this);
  }
  /**
   * Re-initialize a tree cursor to the same position as another cursor.
   *
   * Unlike {@link TreeCursor#reset}, this will not lose parent
   * information and allows reusing already created cursors.
   */
  resetTo(cursor) {
    marshalTreeCursor(this, TRANSFER_BUFFER);
    marshalTreeCursor(cursor, TRANSFER_BUFFER + SIZE_OF_CURSOR);
    C._ts_tree_cursor_reset_to_wasm(this.tree[0], cursor.tree[0]);
    unmarshalTreeCursor(this);
  }
};
var Node = class {
  static {
    __name(this, "Node");
  }
  /** @internal */
  // @ts-expect-error: never read
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  _children;
  /** @internal */
  _namedChildren;
  /** @internal */
  constructor(internal, {
    id,
    tree,
    startIndex,
    startPosition,
    other
  }) {
    assertInternal(internal);
    this[0] = other;
    this.id = id;
    this.tree = tree;
    this.startIndex = startIndex;
    this.startPosition = startPosition;
  }
  /**
   * The numeric id for this node that is unique.
   *
   * Within a given syntax tree, no two nodes have the same id. However:
   *
   * * If a new tree is created based on an older tree, and a node from the old tree is reused in
   *   the process, then that node will have the same id in both trees.
   *
   * * A node not marked as having changes does not guarantee it was reused.
   *
   * * If a node is marked as having changed in the old tree, it will not be reused.
   */
  id;
  /** The byte index where this node starts. */
  startIndex;
  /** The position where this node starts. */
  startPosition;
  /** The tree that this node belongs to. */
  tree;
  /** Get this node's type as a numerical id. */
  get typeId() {
    marshalNode(this);
    return C._ts_node_symbol_wasm(this.tree[0]);
  }
  /**
   * Get the node's type as a numerical id as it appears in the grammar,
   * ignoring aliases.
   */
  get grammarId() {
    marshalNode(this);
    return C._ts_node_grammar_symbol_wasm(this.tree[0]);
  }
  /** Get this node's type as a string. */
  get type() {
    return this.tree.language.types[this.typeId] || "ERROR";
  }
  /**
   * Get this node's symbol name as it appears in the grammar, ignoring
   * aliases as a string.
   */
  get grammarType() {
    return this.tree.language.types[this.grammarId] || "ERROR";
  }
  /**
   * Check if this node is *named*.
   *
   * Named nodes correspond to named rules in the grammar, whereas
   * *anonymous* nodes correspond to string literals in the grammar.
   */
  get isNamed() {
    marshalNode(this);
    return C._ts_node_is_named_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node is *extra*.
   *
   * Extra nodes represent things like comments, which are not required
   * by the grammar, but can appear anywhere.
   */
  get isExtra() {
    marshalNode(this);
    return C._ts_node_is_extra_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node represents a syntax error.
   *
   * Syntax errors represent parts of the code that could not be incorporated
   * into a valid syntax tree.
   */
  get isError() {
    marshalNode(this);
    return C._ts_node_is_error_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node is *missing*.
   *
   * Missing nodes are inserted by the parser in order to recover from
   * certain kinds of syntax errors.
   */
  get isMissing() {
    marshalNode(this);
    return C._ts_node_is_missing_wasm(this.tree[0]) === 1;
  }
  /** Check if this node has been edited. */
  get hasChanges() {
    marshalNode(this);
    return C._ts_node_has_changes_wasm(this.tree[0]) === 1;
  }
  /**
   * Check if this node represents a syntax error or contains any syntax
   * errors anywhere within it.
   */
  get hasError() {
    marshalNode(this);
    return C._ts_node_has_error_wasm(this.tree[0]) === 1;
  }
  /** Get the byte index where this node ends. */
  get endIndex() {
    marshalNode(this);
    return C._ts_node_end_index_wasm(this.tree[0]);
  }
  /** Get the position where this node ends. */
  get endPosition() {
    marshalNode(this);
    C._ts_node_end_point_wasm(this.tree[0]);
    return unmarshalPoint(TRANSFER_BUFFER);
  }
  /** Get the string content of this node. */
  get text() {
    return getText(this.tree, this.startIndex, this.endIndex, this.startPosition);
  }
  /** Get this node's parse state. */
  get parseState() {
    marshalNode(this);
    return C._ts_node_parse_state_wasm(this.tree[0]);
  }
  /** Get the parse state after this node. */
  get nextParseState() {
    marshalNode(this);
    return C._ts_node_next_parse_state_wasm(this.tree[0]);
  }
  /** Check if this node is equal to another node. */
  equals(other) {
    return this.tree === other.tree && this.id === other.id;
  }
  /**
   * Get the node's child at the given index, where zero represents the first child.
   *
   * This method is fairly fast, but its cost is technically log(n), so if
   * you might be iterating over a long list of children, you should use
   * {@link Node#children} instead.
   */
  child(index) {
    marshalNode(this);
    C._ts_node_child_wasm(this.tree[0], index);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's *named* child at the given index.
   *
   * See also {@link Node#isNamed}.
   * This method is fairly fast, but its cost is technically log(n), so if
   * you might be iterating over a long list of children, you should use
   * {@link Node#namedChildren} instead.
   */
  namedChild(index) {
    marshalNode(this);
    C._ts_node_named_child_wasm(this.tree[0], index);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's child with the given numerical field id.
   *
   * See also {@link Node#childForFieldName}. You can
   * convert a field name to an id using {@link Language#fieldIdForName}.
   */
  childForFieldId(fieldId) {
    marshalNode(this);
    C._ts_node_child_by_field_id_wasm(this.tree[0], fieldId);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the first child with the given field name.
   *
   * If multiple children may have the same field name, access them using
   * {@link Node#childrenForFieldName}.
   */
  childForFieldName(fieldName) {
    const fieldId = this.tree.language.fields.indexOf(fieldName);
    if (fieldId !== -1) return this.childForFieldId(fieldId);
    return null;
  }
  /** Get the field name of this node's child at the given index. */
  fieldNameForChild(index) {
    marshalNode(this);
    const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index);
    if (!address) return null;
    return C.AsciiToString(address);
  }
  /** Get the field name of this node's named child at the given index. */
  fieldNameForNamedChild(index) {
    marshalNode(this);
    const address = C._ts_node_field_name_for_named_child_wasm(this.tree[0], index);
    if (!address) return null;
    return C.AsciiToString(address);
  }
  /**
   * Get an array of this node's children with a given field name.
   *
   * See also {@link Node#children}.
   */
  childrenForFieldName(fieldName) {
    const fieldId = this.tree.language.fields.indexOf(fieldName);
    if (fieldId !== -1 && fieldId !== 0) return this.childrenForFieldId(fieldId);
    return [];
  }
  /**
    * Get an array of this node's children with a given field id.
    *
    * See also {@link Node#childrenForFieldName}.
    */
  childrenForFieldId(fieldId) {
    marshalNode(this);
    C._ts_node_children_by_field_id_wasm(this.tree[0], fieldId);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalNode(this.tree, address);
        address += SIZE_OF_NODE;
      }
      C._free(buffer);
    }
    return result;
  }
  /** Get the node's first child that contains or starts after the given byte offset. */
  firstChildForIndex(index) {
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, index, "i32");
    C._ts_node_first_child_for_byte_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the node's first named child that contains or starts after the given byte offset. */
  firstNamedChildForIndex(index) {
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, index, "i32");
    C._ts_node_first_named_child_for_byte_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get this node's number of children. */
  get childCount() {
    marshalNode(this);
    return C._ts_node_child_count_wasm(this.tree[0]);
  }
  /**
   * Get this node's number of *named* children.
   *
   * See also {@link Node#isNamed}.
   */
  get namedChildCount() {
    marshalNode(this);
    return C._ts_node_named_child_count_wasm(this.tree[0]);
  }
  /** Get this node's first child. */
  get firstChild() {
    return this.child(0);
  }
  /**
   * Get this node's first named child.
   *
   * See also {@link Node#isNamed}.
   */
  get firstNamedChild() {
    return this.namedChild(0);
  }
  /** Get this node's last child. */
  get lastChild() {
    return this.child(this.childCount - 1);
  }
  /**
   * Get this node's last named child.
   *
   * See also {@link Node#isNamed}.
   */
  get lastNamedChild() {
    return this.namedChild(this.namedChildCount - 1);
  }
  /**
   * Iterate over this node's children.
   *
   * If you're walking the tree recursively, you may want to use the
   * {@link TreeCursor} APIs directly instead.
   */
  get children() {
    if (!this._children) {
      marshalNode(this);
      C._ts_node_children_wasm(this.tree[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      this._children = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0; i2 < count; i2++) {
          this._children[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
        C._free(buffer);
      }
    }
    return this._children;
  }
  /**
   * Iterate over this node's named children.
   *
   * See also {@link Node#children}.
   */
  get namedChildren() {
    if (!this._namedChildren) {
      marshalNode(this);
      C._ts_node_named_children_wasm(this.tree[0]);
      const count = C.getValue(TRANSFER_BUFFER, "i32");
      const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      this._namedChildren = new Array(count);
      if (count > 0) {
        let address = buffer;
        for (let i2 = 0; i2 < count; i2++) {
          this._namedChildren[i2] = unmarshalNode(this.tree, address);
          address += SIZE_OF_NODE;
        }
        C._free(buffer);
      }
    }
    return this._namedChildren;
  }
  /**
   * Get the descendants of this node that are the given type, or in the given types array.
   *
   * The types array should contain node type strings, which can be retrieved from {@link Language#types}.
   *
   * Additionally, a `startPosition` and `endPosition` can be passed in to restrict the search to a byte range.
   */
  descendantsOfType(types, startPosition = ZERO_POINT, endPosition = ZERO_POINT) {
    if (!Array.isArray(types)) types = [types];
    const symbols = [];
    const typesBySymbol = this.tree.language.types;
    for (const node_type of types) {
      if (node_type == "ERROR") {
        symbols.push(65535);
      }
    }
    for (let i2 = 0, n = typesBySymbol.length; i2 < n; i2++) {
      if (types.includes(typesBySymbol[i2])) {
        symbols.push(i2);
      }
    }
    const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
    for (let i2 = 0, n = symbols.length; i2 < n; i2++) {
      C.setValue(symbolsAddress + i2 * SIZE_OF_INT, symbols[i2], "i32");
    }
    marshalNode(this);
    C._ts_node_descendants_of_type_wasm(
      this.tree[0],
      symbolsAddress,
      symbols.length,
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column
    );
    const descendantCount = C.getValue(TRANSFER_BUFFER, "i32");
    const descendantAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(descendantCount);
    if (descendantCount > 0) {
      let address = descendantAddress;
      for (let i2 = 0; i2 < descendantCount; i2++) {
        result[i2] = unmarshalNode(this.tree, address);
        address += SIZE_OF_NODE;
      }
    }
    C._free(descendantAddress);
    C._free(symbolsAddress);
    return result;
  }
  /** Get this node's next sibling. */
  get nextSibling() {
    marshalNode(this);
    C._ts_node_next_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get this node's previous sibling. */
  get previousSibling() {
    marshalNode(this);
    C._ts_node_prev_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's next *named* sibling.
   *
   * See also {@link Node#isNamed}.
   */
  get nextNamedSibling() {
    marshalNode(this);
    C._ts_node_next_named_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get this node's previous *named* sibling.
   *
   * See also {@link Node#isNamed}.
   */
  get previousNamedSibling() {
    marshalNode(this);
    C._ts_node_prev_named_sibling_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the node's number of descendants, including one for the node itself. */
  get descendantCount() {
    marshalNode(this);
    return C._ts_node_descendant_count_wasm(this.tree[0]);
  }
  /**
   * Get this node's immediate parent.
   * Prefer {@link Node#childWithDescendant} for iterating over this node's ancestors.
   */
  get parent() {
    marshalNode(this);
    C._ts_node_parent_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Get the node that contains `descendant`.
   *
   * Note that this can return `descendant` itself.
   */
  childWithDescendant(descendant) {
    marshalNode(this);
    marshalNode(descendant, 1);
    C._ts_node_child_with_descendant_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest node within this node that spans the given byte range. */
  descendantForIndex(start2, end = start2) {
    if (typeof start2 !== "number" || typeof end !== "number") {
      throw new Error("Arguments must be numbers");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, start2, "i32");
    C.setValue(address + SIZE_OF_INT, end, "i32");
    C._ts_node_descendant_for_index_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest named node within this node that spans the given byte range. */
  namedDescendantForIndex(start2, end = start2) {
    if (typeof start2 !== "number" || typeof end !== "number") {
      throw new Error("Arguments must be numbers");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    C.setValue(address, start2, "i32");
    C.setValue(address + SIZE_OF_INT, end, "i32");
    C._ts_node_named_descendant_for_index_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest node within this node that spans the given point range. */
  descendantForPosition(start2, end = start2) {
    if (!isPoint(start2) || !isPoint(end)) {
      throw new Error("Arguments must be {row, column} objects");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    marshalPoint(address, start2);
    marshalPoint(address + SIZE_OF_POINT, end);
    C._ts_node_descendant_for_position_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /** Get the smallest named node within this node that spans the given point range. */
  namedDescendantForPosition(start2, end = start2) {
    if (!isPoint(start2) || !isPoint(end)) {
      throw new Error("Arguments must be {row, column} objects");
    }
    marshalNode(this);
    const address = TRANSFER_BUFFER + SIZE_OF_NODE;
    marshalPoint(address, start2);
    marshalPoint(address + SIZE_OF_POINT, end);
    C._ts_node_named_descendant_for_position_wasm(this.tree[0]);
    return unmarshalNode(this.tree);
  }
  /**
   * Create a new {@link TreeCursor} starting from this node.
   *
   * Note that the given node is considered the root of the cursor,
   * and the cursor cannot walk outside this node.
   */
  walk() {
    marshalNode(this);
    C._ts_tree_cursor_new_wasm(this.tree[0]);
    return new TreeCursor(INTERNAL, this.tree);
  }
  /**
   * Edit this node to keep it in-sync with source code that has been edited.
   *
   * This function is only rarely needed. When you edit a syntax tree with
   * the {@link Tree#edit} method, all of the nodes that you retrieve from
   * the tree afterward will already reflect the edit. You only need to
   * use {@link Node#edit} when you have a specific {@link Node} instance that
   * you want to keep and continue to use after an edit.
   */
  edit(edit) {
    if (this.startIndex >= edit.oldEndIndex) {
      this.startIndex = edit.newEndIndex + (this.startIndex - edit.oldEndIndex);
      let subbedPointRow;
      let subbedPointColumn;
      if (this.startPosition.row > edit.oldEndPosition.row) {
        subbedPointRow = this.startPosition.row - edit.oldEndPosition.row;
        subbedPointColumn = this.startPosition.column;
      } else {
        subbedPointRow = 0;
        subbedPointColumn = this.startPosition.column;
        if (this.startPosition.column >= edit.oldEndPosition.column) {
          subbedPointColumn = this.startPosition.column - edit.oldEndPosition.column;
        }
      }
      if (subbedPointRow > 0) {
        this.startPosition.row += subbedPointRow;
        this.startPosition.column = subbedPointColumn;
      } else {
        this.startPosition.column += subbedPointColumn;
      }
    } else if (this.startIndex > edit.startIndex) {
      this.startIndex = edit.newEndIndex;
      this.startPosition.row = edit.newEndPosition.row;
      this.startPosition.column = edit.newEndPosition.column;
    }
  }
  /** Get the S-expression representation of this node. */
  toString() {
    marshalNode(this);
    const address = C._ts_node_to_string_wasm(this.tree[0]);
    const result = C.AsciiToString(address);
    C._free(address);
    return result;
  }
};
function unmarshalCaptures(query, tree, address, patternIndex, result) {
  for (let i2 = 0, n = result.length; i2 < n; i2++) {
    const captureIndex = C.getValue(address, "i32");
    address += SIZE_OF_INT;
    const node = unmarshalNode(tree, address);
    address += SIZE_OF_NODE;
    result[i2] = { patternIndex, name: query.captureNames[captureIndex], node };
  }
  return address;
}
__name(unmarshalCaptures, "unmarshalCaptures");
function marshalNode(node, index = 0) {
  let address = TRANSFER_BUFFER + index * SIZE_OF_NODE;
  C.setValue(address, node.id, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.row, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node.startPosition.column, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, node[0], "i32");
}
__name(marshalNode, "marshalNode");
function unmarshalNode(tree, address = TRANSFER_BUFFER) {
  const id = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  if (id === 0) return null;
  const index = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const row = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const column = C.getValue(address, "i32");
  address += SIZE_OF_INT;
  const other = C.getValue(address, "i32");
  const result = new Node(INTERNAL, {
    id,
    tree,
    startIndex: index,
    startPosition: { row, column },
    other
  });
  return result;
}
__name(unmarshalNode, "unmarshalNode");
function marshalTreeCursor(cursor, address = TRANSFER_BUFFER) {
  C.setValue(address + 0 * SIZE_OF_INT, cursor[0], "i32");
  C.setValue(address + 1 * SIZE_OF_INT, cursor[1], "i32");
  C.setValue(address + 2 * SIZE_OF_INT, cursor[2], "i32");
  C.setValue(address + 3 * SIZE_OF_INT, cursor[3], "i32");
}
__name(marshalTreeCursor, "marshalTreeCursor");
function unmarshalTreeCursor(cursor) {
  cursor[0] = C.getValue(TRANSFER_BUFFER + 0 * SIZE_OF_INT, "i32");
  cursor[1] = C.getValue(TRANSFER_BUFFER + 1 * SIZE_OF_INT, "i32");
  cursor[2] = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
  cursor[3] = C.getValue(TRANSFER_BUFFER + 3 * SIZE_OF_INT, "i32");
}
__name(unmarshalTreeCursor, "unmarshalTreeCursor");
function marshalPoint(address, point) {
  C.setValue(address, point.row, "i32");
  C.setValue(address + SIZE_OF_INT, point.column, "i32");
}
__name(marshalPoint, "marshalPoint");
function unmarshalPoint(address) {
  const result = {
    row: C.getValue(address, "i32") >>> 0,
    column: C.getValue(address + SIZE_OF_INT, "i32") >>> 0
  };
  return result;
}
__name(unmarshalPoint, "unmarshalPoint");
function marshalRange(address, range) {
  marshalPoint(address, range.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, range.endPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, range.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, range.endIndex, "i32");
  address += SIZE_OF_INT;
}
__name(marshalRange, "marshalRange");
function unmarshalRange(address) {
  const result = {};
  result.startPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.endPosition = unmarshalPoint(address);
  address += SIZE_OF_POINT;
  result.startIndex = C.getValue(address, "i32") >>> 0;
  address += SIZE_OF_INT;
  result.endIndex = C.getValue(address, "i32") >>> 0;
  return result;
}
__name(unmarshalRange, "unmarshalRange");
function marshalEdit(edit, address = TRANSFER_BUFFER) {
  marshalPoint(address, edit.startPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.oldEndPosition);
  address += SIZE_OF_POINT;
  marshalPoint(address, edit.newEndPosition);
  address += SIZE_OF_POINT;
  C.setValue(address, edit.startIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.oldEndIndex, "i32");
  address += SIZE_OF_INT;
  C.setValue(address, edit.newEndIndex, "i32");
  address += SIZE_OF_INT;
}
__name(marshalEdit, "marshalEdit");
function unmarshalLanguageMetadata(address) {
  const major_version = C.getValue(address, "i32");
  const minor_version = C.getValue(address += SIZE_OF_INT, "i32");
  const patch_version = C.getValue(address += SIZE_OF_INT, "i32");
  return { major_version, minor_version, patch_version };
}
__name(unmarshalLanguageMetadata, "unmarshalLanguageMetadata");
var LANGUAGE_FUNCTION_REGEX = /^tree_sitter_\w+$/;
var Language = class _Language {
  static {
    __name(this, "Language");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for Wasm
  /**
   * A list of all node types in the language. The index of each type in this
   * array is its node type id.
   */
  types;
  /**
   * A list of all field names in the language. The index of each field name in
   * this array is its field id.
   */
  fields;
  /** @internal */
  constructor(internal, address) {
    assertInternal(internal);
    this[0] = address;
    this.types = new Array(C._ts_language_symbol_count(this[0]));
    for (let i2 = 0, n = this.types.length; i2 < n; i2++) {
      if (C._ts_language_symbol_type(this[0], i2) < 2) {
        this.types[i2] = C.UTF8ToString(C._ts_language_symbol_name(this[0], i2));
      }
    }
    this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
    for (let i2 = 0, n = this.fields.length; i2 < n; i2++) {
      const fieldName = C._ts_language_field_name_for_id(this[0], i2);
      if (fieldName !== 0) {
        this.fields[i2] = C.UTF8ToString(fieldName);
      } else {
        this.fields[i2] = null;
      }
    }
  }
  /**
   * Gets the name of the language.
   */
  get name() {
    const ptr = C._ts_language_name(this[0]);
    if (ptr === 0) return null;
    return C.UTF8ToString(ptr);
  }
  /**
   * Gets the ABI version of the language.
   */
  get abiVersion() {
    return C._ts_language_abi_version(this[0]);
  }
  /**
  * Get the metadata for this language. This information is generated by the
  * CLI, and relies on the language author providing the correct metadata in
  * the language's `tree-sitter.json` file.
  */
  get metadata() {
    C._ts_language_metadata_wasm(this[0]);
    const length = C.getValue(TRANSFER_BUFFER, "i32");
    if (length === 0) return null;
    return unmarshalLanguageMetadata(TRANSFER_BUFFER + SIZE_OF_INT);
  }
  /**
   * Gets the number of fields in the language.
   */
  get fieldCount() {
    return this.fields.length - 1;
  }
  /**
   * Gets the number of states in the language.
   */
  get stateCount() {
    return C._ts_language_state_count(this[0]);
  }
  /**
   * Get the field id for a field name.
   */
  fieldIdForName(fieldName) {
    const result = this.fields.indexOf(fieldName);
    return result !== -1 ? result : null;
  }
  /**
   * Get the field name for a field id.
   */
  fieldNameForId(fieldId) {
    return this.fields[fieldId] ?? null;
  }
  /**
   * Get the node type id for a node type name.
   */
  idForNodeType(type, named) {
    const typeLength = C.lengthBytesUTF8(type);
    const typeAddress = C._malloc(typeLength + 1);
    C.stringToUTF8(type, typeAddress, typeLength + 1);
    const result = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named ? 1 : 0);
    C._free(typeAddress);
    return result || null;
  }
  /**
   * Gets the number of node types in the language.
   */
  get nodeTypeCount() {
    return C._ts_language_symbol_count(this[0]);
  }
  /**
   * Get the node type name for a node type id.
   */
  nodeTypeForId(typeId) {
    const name22 = C._ts_language_symbol_name(this[0], typeId);
    return name22 ? C.UTF8ToString(name22) : null;
  }
  /**
   * Check if a node type is named.
   *
   * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html#named-vs-anonymous-nodes}
   */
  nodeTypeIsNamed(typeId) {
    return C._ts_language_type_is_named_wasm(this[0], typeId) ? true : false;
  }
  /**
   * Check if a node type is visible.
   */
  nodeTypeIsVisible(typeId) {
    return C._ts_language_type_is_visible_wasm(this[0], typeId) ? true : false;
  }
  /**
   * Get the supertypes ids of this language.
   *
   * @see {@link https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types.html?highlight=supertype#supertype-nodes}
   */
  get supertypes() {
    C._ts_language_supertypes_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = C.getValue(address, "i16");
        address += SIZE_OF_SHORT;
      }
    }
    return result;
  }
  /**
   * Get the subtype ids for a given supertype node id.
   */
  subtypes(supertype) {
    C._ts_language_subtypes_wasm(this[0], supertype);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = C.getValue(address, "i16");
        address += SIZE_OF_SHORT;
      }
    }
    return result;
  }
  /**
   * Get the next state id for a given state id and node type id.
   */
  nextState(stateId, typeId) {
    return C._ts_language_next_state(this[0], stateId, typeId);
  }
  /**
   * Create a new lookahead iterator for this language and parse state.
   *
   * This returns `null` if state is invalid for this language.
   *
   * Iterating {@link LookaheadIterator} will yield valid symbols in the given
   * parse state. Newly created lookahead iterators will return the `ERROR`
   * symbol from {@link LookaheadIterator#currentType}.
   *
   * Lookahead iterators can be useful for generating suggestions and improving
   * syntax error diagnostics. To get symbols valid in an `ERROR` node, use the
   * lookahead iterator on its first leaf node state. For `MISSING` nodes, a
   * lookahead iterator created on the previous non-extra leaf node may be
   * appropriate.
   */
  lookaheadIterator(stateId) {
    const address = C._ts_lookahead_iterator_new(this[0], stateId);
    if (address) return new LookaheadIterator(INTERNAL, address, this);
    return null;
  }
  /**
   * Load a language from a WebAssembly module.
   * The module can be provided as a path to a file or as a buffer.
   */
  static async load(input) {
    let binary2;
    if (input instanceof Uint8Array) {
      binary2 = input;
    } else if (globalThis.process?.versions.node) {
      const fs22 = await import("fs/promises");
      binary2 = await fs22.readFile(input);
    } else {
      const response = await fetch(input);
      if (!response.ok) {
        const body2 = await response.text();
        throw new Error(`Language.load failed with status ${response.status}.

${body2}`);
      }
      const retryResp = response.clone();
      try {
        binary2 = await WebAssembly.compileStreaming(response);
      } catch (reason) {
        console.error("wasm streaming compile failed:", reason);
        console.error("falling back to ArrayBuffer instantiation");
        binary2 = new Uint8Array(await retryResp.arrayBuffer());
      }
    }
    const mod = await C.loadWebAssemblyModule(binary2, { loadAsync: true });
    const symbolNames = Object.keys(mod);
    const functionName = symbolNames.find((key) => LANGUAGE_FUNCTION_REGEX.test(key) && !key.includes("external_scanner_"));
    if (!functionName) {
      console.log(`Couldn't find language function in Wasm file. Symbols:
${JSON.stringify(symbolNames, null, 2)}`);
      throw new Error("Language.load failed: no language function found in Wasm file");
    }
    const languageAddress = mod[functionName]();
    return new _Language(INTERNAL, languageAddress);
  }
};
async function Module2(moduleArg = {}) {
  var moduleRtn;
  var Module = moduleArg;
  var ENVIRONMENT_IS_WEB = typeof window == "object";
  var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
  var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";
  if (ENVIRONMENT_IS_NODE) {
    const { createRequire } = await import("module");
    var require = createRequire(import.meta.url);
  }
  Module.currentQueryProgressCallback = null;
  Module.currentProgressCallback = null;
  Module.currentLogCallback = null;
  Module.currentParseCallback = null;
  var arguments_ = [];
  var thisProgram = "./this.program";
  var quit_ = /* @__PURE__ */ __name((status, toThrow) => {
    throw toThrow;
  }, "quit_");
  var _scriptName = import.meta.url;
  var scriptDirectory = "";
  function locateFile(path3) {
    if (Module["locateFile"]) {
      return Module["locateFile"](path3, scriptDirectory);
    }
    return scriptDirectory + path3;
  }
  __name(locateFile, "locateFile");
  var readAsync, readBinary;
  if (ENVIRONMENT_IS_NODE) {
    var fs = require("fs");
    if (_scriptName.startsWith("file:")) {
      scriptDirectory = require("path").dirname(require("url").fileURLToPath(_scriptName)) + "/";
    }
    readBinary = /* @__PURE__ */ __name((filename) => {
      filename = isFileURI(filename) ? new URL(filename) : filename;
      var ret = fs.readFileSync(filename);
      return ret;
    }, "readBinary");
    readAsync = /* @__PURE__ */ __name(async (filename, binary2 = true) => {
      filename = isFileURI(filename) ? new URL(filename) : filename;
      var ret = fs.readFileSync(filename, binary2 ? void 0 : "utf8");
      return ret;
    }, "readAsync");
    if (process.argv.length > 1) {
      thisProgram = process.argv[1].replace(/\\/g, "/");
    }
    arguments_ = process.argv.slice(2);
    quit_ = /* @__PURE__ */ __name((status, toThrow) => {
      process.exitCode = status;
      throw toThrow;
    }, "quit_");
  } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    try {
      scriptDirectory = new URL(".", _scriptName).href;
    } catch {
    }
    {
      if (ENVIRONMENT_IS_WORKER) {
        readBinary = /* @__PURE__ */ __name((url) => {
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, false);
          xhr.responseType = "arraybuffer";
          xhr.send(null);
          return new Uint8Array(
            /** @type{!ArrayBuffer} */
            xhr.response
          );
        }, "readBinary");
      }
      readAsync = /* @__PURE__ */ __name(async (url) => {
        if (isFileURI(url)) {
          return new Promise((resolve3, reject) => {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = "arraybuffer";
            xhr.onload = () => {
              if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                resolve3(xhr.response);
                return;
              }
              reject(xhr.status);
            };
            xhr.onerror = reject;
            xhr.send(null);
          });
        }
        var response = await fetch(url, {
          credentials: "same-origin"
        });
        if (response.ok) {
          return response.arrayBuffer();
        }
        throw new Error(response.status + " : " + response.url);
      }, "readAsync");
    }
  } else {
  }
  var out = console.log.bind(console);
  var err = console.error.bind(console);
  var dynamicLibraries = [];
  var wasmBinary;
  var ABORT = false;
  var EXITSTATUS;
  var isFileURI = /* @__PURE__ */ __name((filename) => filename.startsWith("file://"), "isFileURI");
  var readyPromiseResolve, readyPromiseReject;
  var wasmMemory;
  var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
  var HEAP64, HEAPU64;
  var HEAP_DATA_VIEW;
  var runtimeInitialized = false;
  function updateMemoryViews() {
    var b = wasmMemory.buffer;
    Module["HEAP8"] = HEAP8 = new Int8Array(b);
    Module["HEAP16"] = HEAP16 = new Int16Array(b);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
    Module["HEAP32"] = HEAP32 = new Int32Array(b);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
    Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
    Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
    Module["HEAP_DATA_VIEW"] = HEAP_DATA_VIEW = new DataView(b);
    LE_HEAP_UPDATE();
  }
  __name(updateMemoryViews, "updateMemoryViews");
  function initMemory() {
    if (Module["wasmMemory"]) {
      wasmMemory = Module["wasmMemory"];
    } else {
      var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
      wasmMemory = new WebAssembly.Memory({
        "initial": INITIAL_MEMORY / 65536,
        // In theory we should not need to emit the maximum if we want "unlimited"
        // or 4GB of memory, but VMs error on that atm, see
        // https://github.com/emscripten-core/emscripten/issues/14130
        // And in the pthreads case we definitely need to emit a maximum. So
        // always emit one.
        "maximum": 32768
      });
    }
    updateMemoryViews();
  }
  __name(initMemory, "initMemory");
  var __RELOC_FUNCS__ = [];
  function preRun() {
    if (Module["preRun"]) {
      if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
      while (Module["preRun"].length) {
        addOnPreRun(Module["preRun"].shift());
      }
    }
    callRuntimeCallbacks(onPreRuns);
  }
  __name(preRun, "preRun");
  function initRuntime() {
    runtimeInitialized = true;
    callRuntimeCallbacks(__RELOC_FUNCS__);
    wasmExports["__wasm_call_ctors"]();
    callRuntimeCallbacks(onPostCtors);
  }
  __name(initRuntime, "initRuntime");
  function preMain() {
  }
  __name(preMain, "preMain");
  function postRun() {
    if (Module["postRun"]) {
      if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
      while (Module["postRun"].length) {
        addOnPostRun(Module["postRun"].shift());
      }
    }
    callRuntimeCallbacks(onPostRuns);
  }
  __name(postRun, "postRun");
  function abort(what) {
    Module["onAbort"]?.(what);
    what = "Aborted(" + what + ")";
    err(what);
    ABORT = true;
    what += ". Build with -sASSERTIONS for more info.";
    var e = new WebAssembly.RuntimeError(what);
    readyPromiseReject?.(e);
    throw e;
  }
  __name(abort, "abort");
  var wasmBinaryFile;
  function findWasmBinary() {
    if (Module["locateFile"]) {
      return locateFile("web-tree-sitter.wasm");
    }
    return new URL("web-tree-sitter.wasm", import.meta.url).href;
  }
  __name(findWasmBinary, "findWasmBinary");
  function getBinarySync(file) {
    if (file == wasmBinaryFile && wasmBinary) {
      return new Uint8Array(wasmBinary);
    }
    if (readBinary) {
      return readBinary(file);
    }
    throw "both async and sync fetching of the wasm failed";
  }
  __name(getBinarySync, "getBinarySync");
  async function getWasmBinary(binaryFile) {
    if (!wasmBinary) {
      try {
        var response = await readAsync(binaryFile);
        return new Uint8Array(response);
      } catch {
      }
    }
    return getBinarySync(binaryFile);
  }
  __name(getWasmBinary, "getWasmBinary");
  async function instantiateArrayBuffer(binaryFile, imports) {
    try {
      var binary2 = await getWasmBinary(binaryFile);
      var instance2 = await WebAssembly.instantiate(binary2, imports);
      return instance2;
    } catch (reason) {
      err(`failed to asynchronously prepare wasm: ${reason}`);
      abort(reason);
    }
  }
  __name(instantiateArrayBuffer, "instantiateArrayBuffer");
  async function instantiateAsync(binary2, binaryFile, imports) {
    if (!binary2 && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
      try {
        var response = fetch(binaryFile, {
          credentials: "same-origin"
        });
        var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
        return instantiationResult;
      } catch (reason) {
        err(`wasm streaming compile failed: ${reason}`);
        err("falling back to ArrayBuffer instantiation");
      }
    }
    return instantiateArrayBuffer(binaryFile, imports);
  }
  __name(instantiateAsync, "instantiateAsync");
  function getWasmImports() {
    return {
      "env": wasmImports,
      "wasi_snapshot_preview1": wasmImports,
      "GOT.mem": new Proxy(wasmImports, GOTHandler),
      "GOT.func": new Proxy(wasmImports, GOTHandler)
    };
  }
  __name(getWasmImports, "getWasmImports");
  async function createWasm() {
    function receiveInstance(instance2, module2) {
      wasmExports = instance2.exports;
      wasmExports = relocateExports(wasmExports, 1024);
      var metadata2 = getDylinkMetadata(module2);
      if (metadata2.neededDynlibs) {
        dynamicLibraries = metadata2.neededDynlibs.concat(dynamicLibraries);
      }
      mergeLibSymbols(wasmExports, "main");
      LDSO.init();
      loadDylibs();
      __RELOC_FUNCS__.push(wasmExports["__wasm_apply_data_relocs"]);
      assignWasmExports(wasmExports);
      return wasmExports;
    }
    __name(receiveInstance, "receiveInstance");
    function receiveInstantiationResult(result2) {
      return receiveInstance(result2["instance"], result2["module"]);
    }
    __name(receiveInstantiationResult, "receiveInstantiationResult");
    var info2 = getWasmImports();
    if (Module["instantiateWasm"]) {
      return new Promise((resolve3, reject) => {
        Module["instantiateWasm"](info2, (mod, inst) => {
          resolve3(receiveInstance(mod, inst));
        });
      });
    }
    wasmBinaryFile ??= findWasmBinary();
    var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info2);
    var exports = receiveInstantiationResult(result);
    return exports;
  }
  __name(createWasm, "createWasm");
  class ExitStatus {
    static {
      __name(this, "ExitStatus");
    }
    name = "ExitStatus";
    constructor(status) {
      this.message = `Program terminated with exit(${status})`;
      this.status = status;
    }
  }
  var GOT = {};
  var currentModuleWeakSymbols = /* @__PURE__ */ new Set([]);
  var GOTHandler = {
    get(obj, symName) {
      var rtn = GOT[symName];
      if (!rtn) {
        rtn = GOT[symName] = new WebAssembly.Global({
          "value": "i32",
          "mutable": true
        });
      }
      if (!currentModuleWeakSymbols.has(symName)) {
        rtn.required = true;
      }
      return rtn;
    }
  };
  var LE_ATOMICS_NATIVE_BYTE_ORDER = [];
  var LE_HEAP_LOAD_F32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat32(byteOffset, true), "LE_HEAP_LOAD_F32");
  var LE_HEAP_LOAD_F64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getFloat64(byteOffset, true), "LE_HEAP_LOAD_F64");
  var LE_HEAP_LOAD_I16 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt16(byteOffset, true), "LE_HEAP_LOAD_I16");
  var LE_HEAP_LOAD_I32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getInt32(byteOffset, true), "LE_HEAP_LOAD_I32");
  var LE_HEAP_LOAD_I64 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getBigInt64(byteOffset, true), "LE_HEAP_LOAD_I64");
  var LE_HEAP_LOAD_U32 = /* @__PURE__ */ __name((byteOffset) => HEAP_DATA_VIEW.getUint32(byteOffset, true), "LE_HEAP_LOAD_U32");
  var LE_HEAP_STORE_F32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat32(byteOffset, value, true), "LE_HEAP_STORE_F32");
  var LE_HEAP_STORE_F64 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setFloat64(byteOffset, value, true), "LE_HEAP_STORE_F64");
  var LE_HEAP_STORE_I16 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt16(byteOffset, value, true), "LE_HEAP_STORE_I16");
  var LE_HEAP_STORE_I32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setInt32(byteOffset, value, true), "LE_HEAP_STORE_I32");
  var LE_HEAP_STORE_I64 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setBigInt64(byteOffset, value, true), "LE_HEAP_STORE_I64");
  var LE_HEAP_STORE_U32 = /* @__PURE__ */ __name((byteOffset, value) => HEAP_DATA_VIEW.setUint32(byteOffset, value, true), "LE_HEAP_STORE_U32");
  var callRuntimeCallbacks = /* @__PURE__ */ __name((callbacks) => {
    while (callbacks.length > 0) {
      callbacks.shift()(Module);
    }
  }, "callRuntimeCallbacks");
  var onPostRuns = [];
  var addOnPostRun = /* @__PURE__ */ __name((cb) => onPostRuns.push(cb), "addOnPostRun");
  var onPreRuns = [];
  var addOnPreRun = /* @__PURE__ */ __name((cb) => onPreRuns.push(cb), "addOnPreRun");
  var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
  var findStringEnd = /* @__PURE__ */ __name((heapOrArray, idx, maxBytesToRead, ignoreNul) => {
    var maxIdx = idx + maxBytesToRead;
    if (ignoreNul) return maxIdx;
    while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
    return idx;
  }, "findStringEnd");
  var UTF8ArrayToString = /* @__PURE__ */ __name((heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
    var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
    if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
      return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
    }
    var str = "";
    while (idx < endPtr) {
      var u0 = heapOrArray[idx++];
      if (!(u0 & 128)) {
        str += String.fromCharCode(u0);
        continue;
      }
      var u1 = heapOrArray[idx++] & 63;
      if ((u0 & 224) == 192) {
        str += String.fromCharCode((u0 & 31) << 6 | u1);
        continue;
      }
      var u2 = heapOrArray[idx++] & 63;
      if ((u0 & 240) == 224) {
        u0 = (u0 & 15) << 12 | u1 << 6 | u2;
      } else {
        u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
      }
      if (u0 < 65536) {
        str += String.fromCharCode(u0);
      } else {
        var ch = u0 - 65536;
        str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
      }
    }
    return str;
  }, "UTF8ArrayToString");
  var getDylinkMetadata = /* @__PURE__ */ __name((binary2) => {
    var offset = 0;
    var end = 0;
    function getU8() {
      return binary2[offset++];
    }
    __name(getU8, "getU8");
    function getLEB() {
      var ret = 0;
      var mul = 1;
      while (1) {
        var byte = binary2[offset++];
        ret += (byte & 127) * mul;
        mul *= 128;
        if (!(byte & 128)) break;
      }
      return ret;
    }
    __name(getLEB, "getLEB");
    function getString() {
      var len = getLEB();
      offset += len;
      return UTF8ArrayToString(binary2, offset - len, len);
    }
    __name(getString, "getString");
    function getStringList() {
      var count2 = getLEB();
      var rtn = [];
      while (count2--) rtn.push(getString());
      return rtn;
    }
    __name(getStringList, "getStringList");
    function failIf(condition, message) {
      if (condition) throw new Error(message);
    }
    __name(failIf, "failIf");
    if (binary2 instanceof WebAssembly.Module) {
      var dylinkSection = WebAssembly.Module.customSections(binary2, "dylink.0");
      failIf(dylinkSection.length === 0, "need dylink section");
      binary2 = new Uint8Array(dylinkSection[0]);
      end = binary2.length;
    } else {
      var int32View = new Uint32Array(new Uint8Array(binary2.subarray(0, 24)).buffer);
      var magicNumberFound = int32View[0] == 1836278016 || int32View[0] == 6386541;
      failIf(!magicNumberFound, "need to see wasm magic number");
      failIf(binary2[8] !== 0, "need the dylink section to be first");
      offset = 9;
      var section_size = getLEB();
      end = offset + section_size;
      var name22 = getString();
      failIf(name22 !== "dylink.0");
    }
    var customSection = {
      neededDynlibs: [],
      tlsExports: /* @__PURE__ */ new Set(),
      weakImports: /* @__PURE__ */ new Set(),
      runtimePaths: []
    };
    var WASM_DYLINK_MEM_INFO = 1;
    var WASM_DYLINK_NEEDED = 2;
    var WASM_DYLINK_EXPORT_INFO = 3;
    var WASM_DYLINK_IMPORT_INFO = 4;
    var WASM_DYLINK_RUNTIME_PATH = 5;
    var WASM_SYMBOL_TLS = 256;
    var WASM_SYMBOL_BINDING_MASK = 3;
    var WASM_SYMBOL_BINDING_WEAK = 1;
    while (offset < end) {
      var subsectionType = getU8();
      var subsectionSize = getLEB();
      if (subsectionType === WASM_DYLINK_MEM_INFO) {
        customSection.memorySize = getLEB();
        customSection.memoryAlign = getLEB();
        customSection.tableSize = getLEB();
        customSection.tableAlign = getLEB();
      } else if (subsectionType === WASM_DYLINK_NEEDED) {
        customSection.neededDynlibs = getStringList();
      } else if (subsectionType === WASM_DYLINK_EXPORT_INFO) {
        var count = getLEB();
        while (count--) {
          var symname = getString();
          var flags2 = getLEB();
          if (flags2 & WASM_SYMBOL_TLS) {
            customSection.tlsExports.add(symname);
          }
        }
      } else if (subsectionType === WASM_DYLINK_IMPORT_INFO) {
        var count = getLEB();
        while (count--) {
          var modname = getString();
          var symname = getString();
          var flags2 = getLEB();
          if ((flags2 & WASM_SYMBOL_BINDING_MASK) == WASM_SYMBOL_BINDING_WEAK) {
            customSection.weakImports.add(symname);
          }
        }
      } else if (subsectionType === WASM_DYLINK_RUNTIME_PATH) {
        customSection.runtimePaths = getStringList();
      } else {
        offset += subsectionSize;
      }
    }
    return customSection;
  }, "getDylinkMetadata");
  function getValue(ptr, type = "i8") {
    if (type.endsWith("*")) type = "*";
    switch (type) {
      case "i1":
        return HEAP8[ptr];
      case "i8":
        return HEAP8[ptr];
      case "i16":
        return LE_HEAP_LOAD_I16((ptr >> 1) * 2);
      case "i32":
        return LE_HEAP_LOAD_I32((ptr >> 2) * 4);
      case "i64":
        return LE_HEAP_LOAD_I64((ptr >> 3) * 8);
      case "float":
        return LE_HEAP_LOAD_F32((ptr >> 2) * 4);
      case "double":
        return LE_HEAP_LOAD_F64((ptr >> 3) * 8);
      case "*":
        return LE_HEAP_LOAD_U32((ptr >> 2) * 4);
      default:
        abort(`invalid type for getValue: ${type}`);
    }
  }
  __name(getValue, "getValue");
  var newDSO = /* @__PURE__ */ __name((name22, handle2, syms) => {
    var dso = {
      refcount: Infinity,
      name: name22,
      exports: syms,
      global: true
    };
    LDSO.loadedLibsByName[name22] = dso;
    if (handle2 != void 0) {
      LDSO.loadedLibsByHandle[handle2] = dso;
    }
    return dso;
  }, "newDSO");
  var LDSO = {
    loadedLibsByName: {},
    loadedLibsByHandle: {},
    init() {
      newDSO("__main__", 0, wasmImports);
    }
  };
  var ___heap_base = 78240;
  var alignMemory = /* @__PURE__ */ __name((size, alignment) => Math.ceil(size / alignment) * alignment, "alignMemory");
  var getMemory = /* @__PURE__ */ __name((size) => {
    if (runtimeInitialized) {
      return _calloc(size, 1);
    }
    var ret = ___heap_base;
    var end = ret + alignMemory(size, 16);
    ___heap_base = end;
    GOT["__heap_base"].value = end;
    return ret;
  }, "getMemory");
  var isInternalSym = /* @__PURE__ */ __name((symName) => ["__cpp_exception", "__c_longjmp", "__wasm_apply_data_relocs", "__dso_handle", "__tls_size", "__tls_align", "__set_stack_limits", "_emscripten_tls_init", "__wasm_init_tls", "__wasm_call_ctors", "__start_em_asm", "__stop_em_asm", "__start_em_js", "__stop_em_js"].includes(symName) || symName.startsWith("__em_js__"), "isInternalSym");
  var uleb128EncodeWithLen = /* @__PURE__ */ __name((arr) => {
    const n = arr.length;
    return [n % 128 | 128, n >> 7, ...arr];
  }, "uleb128EncodeWithLen");
  var wasmTypeCodes = {
    "i": 127,
    // i32
    "p": 127,
    // i32
    "j": 126,
    // i64
    "f": 125,
    // f32
    "d": 124,
    // f64
    "e": 111
  };
  var generateTypePack = /* @__PURE__ */ __name((types) => uleb128EncodeWithLen(Array.from(types, (type) => {
    var code = wasmTypeCodes[type];
    return code;
  })), "generateTypePack");
  var convertJsFunctionToWasm = /* @__PURE__ */ __name((func2, sig) => {
    var bytes = Uint8Array.of(
      0,
      97,
      115,
      109,
      // magic ("\0asm")
      1,
      0,
      0,
      0,
      // version: 1
      1,
      ...uleb128EncodeWithLen([
        1,
        // count: 1
        96,
        // param types
        ...generateTypePack(sig.slice(1)),
        // return types (for now only supporting [] if `void` and single [T] otherwise)
        ...generateTypePack(sig[0] === "v" ? "" : sig[0])
      ]),
      // The rest of the module is static
      2,
      7,
      // import section
      // (import "e" "f" (func 0 (type 0)))
      1,
      1,
      101,
      1,
      102,
      0,
      0,
      7,
      5,
      // export section
      // (export "f" (func 0 (type 0)))
      1,
      1,
      102,
      0,
      0
    );
    var module2 = new WebAssembly.Module(bytes);
    var instance2 = new WebAssembly.Instance(module2, {
      "e": {
        "f": func2
      }
    });
    var wrappedFunc = instance2.exports["f"];
    return wrappedFunc;
  }, "convertJsFunctionToWasm");
  var wasmTableMirror = [];
  var wasmTable = new WebAssembly.Table({
    "initial": 31,
    "element": "anyfunc"
  });
  var getWasmTableEntry = /* @__PURE__ */ __name((funcPtr) => {
    var func2 = wasmTableMirror[funcPtr];
    if (!func2) {
      wasmTableMirror[funcPtr] = func2 = wasmTable.get(funcPtr);
    }
    return func2;
  }, "getWasmTableEntry");
  var updateTableMap = /* @__PURE__ */ __name((offset, count) => {
    if (functionsInTableMap) {
      for (var i2 = offset; i2 < offset + count; i2++) {
        var item = getWasmTableEntry(i2);
        if (item) {
          functionsInTableMap.set(item, i2);
        }
      }
    }
  }, "updateTableMap");
  var functionsInTableMap;
  var getFunctionAddress = /* @__PURE__ */ __name((func2) => {
    if (!functionsInTableMap) {
      functionsInTableMap = /* @__PURE__ */ new WeakMap();
      updateTableMap(0, wasmTable.length);
    }
    return functionsInTableMap.get(func2) || 0;
  }, "getFunctionAddress");
  var freeTableIndexes = [];
  var getEmptyTableSlot = /* @__PURE__ */ __name(() => {
    if (freeTableIndexes.length) {
      return freeTableIndexes.pop();
    }
    return wasmTable["grow"](1);
  }, "getEmptyTableSlot");
  var setWasmTableEntry = /* @__PURE__ */ __name((idx, func2) => {
    wasmTable.set(idx, func2);
    wasmTableMirror[idx] = wasmTable.get(idx);
  }, "setWasmTableEntry");
  var addFunction = /* @__PURE__ */ __name((func2, sig) => {
    var rtn = getFunctionAddress(func2);
    if (rtn) {
      return rtn;
    }
    var ret = getEmptyTableSlot();
    try {
      setWasmTableEntry(ret, func2);
    } catch (err2) {
      if (!(err2 instanceof TypeError)) {
        throw err2;
      }
      var wrapped = convertJsFunctionToWasm(func2, sig);
      setWasmTableEntry(ret, wrapped);
    }
    functionsInTableMap.set(func2, ret);
    return ret;
  }, "addFunction");
  var updateGOT = /* @__PURE__ */ __name((exports, replace) => {
    for (var symName in exports) {
      if (isInternalSym(symName)) {
        continue;
      }
      var value = exports[symName];
      GOT[symName] ||= new WebAssembly.Global({
        "value": "i32",
        "mutable": true
      });
      if (replace || GOT[symName].value == 0) {
        if (typeof value == "function") {
          GOT[symName].value = addFunction(value);
        } else if (typeof value == "number") {
          GOT[symName].value = value;
        } else {
          err(`unhandled export type for '${symName}': ${typeof value}`);
        }
      }
    }
  }, "updateGOT");
  var relocateExports = /* @__PURE__ */ __name((exports, memoryBase2, replace) => {
    var relocated = {};
    for (var e in exports) {
      var value = exports[e];
      if (typeof value == "object") {
        value = value.value;
      }
      if (typeof value == "number") {
        value += memoryBase2;
      }
      relocated[e] = value;
    }
    updateGOT(relocated, replace);
    return relocated;
  }, "relocateExports");
  var isSymbolDefined = /* @__PURE__ */ __name((symName) => {
    var existing = wasmImports[symName];
    if (!existing || existing.stub) {
      return false;
    }
    return true;
  }, "isSymbolDefined");
  var dynCall = /* @__PURE__ */ __name((sig, ptr, args2 = [], promising = false) => {
    var func2 = getWasmTableEntry(ptr);
    var rtn = func2(...args2);
    function convert(rtn2) {
      return rtn2;
    }
    __name(convert, "convert");
    return convert(rtn);
  }, "dynCall");
  var stackSave = /* @__PURE__ */ __name(() => _emscripten_stack_get_current(), "stackSave");
  var stackRestore = /* @__PURE__ */ __name((val) => __emscripten_stack_restore(val), "stackRestore");
  var createInvokeFunction = /* @__PURE__ */ __name((sig) => (ptr, ...args2) => {
    var sp = stackSave();
    try {
      return dynCall(sig, ptr, args2);
    } catch (e) {
      stackRestore(sp);
      if (e !== e + 0) throw e;
      _setThrew(1, 0);
      if (sig[0] == "j") return 0n;
    }
  }, "createInvokeFunction");
  var resolveGlobalSymbol = /* @__PURE__ */ __name((symName, direct = false) => {
    var sym;
    if (isSymbolDefined(symName)) {
      sym = wasmImports[symName];
    } else if (symName.startsWith("invoke_")) {
      sym = wasmImports[symName] = createInvokeFunction(symName.split("_")[1]);
    }
    return {
      sym,
      name: symName
    };
  }, "resolveGlobalSymbol");
  var onPostCtors = [];
  var addOnPostCtor = /* @__PURE__ */ __name((cb) => onPostCtors.push(cb), "addOnPostCtor");
  var UTF8ToString = /* @__PURE__ */ __name((ptr, maxBytesToRead, ignoreNul) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "", "UTF8ToString");
  var loadWebAssemblyModule = /* @__PURE__ */ __name((binary, flags, libName, localScope, handle) => {
    var metadata = getDylinkMetadata(binary);
    function loadModule() {
      var memAlign = Math.pow(2, metadata.memoryAlign);
      var memoryBase = metadata.memorySize ? alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
      var tableBase = metadata.tableSize ? wasmTable.length : 0;
      if (handle) {
        HEAP8[handle + 8] = 1;
        LE_HEAP_STORE_U32((handle + 12 >> 2) * 4, memoryBase);
        LE_HEAP_STORE_I32((handle + 16 >> 2) * 4, metadata.memorySize);
        LE_HEAP_STORE_U32((handle + 20 >> 2) * 4, tableBase);
        LE_HEAP_STORE_I32((handle + 24 >> 2) * 4, metadata.tableSize);
      }
      if (metadata.tableSize) {
        wasmTable.grow(metadata.tableSize);
      }
      var moduleExports;
      function resolveSymbol(sym) {
        var resolved = resolveGlobalSymbol(sym).sym;
        if (!resolved && localScope) {
          resolved = localScope[sym];
        }
        if (!resolved) {
          resolved = moduleExports[sym];
        }
        return resolved;
      }
      __name(resolveSymbol, "resolveSymbol");
      var proxyHandler = {
        get(stubs, prop) {
          switch (prop) {
            case "__memory_base":
              return memoryBase;
            case "__table_base":
              return tableBase;
          }
          if (prop in wasmImports && !wasmImports[prop].stub) {
            var res = wasmImports[prop];
            return res;
          }
          if (!(prop in stubs)) {
            var resolved;
            stubs[prop] = (...args2) => {
              resolved ||= resolveSymbol(prop);
              return resolved(...args2);
            };
          }
          return stubs[prop];
        }
      };
      var proxy = new Proxy({}, proxyHandler);
      currentModuleWeakSymbols = metadata.weakImports;
      var info = {
        "GOT.mem": new Proxy({}, GOTHandler),
        "GOT.func": new Proxy({}, GOTHandler),
        "env": proxy,
        "wasi_snapshot_preview1": proxy
      };
      function postInstantiation(module, instance) {
        updateTableMap(tableBase, metadata.tableSize);
        moduleExports = relocateExports(instance.exports, memoryBase);
        if (!flags.allowUndefined) {
          reportUndefinedSymbols();
        }
        function addEmAsm(addr, body) {
          var args = [];
          var arity = 0;
          for (; arity < 16; arity++) {
            if (body.indexOf("$" + arity) != -1) {
              args.push("$" + arity);
            } else {
              break;
            }
          }
          args = args.join(",");
          var func = `(${args}) => { ${body} };`;
          ASM_CONSTS[start] = eval(func);
        }
        __name(addEmAsm, "addEmAsm");
        if ("__start_em_asm" in moduleExports) {
          var start = moduleExports["__start_em_asm"];
          var stop = moduleExports["__stop_em_asm"];
          while (start < stop) {
            var jsString = UTF8ToString(start);
            addEmAsm(start, jsString);
            start = HEAPU8.indexOf(0, start) + 1;
          }
        }
        function addEmJs(name, cSig, body) {
          var jsArgs = [];
          cSig = cSig.slice(1, -1);
          if (cSig != "void") {
            cSig = cSig.split(",");
            for (var i in cSig) {
              var jsArg = cSig[i].split(" ").pop();
              jsArgs.push(jsArg.replace("*", ""));
            }
          }
          var func = `(${jsArgs}) => ${body};`;
          moduleExports[name] = eval(func);
        }
        __name(addEmJs, "addEmJs");
        for (var name in moduleExports) {
          if (name.startsWith("__em_js__")) {
            var start = moduleExports[name];
            var jsString = UTF8ToString(start);
            var parts = jsString.split("<::>");
            addEmJs(name.replace("__em_js__", ""), parts[0], parts[1]);
            delete moduleExports[name];
          }
        }
        var applyRelocs = moduleExports["__wasm_apply_data_relocs"];
        if (applyRelocs) {
          if (runtimeInitialized) {
            applyRelocs();
          } else {
            __RELOC_FUNCS__.push(applyRelocs);
          }
        }
        var init = moduleExports["__wasm_call_ctors"];
        if (init) {
          if (runtimeInitialized) {
            init();
          } else {
            addOnPostCtor(init);
          }
        }
        return moduleExports;
      }
      __name(postInstantiation, "postInstantiation");
      if (flags.loadAsync) {
        return (async () => {
          var instance2;
          if (binary instanceof WebAssembly.Module) {
            instance2 = new WebAssembly.Instance(binary, info);
          } else {
            ({ module: binary, instance: instance2 } = await WebAssembly.instantiate(binary, info));
          }
          return postInstantiation(binary, instance2);
        })();
      }
      var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
      var instance = new WebAssembly.Instance(module, info);
      return postInstantiation(module, instance);
    }
    __name(loadModule, "loadModule");
    flags = {
      ...flags,
      rpath: {
        parentLibPath: libName,
        paths: metadata.runtimePaths
      }
    };
    if (flags.loadAsync) {
      return metadata.neededDynlibs.reduce((chain, dynNeeded) => chain.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
    }
    metadata.neededDynlibs.forEach((needed) => loadDynamicLibrary(needed, flags, localScope));
    return loadModule();
  }, "loadWebAssemblyModule");
  var mergeLibSymbols = /* @__PURE__ */ __name((exports, libName2) => {
    for (var [sym, exp] of Object.entries(exports)) {
      const setImport = /* @__PURE__ */ __name((target) => {
        if (!isSymbolDefined(target)) {
          wasmImports[target] = exp;
        }
      }, "setImport");
      setImport(sym);
      const main_alias = "__main_argc_argv";
      if (sym == "main") {
        setImport(main_alias);
      }
      if (sym == main_alias) {
        setImport("main");
      }
    }
  }, "mergeLibSymbols");
  var asyncLoad = /* @__PURE__ */ __name(async (url) => {
    var arrayBuffer = await readAsync(url);
    return new Uint8Array(arrayBuffer);
  }, "asyncLoad");
  function loadDynamicLibrary(libName2, flags2 = {
    global: true,
    nodelete: true
  }, localScope2, handle2) {
    var dso = LDSO.loadedLibsByName[libName2];
    if (dso) {
      if (!flags2.global) {
        if (localScope2) {
          Object.assign(localScope2, dso.exports);
        }
      } else if (!dso.global) {
        dso.global = true;
        mergeLibSymbols(dso.exports, libName2);
      }
      if (flags2.nodelete && dso.refcount !== Infinity) {
        dso.refcount = Infinity;
      }
      dso.refcount++;
      if (handle2) {
        LDSO.loadedLibsByHandle[handle2] = dso;
      }
      return flags2.loadAsync ? Promise.resolve(true) : true;
    }
    dso = newDSO(libName2, handle2, "loading");
    dso.refcount = flags2.nodelete ? Infinity : 1;
    dso.global = flags2.global;
    function loadLibData() {
      if (handle2) {
        var data = LE_HEAP_LOAD_U32((handle2 + 28 >> 2) * 4);
        var dataSize = LE_HEAP_LOAD_U32((handle2 + 32 >> 2) * 4);
        if (data && dataSize) {
          var libData = HEAP8.slice(data, data + dataSize);
          return flags2.loadAsync ? Promise.resolve(libData) : libData;
        }
      }
      var libFile = locateFile(libName2);
      if (flags2.loadAsync) {
        return asyncLoad(libFile);
      }
      if (!readBinary) {
        throw new Error(`${libFile}: file not found, and synchronous loading of external files is not available`);
      }
      return readBinary(libFile);
    }
    __name(loadLibData, "loadLibData");
    function getExports() {
      if (flags2.loadAsync) {
        return loadLibData().then((libData) => loadWebAssemblyModule(libData, flags2, libName2, localScope2, handle2));
      }
      return loadWebAssemblyModule(loadLibData(), flags2, libName2, localScope2, handle2);
    }
    __name(getExports, "getExports");
    function moduleLoaded(exports) {
      if (dso.global) {
        mergeLibSymbols(exports, libName2);
      } else if (localScope2) {
        Object.assign(localScope2, exports);
      }
      dso.exports = exports;
    }
    __name(moduleLoaded, "moduleLoaded");
    if (flags2.loadAsync) {
      return getExports().then((exports) => {
        moduleLoaded(exports);
        return true;
      });
    }
    moduleLoaded(getExports());
    return true;
  }
  __name(loadDynamicLibrary, "loadDynamicLibrary");
  var reportUndefinedSymbols = /* @__PURE__ */ __name(() => {
    for (var [symName, entry] of Object.entries(GOT)) {
      if (entry.value == 0) {
        var value = resolveGlobalSymbol(symName, true).sym;
        if (!value && !entry.required) {
          continue;
        }
        if (typeof value == "function") {
          entry.value = addFunction(value, value.sig);
        } else if (typeof value == "number") {
          entry.value = value;
        } else {
          throw new Error(`bad export type for '${symName}': ${typeof value}`);
        }
      }
    }
  }, "reportUndefinedSymbols");
  var runDependencies = 0;
  var dependenciesFulfilled = null;
  var removeRunDependency = /* @__PURE__ */ __name((id) => {
    runDependencies--;
    Module["monitorRunDependencies"]?.(runDependencies);
    if (runDependencies == 0) {
      if (dependenciesFulfilled) {
        var callback = dependenciesFulfilled;
        dependenciesFulfilled = null;
        callback();
      }
    }
  }, "removeRunDependency");
  var addRunDependency = /* @__PURE__ */ __name((id) => {
    runDependencies++;
    Module["monitorRunDependencies"]?.(runDependencies);
  }, "addRunDependency");
  var loadDylibs = /* @__PURE__ */ __name(async () => {
    if (!dynamicLibraries.length) {
      reportUndefinedSymbols();
      return;
    }
    addRunDependency("loadDylibs");
    for (var lib of dynamicLibraries) {
      await loadDynamicLibrary(lib, {
        loadAsync: true,
        global: true,
        nodelete: true,
        allowUndefined: true
      });
    }
    reportUndefinedSymbols();
    removeRunDependency("loadDylibs");
  }, "loadDylibs");
  var noExitRuntime = true;
  function setValue(ptr, value, type = "i8") {
    if (type.endsWith("*")) type = "*";
    switch (type) {
      case "i1":
        HEAP8[ptr] = value;
        break;
      case "i8":
        HEAP8[ptr] = value;
        break;
      case "i16":
        LE_HEAP_STORE_I16((ptr >> 1) * 2, value);
        break;
      case "i32":
        LE_HEAP_STORE_I32((ptr >> 2) * 4, value);
        break;
      case "i64":
        LE_HEAP_STORE_I64((ptr >> 3) * 8, BigInt(value));
        break;
      case "float":
        LE_HEAP_STORE_F32((ptr >> 2) * 4, value);
        break;
      case "double":
        LE_HEAP_STORE_F64((ptr >> 3) * 8, value);
        break;
      case "*":
        LE_HEAP_STORE_U32((ptr >> 2) * 4, value);
        break;
      default:
        abort(`invalid type for setValue: ${type}`);
    }
  }
  __name(setValue, "setValue");
  var ___memory_base = new WebAssembly.Global({
    "value": "i32",
    "mutable": false
  }, 1024);
  var ___stack_high = 78240;
  var ___stack_low = 12704;
  var ___stack_pointer = new WebAssembly.Global({
    "value": "i32",
    "mutable": true
  }, 78240);
  var ___table_base = new WebAssembly.Global({
    "value": "i32",
    "mutable": false
  }, 1);
  var __abort_js = /* @__PURE__ */ __name(() => abort(""), "__abort_js");
  __abort_js.sig = "v";
  var getHeapMax = /* @__PURE__ */ __name(() => (
    // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
    // full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
    // for any code that deals with heap sizes, which would require special
    // casing all heap size related code to treat 0 specially.
    2147483648
  ), "getHeapMax");
  var growMemory = /* @__PURE__ */ __name((size) => {
    var oldHeapSize = wasmMemory.buffer.byteLength;
    var pages = (size - oldHeapSize + 65535) / 65536 | 0;
    try {
      wasmMemory.grow(pages);
      updateMemoryViews();
      return 1;
    } catch (e) {
    }
  }, "growMemory");
  var _emscripten_resize_heap = /* @__PURE__ */ __name((requestedSize) => {
    var oldSize = HEAPU8.length;
    requestedSize >>>= 0;
    var maxHeapSize = getHeapMax();
    if (requestedSize > maxHeapSize) {
      return false;
    }
    for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
      var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
      overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
      var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
      var replacement = growMemory(newSize);
      if (replacement) {
        return true;
      }
    }
    return false;
  }, "_emscripten_resize_heap");
  _emscripten_resize_heap.sig = "ip";
  var _fd_close = /* @__PURE__ */ __name((fd) => 52, "_fd_close");
  _fd_close.sig = "ii";
  var INT53_MAX = 9007199254740992;
  var INT53_MIN = -9007199254740992;
  var bigintToI53Checked = /* @__PURE__ */ __name((num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num), "bigintToI53Checked");
  function _fd_seek(fd, offset, whence, newOffset) {
    offset = bigintToI53Checked(offset);
    return 70;
  }
  __name(_fd_seek, "_fd_seek");
  _fd_seek.sig = "iijip";
  var printCharBuffers = [null, [], []];
  var printChar = /* @__PURE__ */ __name((stream, curr) => {
    var buffer = printCharBuffers[stream];
    if (curr === 0 || curr === 10) {
      (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
      buffer.length = 0;
    } else {
      buffer.push(curr);
    }
  }, "printChar");
  var _fd_write = /* @__PURE__ */ __name((fd, iov, iovcnt, pnum) => {
    var num = 0;
    for (var i2 = 0; i2 < iovcnt; i2++) {
      var ptr = LE_HEAP_LOAD_U32((iov >> 2) * 4);
      var len = LE_HEAP_LOAD_U32((iov + 4 >> 2) * 4);
      iov += 8;
      for (var j = 0; j < len; j++) {
        printChar(fd, HEAPU8[ptr + j]);
      }
      num += len;
    }
    LE_HEAP_STORE_U32((pnum >> 2) * 4, num);
    return 0;
  }, "_fd_write");
  _fd_write.sig = "iippp";
  function _tree_sitter_log_callback(isLexMessage, messageAddress) {
    if (Module.currentLogCallback) {
      const message = UTF8ToString(messageAddress);
      Module.currentLogCallback(message, isLexMessage !== 0);
    }
  }
  __name(_tree_sitter_log_callback, "_tree_sitter_log_callback");
  function _tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress) {
    const INPUT_BUFFER_SIZE = 10 * 1024;
    const string = Module.currentParseCallback(index, {
      row,
      column
    });
    if (typeof string === "string") {
      setValue(lengthAddress, string.length, "i32");
      stringToUTF16(string, inputBufferAddress, INPUT_BUFFER_SIZE);
    } else {
      setValue(lengthAddress, 0, "i32");
    }
  }
  __name(_tree_sitter_parse_callback, "_tree_sitter_parse_callback");
  function _tree_sitter_progress_callback(currentOffset, hasError) {
    if (Module.currentProgressCallback) {
      return Module.currentProgressCallback({
        currentOffset,
        hasError
      });
    }
    return false;
  }
  __name(_tree_sitter_progress_callback, "_tree_sitter_progress_callback");
  function _tree_sitter_query_progress_callback(currentOffset) {
    if (Module.currentQueryProgressCallback) {
      return Module.currentQueryProgressCallback({
        currentOffset
      });
    }
    return false;
  }
  __name(_tree_sitter_query_progress_callback, "_tree_sitter_query_progress_callback");
  var runtimeKeepaliveCounter = 0;
  var keepRuntimeAlive = /* @__PURE__ */ __name(() => noExitRuntime || runtimeKeepaliveCounter > 0, "keepRuntimeAlive");
  var _proc_exit = /* @__PURE__ */ __name((code) => {
    EXITSTATUS = code;
    if (!keepRuntimeAlive()) {
      Module["onExit"]?.(code);
      ABORT = true;
    }
    quit_(code, new ExitStatus(code));
  }, "_proc_exit");
  _proc_exit.sig = "vi";
  var exitJS = /* @__PURE__ */ __name((status, implicit) => {
    EXITSTATUS = status;
    _proc_exit(status);
  }, "exitJS");
  var handleException = /* @__PURE__ */ __name((e) => {
    if (e instanceof ExitStatus || e == "unwind") {
      return EXITSTATUS;
    }
    quit_(1, e);
  }, "handleException");
  var lengthBytesUTF8 = /* @__PURE__ */ __name((str) => {
    var len = 0;
    for (var i2 = 0; i2 < str.length; ++i2) {
      var c = str.charCodeAt(i2);
      if (c <= 127) {
        len++;
      } else if (c <= 2047) {
        len += 2;
      } else if (c >= 55296 && c <= 57343) {
        len += 4;
        ++i2;
      } else {
        len += 3;
      }
    }
    return len;
  }, "lengthBytesUTF8");
  var stringToUTF8Array = /* @__PURE__ */ __name((str, heap, outIdx, maxBytesToWrite) => {
    if (!(maxBytesToWrite > 0)) return 0;
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite - 1;
    for (var i2 = 0; i2 < str.length; ++i2) {
      var u = str.codePointAt(i2);
      if (u <= 127) {
        if (outIdx >= endIdx) break;
        heap[outIdx++] = u;
      } else if (u <= 2047) {
        if (outIdx + 1 >= endIdx) break;
        heap[outIdx++] = 192 | u >> 6;
        heap[outIdx++] = 128 | u & 63;
      } else if (u <= 65535) {
        if (outIdx + 2 >= endIdx) break;
        heap[outIdx++] = 224 | u >> 12;
        heap[outIdx++] = 128 | u >> 6 & 63;
        heap[outIdx++] = 128 | u & 63;
      } else {
        if (outIdx + 3 >= endIdx) break;
        heap[outIdx++] = 240 | u >> 18;
        heap[outIdx++] = 128 | u >> 12 & 63;
        heap[outIdx++] = 128 | u >> 6 & 63;
        heap[outIdx++] = 128 | u & 63;
        i2++;
      }
    }
    heap[outIdx] = 0;
    return outIdx - startIdx;
  }, "stringToUTF8Array");
  var stringToUTF8 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite), "stringToUTF8");
  var stackAlloc = /* @__PURE__ */ __name((sz) => __emscripten_stack_alloc(sz), "stackAlloc");
  var stringToUTF8OnStack = /* @__PURE__ */ __name((str) => {
    var size = lengthBytesUTF8(str) + 1;
    var ret = stackAlloc(size);
    stringToUTF8(str, ret, size);
    return ret;
  }, "stringToUTF8OnStack");
  var AsciiToString = /* @__PURE__ */ __name((ptr) => {
    var str = "";
    while (1) {
      var ch = HEAPU8[ptr++];
      if (!ch) return str;
      str += String.fromCharCode(ch);
    }
  }, "AsciiToString");
  var stringToUTF16 = /* @__PURE__ */ __name((str, outPtr, maxBytesToWrite) => {
    maxBytesToWrite ??= 2147483647;
    if (maxBytesToWrite < 2) return 0;
    maxBytesToWrite -= 2;
    var startPtr = outPtr;
    var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
    for (var i2 = 0; i2 < numCharsToWrite; ++i2) {
      var codeUnit = str.charCodeAt(i2);
      LE_HEAP_STORE_I16((outPtr >> 1) * 2, codeUnit);
      outPtr += 2;
    }
    LE_HEAP_STORE_I16((outPtr >> 1) * 2, 0);
    return outPtr - startPtr;
  }, "stringToUTF16");
  LE_ATOMICS_NATIVE_BYTE_ORDER = new Int8Array(new Int16Array([1]).buffer)[0] === 1 ? [
    /* little endian */
    ((x) => x),
    ((x) => x),
    void 0,
    ((x) => x)
  ] : [
    /* big endian */
    ((x) => x),
    ((x) => ((x & 65280) << 8 | (x & 255) << 24) >> 16),
    void 0,
    ((x) => x >> 24 & 255 | x >> 8 & 65280 | (x & 65280) << 8 | (x & 255) << 24)
  ];
  function LE_HEAP_UPDATE() {
    HEAPU16.unsigned = ((x) => x & 65535);
    HEAPU32.unsigned = ((x) => x >>> 0);
  }
  __name(LE_HEAP_UPDATE, "LE_HEAP_UPDATE");
  {
    initMemory();
    if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
    if (Module["print"]) out = Module["print"];
    if (Module["printErr"]) err = Module["printErr"];
    if (Module["dynamicLibraries"]) dynamicLibraries = Module["dynamicLibraries"];
    if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
    if (Module["arguments"]) arguments_ = Module["arguments"];
    if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
    if (Module["preInit"]) {
      if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
      while (Module["preInit"].length > 0) {
        Module["preInit"].shift()();
      }
    }
  }
  Module["setValue"] = setValue;
  Module["getValue"] = getValue;
  Module["UTF8ToString"] = UTF8ToString;
  Module["stringToUTF8"] = stringToUTF8;
  Module["lengthBytesUTF8"] = lengthBytesUTF8;
  Module["AsciiToString"] = AsciiToString;
  Module["stringToUTF16"] = stringToUTF16;
  Module["loadWebAssemblyModule"] = loadWebAssemblyModule;
  Module["LE_HEAP_STORE_I64"] = LE_HEAP_STORE_I64;
  var ASM_CONSTS = {};
  var _malloc, _calloc, _realloc, _free, _ts_range_edit, _memcmp, _ts_language_symbol_count, _ts_language_state_count, _ts_language_abi_version, _ts_language_name, _ts_language_field_count, _ts_language_next_state, _ts_language_symbol_name, _ts_language_symbol_for_name, _strncmp, _ts_language_symbol_type, _ts_language_field_name_for_id, _ts_lookahead_iterator_new, _ts_lookahead_iterator_delete, _ts_lookahead_iterator_reset_state, _ts_lookahead_iterator_reset, _ts_lookahead_iterator_next, _ts_lookahead_iterator_current_symbol, _ts_point_edit, _ts_parser_delete, _ts_parser_reset, _ts_parser_set_language, _ts_parser_set_included_ranges, _ts_query_new, _ts_query_delete, _iswspace, _iswalnum, _ts_query_pattern_count, _ts_query_capture_count, _ts_query_string_count, _ts_query_capture_name_for_id, _ts_query_capture_quantifier_for_id, _ts_query_string_value_for_id, _ts_query_predicates_for_pattern, _ts_query_start_byte_for_pattern, _ts_query_end_byte_for_pattern, _ts_query_is_pattern_rooted, _ts_query_is_pattern_non_local, _ts_query_is_pattern_guaranteed_at_step, _ts_query_disable_capture, _ts_query_disable_pattern, _ts_tree_copy, _ts_tree_delete, _ts_init, _ts_parser_new_wasm, _ts_parser_enable_logger_wasm, _ts_parser_parse_wasm, _ts_parser_included_ranges_wasm, _ts_language_type_is_named_wasm, _ts_language_type_is_visible_wasm, _ts_language_metadata_wasm, _ts_language_supertypes_wasm, _ts_language_subtypes_wasm, _ts_tree_root_node_wasm, _ts_tree_root_node_with_offset_wasm, _ts_tree_edit_wasm, _ts_tree_included_ranges_wasm, _ts_tree_get_changed_ranges_wasm, _ts_tree_cursor_new_wasm, _ts_tree_cursor_copy_wasm, _ts_tree_cursor_delete_wasm, _ts_tree_cursor_reset_wasm, _ts_tree_cursor_reset_to_wasm, _ts_tree_cursor_goto_first_child_wasm, _ts_tree_cursor_goto_last_child_wasm, _ts_tree_cursor_goto_first_child_for_index_wasm, _ts_tree_cursor_goto_first_child_for_position_wasm, _ts_tree_cursor_goto_next_sibling_wasm, _ts_tree_cursor_goto_previous_sibling_wasm, _ts_tree_cursor_goto_descendant_wasm, _ts_tree_cursor_goto_parent_wasm, _ts_tree_cursor_current_node_type_id_wasm, _ts_tree_cursor_current_node_state_id_wasm, _ts_tree_cursor_current_node_is_named_wasm, _ts_tree_cursor_current_node_is_missing_wasm, _ts_tree_cursor_current_node_id_wasm, _ts_tree_cursor_start_position_wasm, _ts_tree_cursor_end_position_wasm, _ts_tree_cursor_start_index_wasm, _ts_tree_cursor_end_index_wasm, _ts_tree_cursor_current_field_id_wasm, _ts_tree_cursor_current_depth_wasm, _ts_tree_cursor_current_descendant_index_wasm, _ts_tree_cursor_current_node_wasm, _ts_node_symbol_wasm, _ts_node_field_name_for_child_wasm, _ts_node_field_name_for_named_child_wasm, _ts_node_children_by_field_id_wasm, _ts_node_first_child_for_byte_wasm, _ts_node_first_named_child_for_byte_wasm, _ts_node_grammar_symbol_wasm, _ts_node_child_count_wasm, _ts_node_named_child_count_wasm, _ts_node_child_wasm, _ts_node_named_child_wasm, _ts_node_child_by_field_id_wasm, _ts_node_next_sibling_wasm, _ts_node_prev_sibling_wasm, _ts_node_next_named_sibling_wasm, _ts_node_prev_named_sibling_wasm, _ts_node_descendant_count_wasm, _ts_node_parent_wasm, _ts_node_child_with_descendant_wasm, _ts_node_descendant_for_index_wasm, _ts_node_named_descendant_for_index_wasm, _ts_node_descendant_for_position_wasm, _ts_node_named_descendant_for_position_wasm, _ts_node_start_point_wasm, _ts_node_end_point_wasm, _ts_node_start_index_wasm, _ts_node_end_index_wasm, _ts_node_to_string_wasm, _ts_node_children_wasm, _ts_node_named_children_wasm, _ts_node_descendants_of_type_wasm, _ts_node_is_named_wasm, _ts_node_has_changes_wasm, _ts_node_has_error_wasm, _ts_node_is_error_wasm, _ts_node_is_missing_wasm, _ts_node_is_extra_wasm, _ts_node_parse_state_wasm, _ts_node_next_parse_state_wasm, _ts_query_matches_wasm, _ts_query_captures_wasm, _memset, _memcpy, _memmove, _iswalpha, _iswblank, _iswdigit, _iswlower, _iswupper, _iswxdigit, _memchr, _strlen, _strcmp, _strncat, _strncpy, _towlower, _towupper, _setThrew, __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current, ___wasm_apply_data_relocs;
  function assignWasmExports(wasmExports2) {
    Module["_malloc"] = _malloc = wasmExports2["malloc"];
    Module["_calloc"] = _calloc = wasmExports2["calloc"];
    Module["_realloc"] = _realloc = wasmExports2["realloc"];
    Module["_free"] = _free = wasmExports2["free"];
    Module["_ts_range_edit"] = _ts_range_edit = wasmExports2["ts_range_edit"];
    Module["_memcmp"] = _memcmp = wasmExports2["memcmp"];
    Module["_ts_language_symbol_count"] = _ts_language_symbol_count = wasmExports2["ts_language_symbol_count"];
    Module["_ts_language_state_count"] = _ts_language_state_count = wasmExports2["ts_language_state_count"];
    Module["_ts_language_abi_version"] = _ts_language_abi_version = wasmExports2["ts_language_abi_version"];
    Module["_ts_language_name"] = _ts_language_name = wasmExports2["ts_language_name"];
    Module["_ts_language_field_count"] = _ts_language_field_count = wasmExports2["ts_language_field_count"];
    Module["_ts_language_next_state"] = _ts_language_next_state = wasmExports2["ts_language_next_state"];
    Module["_ts_language_symbol_name"] = _ts_language_symbol_name = wasmExports2["ts_language_symbol_name"];
    Module["_ts_language_symbol_for_name"] = _ts_language_symbol_for_name = wasmExports2["ts_language_symbol_for_name"];
    Module["_strncmp"] = _strncmp = wasmExports2["strncmp"];
    Module["_ts_language_symbol_type"] = _ts_language_symbol_type = wasmExports2["ts_language_symbol_type"];
    Module["_ts_language_field_name_for_id"] = _ts_language_field_name_for_id = wasmExports2["ts_language_field_name_for_id"];
    Module["_ts_lookahead_iterator_new"] = _ts_lookahead_iterator_new = wasmExports2["ts_lookahead_iterator_new"];
    Module["_ts_lookahead_iterator_delete"] = _ts_lookahead_iterator_delete = wasmExports2["ts_lookahead_iterator_delete"];
    Module["_ts_lookahead_iterator_reset_state"] = _ts_lookahead_iterator_reset_state = wasmExports2["ts_lookahead_iterator_reset_state"];
    Module["_ts_lookahead_iterator_reset"] = _ts_lookahead_iterator_reset = wasmExports2["ts_lookahead_iterator_reset"];
    Module["_ts_lookahead_iterator_next"] = _ts_lookahead_iterator_next = wasmExports2["ts_lookahead_iterator_next"];
    Module["_ts_lookahead_iterator_current_symbol"] = _ts_lookahead_iterator_current_symbol = wasmExports2["ts_lookahead_iterator_current_symbol"];
    Module["_ts_point_edit"] = _ts_point_edit = wasmExports2["ts_point_edit"];
    Module["_ts_parser_delete"] = _ts_parser_delete = wasmExports2["ts_parser_delete"];
    Module["_ts_parser_reset"] = _ts_parser_reset = wasmExports2["ts_parser_reset"];
    Module["_ts_parser_set_language"] = _ts_parser_set_language = wasmExports2["ts_parser_set_language"];
    Module["_ts_parser_set_included_ranges"] = _ts_parser_set_included_ranges = wasmExports2["ts_parser_set_included_ranges"];
    Module["_ts_query_new"] = _ts_query_new = wasmExports2["ts_query_new"];
    Module["_ts_query_delete"] = _ts_query_delete = wasmExports2["ts_query_delete"];
    Module["_iswspace"] = _iswspace = wasmExports2["iswspace"];
    Module["_iswalnum"] = _iswalnum = wasmExports2["iswalnum"];
    Module["_ts_query_pattern_count"] = _ts_query_pattern_count = wasmExports2["ts_query_pattern_count"];
    Module["_ts_query_capture_count"] = _ts_query_capture_count = wasmExports2["ts_query_capture_count"];
    Module["_ts_query_string_count"] = _ts_query_string_count = wasmExports2["ts_query_string_count"];
    Module["_ts_query_capture_name_for_id"] = _ts_query_capture_name_for_id = wasmExports2["ts_query_capture_name_for_id"];
    Module["_ts_query_capture_quantifier_for_id"] = _ts_query_capture_quantifier_for_id = wasmExports2["ts_query_capture_quantifier_for_id"];
    Module["_ts_query_string_value_for_id"] = _ts_query_string_value_for_id = wasmExports2["ts_query_string_value_for_id"];
    Module["_ts_query_predicates_for_pattern"] = _ts_query_predicates_for_pattern = wasmExports2["ts_query_predicates_for_pattern"];
    Module["_ts_query_start_byte_for_pattern"] = _ts_query_start_byte_for_pattern = wasmExports2["ts_query_start_byte_for_pattern"];
    Module["_ts_query_end_byte_for_pattern"] = _ts_query_end_byte_for_pattern = wasmExports2["ts_query_end_byte_for_pattern"];
    Module["_ts_query_is_pattern_rooted"] = _ts_query_is_pattern_rooted = wasmExports2["ts_query_is_pattern_rooted"];
    Module["_ts_query_is_pattern_non_local"] = _ts_query_is_pattern_non_local = wasmExports2["ts_query_is_pattern_non_local"];
    Module["_ts_query_is_pattern_guaranteed_at_step"] = _ts_query_is_pattern_guaranteed_at_step = wasmExports2["ts_query_is_pattern_guaranteed_at_step"];
    Module["_ts_query_disable_capture"] = _ts_query_disable_capture = wasmExports2["ts_query_disable_capture"];
    Module["_ts_query_disable_pattern"] = _ts_query_disable_pattern = wasmExports2["ts_query_disable_pattern"];
    Module["_ts_tree_copy"] = _ts_tree_copy = wasmExports2["ts_tree_copy"];
    Module["_ts_tree_delete"] = _ts_tree_delete = wasmExports2["ts_tree_delete"];
    Module["_ts_init"] = _ts_init = wasmExports2["ts_init"];
    Module["_ts_parser_new_wasm"] = _ts_parser_new_wasm = wasmExports2["ts_parser_new_wasm"];
    Module["_ts_parser_enable_logger_wasm"] = _ts_parser_enable_logger_wasm = wasmExports2["ts_parser_enable_logger_wasm"];
    Module["_ts_parser_parse_wasm"] = _ts_parser_parse_wasm = wasmExports2["ts_parser_parse_wasm"];
    Module["_ts_parser_included_ranges_wasm"] = _ts_parser_included_ranges_wasm = wasmExports2["ts_parser_included_ranges_wasm"];
    Module["_ts_language_type_is_named_wasm"] = _ts_language_type_is_named_wasm = wasmExports2["ts_language_type_is_named_wasm"];
    Module["_ts_language_type_is_visible_wasm"] = _ts_language_type_is_visible_wasm = wasmExports2["ts_language_type_is_visible_wasm"];
    Module["_ts_language_metadata_wasm"] = _ts_language_metadata_wasm = wasmExports2["ts_language_metadata_wasm"];
    Module["_ts_language_supertypes_wasm"] = _ts_language_supertypes_wasm = wasmExports2["ts_language_supertypes_wasm"];
    Module["_ts_language_subtypes_wasm"] = _ts_language_subtypes_wasm = wasmExports2["ts_language_subtypes_wasm"];
    Module["_ts_tree_root_node_wasm"] = _ts_tree_root_node_wasm = wasmExports2["ts_tree_root_node_wasm"];
    Module["_ts_tree_root_node_with_offset_wasm"] = _ts_tree_root_node_with_offset_wasm = wasmExports2["ts_tree_root_node_with_offset_wasm"];
    Module["_ts_tree_edit_wasm"] = _ts_tree_edit_wasm = wasmExports2["ts_tree_edit_wasm"];
    Module["_ts_tree_included_ranges_wasm"] = _ts_tree_included_ranges_wasm = wasmExports2["ts_tree_included_ranges_wasm"];
    Module["_ts_tree_get_changed_ranges_wasm"] = _ts_tree_get_changed_ranges_wasm = wasmExports2["ts_tree_get_changed_ranges_wasm"];
    Module["_ts_tree_cursor_new_wasm"] = _ts_tree_cursor_new_wasm = wasmExports2["ts_tree_cursor_new_wasm"];
    Module["_ts_tree_cursor_copy_wasm"] = _ts_tree_cursor_copy_wasm = wasmExports2["ts_tree_cursor_copy_wasm"];
    Module["_ts_tree_cursor_delete_wasm"] = _ts_tree_cursor_delete_wasm = wasmExports2["ts_tree_cursor_delete_wasm"];
    Module["_ts_tree_cursor_reset_wasm"] = _ts_tree_cursor_reset_wasm = wasmExports2["ts_tree_cursor_reset_wasm"];
    Module["_ts_tree_cursor_reset_to_wasm"] = _ts_tree_cursor_reset_to_wasm = wasmExports2["ts_tree_cursor_reset_to_wasm"];
    Module["_ts_tree_cursor_goto_first_child_wasm"] = _ts_tree_cursor_goto_first_child_wasm = wasmExports2["ts_tree_cursor_goto_first_child_wasm"];
    Module["_ts_tree_cursor_goto_last_child_wasm"] = _ts_tree_cursor_goto_last_child_wasm = wasmExports2["ts_tree_cursor_goto_last_child_wasm"];
    Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = _ts_tree_cursor_goto_first_child_for_index_wasm = wasmExports2["ts_tree_cursor_goto_first_child_for_index_wasm"];
    Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = _ts_tree_cursor_goto_first_child_for_position_wasm = wasmExports2["ts_tree_cursor_goto_first_child_for_position_wasm"];
    Module["_ts_tree_cursor_goto_next_sibling_wasm"] = _ts_tree_cursor_goto_next_sibling_wasm = wasmExports2["ts_tree_cursor_goto_next_sibling_wasm"];
    Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = _ts_tree_cursor_goto_previous_sibling_wasm = wasmExports2["ts_tree_cursor_goto_previous_sibling_wasm"];
    Module["_ts_tree_cursor_goto_descendant_wasm"] = _ts_tree_cursor_goto_descendant_wasm = wasmExports2["ts_tree_cursor_goto_descendant_wasm"];
    Module["_ts_tree_cursor_goto_parent_wasm"] = _ts_tree_cursor_goto_parent_wasm = wasmExports2["ts_tree_cursor_goto_parent_wasm"];
    Module["_ts_tree_cursor_current_node_type_id_wasm"] = _ts_tree_cursor_current_node_type_id_wasm = wasmExports2["ts_tree_cursor_current_node_type_id_wasm"];
    Module["_ts_tree_cursor_current_node_state_id_wasm"] = _ts_tree_cursor_current_node_state_id_wasm = wasmExports2["ts_tree_cursor_current_node_state_id_wasm"];
    Module["_ts_tree_cursor_current_node_is_named_wasm"] = _ts_tree_cursor_current_node_is_named_wasm = wasmExports2["ts_tree_cursor_current_node_is_named_wasm"];
    Module["_ts_tree_cursor_current_node_is_missing_wasm"] = _ts_tree_cursor_current_node_is_missing_wasm = wasmExports2["ts_tree_cursor_current_node_is_missing_wasm"];
    Module["_ts_tree_cursor_current_node_id_wasm"] = _ts_tree_cursor_current_node_id_wasm = wasmExports2["ts_tree_cursor_current_node_id_wasm"];
    Module["_ts_tree_cursor_start_position_wasm"] = _ts_tree_cursor_start_position_wasm = wasmExports2["ts_tree_cursor_start_position_wasm"];
    Module["_ts_tree_cursor_end_position_wasm"] = _ts_tree_cursor_end_position_wasm = wasmExports2["ts_tree_cursor_end_position_wasm"];
    Module["_ts_tree_cursor_start_index_wasm"] = _ts_tree_cursor_start_index_wasm = wasmExports2["ts_tree_cursor_start_index_wasm"];
    Module["_ts_tree_cursor_end_index_wasm"] = _ts_tree_cursor_end_index_wasm = wasmExports2["ts_tree_cursor_end_index_wasm"];
    Module["_ts_tree_cursor_current_field_id_wasm"] = _ts_tree_cursor_current_field_id_wasm = wasmExports2["ts_tree_cursor_current_field_id_wasm"];
    Module["_ts_tree_cursor_current_depth_wasm"] = _ts_tree_cursor_current_depth_wasm = wasmExports2["ts_tree_cursor_current_depth_wasm"];
    Module["_ts_tree_cursor_current_descendant_index_wasm"] = _ts_tree_cursor_current_descendant_index_wasm = wasmExports2["ts_tree_cursor_current_descendant_index_wasm"];
    Module["_ts_tree_cursor_current_node_wasm"] = _ts_tree_cursor_current_node_wasm = wasmExports2["ts_tree_cursor_current_node_wasm"];
    Module["_ts_node_symbol_wasm"] = _ts_node_symbol_wasm = wasmExports2["ts_node_symbol_wasm"];
    Module["_ts_node_field_name_for_child_wasm"] = _ts_node_field_name_for_child_wasm = wasmExports2["ts_node_field_name_for_child_wasm"];
    Module["_ts_node_field_name_for_named_child_wasm"] = _ts_node_field_name_for_named_child_wasm = wasmExports2["ts_node_field_name_for_named_child_wasm"];
    Module["_ts_node_children_by_field_id_wasm"] = _ts_node_children_by_field_id_wasm = wasmExports2["ts_node_children_by_field_id_wasm"];
    Module["_ts_node_first_child_for_byte_wasm"] = _ts_node_first_child_for_byte_wasm = wasmExports2["ts_node_first_child_for_byte_wasm"];
    Module["_ts_node_first_named_child_for_byte_wasm"] = _ts_node_first_named_child_for_byte_wasm = wasmExports2["ts_node_first_named_child_for_byte_wasm"];
    Module["_ts_node_grammar_symbol_wasm"] = _ts_node_grammar_symbol_wasm = wasmExports2["ts_node_grammar_symbol_wasm"];
    Module["_ts_node_child_count_wasm"] = _ts_node_child_count_wasm = wasmExports2["ts_node_child_count_wasm"];
    Module["_ts_node_named_child_count_wasm"] = _ts_node_named_child_count_wasm = wasmExports2["ts_node_named_child_count_wasm"];
    Module["_ts_node_child_wasm"] = _ts_node_child_wasm = wasmExports2["ts_node_child_wasm"];
    Module["_ts_node_named_child_wasm"] = _ts_node_named_child_wasm = wasmExports2["ts_node_named_child_wasm"];
    Module["_ts_node_child_by_field_id_wasm"] = _ts_node_child_by_field_id_wasm = wasmExports2["ts_node_child_by_field_id_wasm"];
    Module["_ts_node_next_sibling_wasm"] = _ts_node_next_sibling_wasm = wasmExports2["ts_node_next_sibling_wasm"];
    Module["_ts_node_prev_sibling_wasm"] = _ts_node_prev_sibling_wasm = wasmExports2["ts_node_prev_sibling_wasm"];
    Module["_ts_node_next_named_sibling_wasm"] = _ts_node_next_named_sibling_wasm = wasmExports2["ts_node_next_named_sibling_wasm"];
    Module["_ts_node_prev_named_sibling_wasm"] = _ts_node_prev_named_sibling_wasm = wasmExports2["ts_node_prev_named_sibling_wasm"];
    Module["_ts_node_descendant_count_wasm"] = _ts_node_descendant_count_wasm = wasmExports2["ts_node_descendant_count_wasm"];
    Module["_ts_node_parent_wasm"] = _ts_node_parent_wasm = wasmExports2["ts_node_parent_wasm"];
    Module["_ts_node_child_with_descendant_wasm"] = _ts_node_child_with_descendant_wasm = wasmExports2["ts_node_child_with_descendant_wasm"];
    Module["_ts_node_descendant_for_index_wasm"] = _ts_node_descendant_for_index_wasm = wasmExports2["ts_node_descendant_for_index_wasm"];
    Module["_ts_node_named_descendant_for_index_wasm"] = _ts_node_named_descendant_for_index_wasm = wasmExports2["ts_node_named_descendant_for_index_wasm"];
    Module["_ts_node_descendant_for_position_wasm"] = _ts_node_descendant_for_position_wasm = wasmExports2["ts_node_descendant_for_position_wasm"];
    Module["_ts_node_named_descendant_for_position_wasm"] = _ts_node_named_descendant_for_position_wasm = wasmExports2["ts_node_named_descendant_for_position_wasm"];
    Module["_ts_node_start_point_wasm"] = _ts_node_start_point_wasm = wasmExports2["ts_node_start_point_wasm"];
    Module["_ts_node_end_point_wasm"] = _ts_node_end_point_wasm = wasmExports2["ts_node_end_point_wasm"];
    Module["_ts_node_start_index_wasm"] = _ts_node_start_index_wasm = wasmExports2["ts_node_start_index_wasm"];
    Module["_ts_node_end_index_wasm"] = _ts_node_end_index_wasm = wasmExports2["ts_node_end_index_wasm"];
    Module["_ts_node_to_string_wasm"] = _ts_node_to_string_wasm = wasmExports2["ts_node_to_string_wasm"];
    Module["_ts_node_children_wasm"] = _ts_node_children_wasm = wasmExports2["ts_node_children_wasm"];
    Module["_ts_node_named_children_wasm"] = _ts_node_named_children_wasm = wasmExports2["ts_node_named_children_wasm"];
    Module["_ts_node_descendants_of_type_wasm"] = _ts_node_descendants_of_type_wasm = wasmExports2["ts_node_descendants_of_type_wasm"];
    Module["_ts_node_is_named_wasm"] = _ts_node_is_named_wasm = wasmExports2["ts_node_is_named_wasm"];
    Module["_ts_node_has_changes_wasm"] = _ts_node_has_changes_wasm = wasmExports2["ts_node_has_changes_wasm"];
    Module["_ts_node_has_error_wasm"] = _ts_node_has_error_wasm = wasmExports2["ts_node_has_error_wasm"];
    Module["_ts_node_is_error_wasm"] = _ts_node_is_error_wasm = wasmExports2["ts_node_is_error_wasm"];
    Module["_ts_node_is_missing_wasm"] = _ts_node_is_missing_wasm = wasmExports2["ts_node_is_missing_wasm"];
    Module["_ts_node_is_extra_wasm"] = _ts_node_is_extra_wasm = wasmExports2["ts_node_is_extra_wasm"];
    Module["_ts_node_parse_state_wasm"] = _ts_node_parse_state_wasm = wasmExports2["ts_node_parse_state_wasm"];
    Module["_ts_node_next_parse_state_wasm"] = _ts_node_next_parse_state_wasm = wasmExports2["ts_node_next_parse_state_wasm"];
    Module["_ts_query_matches_wasm"] = _ts_query_matches_wasm = wasmExports2["ts_query_matches_wasm"];
    Module["_ts_query_captures_wasm"] = _ts_query_captures_wasm = wasmExports2["ts_query_captures_wasm"];
    Module["_memset"] = _memset = wasmExports2["memset"];
    Module["_memcpy"] = _memcpy = wasmExports2["memcpy"];
    Module["_memmove"] = _memmove = wasmExports2["memmove"];
    Module["_iswalpha"] = _iswalpha = wasmExports2["iswalpha"];
    Module["_iswblank"] = _iswblank = wasmExports2["iswblank"];
    Module["_iswdigit"] = _iswdigit = wasmExports2["iswdigit"];
    Module["_iswlower"] = _iswlower = wasmExports2["iswlower"];
    Module["_iswupper"] = _iswupper = wasmExports2["iswupper"];
    Module["_iswxdigit"] = _iswxdigit = wasmExports2["iswxdigit"];
    Module["_memchr"] = _memchr = wasmExports2["memchr"];
    Module["_strlen"] = _strlen = wasmExports2["strlen"];
    Module["_strcmp"] = _strcmp = wasmExports2["strcmp"];
    Module["_strncat"] = _strncat = wasmExports2["strncat"];
    Module["_strncpy"] = _strncpy = wasmExports2["strncpy"];
    Module["_towlower"] = _towlower = wasmExports2["towlower"];
    Module["_towupper"] = _towupper = wasmExports2["towupper"];
    _setThrew = wasmExports2["setThrew"];
    __emscripten_stack_restore = wasmExports2["_emscripten_stack_restore"];
    __emscripten_stack_alloc = wasmExports2["_emscripten_stack_alloc"];
    _emscripten_stack_get_current = wasmExports2["emscripten_stack_get_current"];
    ___wasm_apply_data_relocs = wasmExports2["__wasm_apply_data_relocs"];
  }
  __name(assignWasmExports, "assignWasmExports");
  var wasmImports = {
    /** @export */
    __heap_base: ___heap_base,
    /** @export */
    __indirect_function_table: wasmTable,
    /** @export */
    __memory_base: ___memory_base,
    /** @export */
    __stack_high: ___stack_high,
    /** @export */
    __stack_low: ___stack_low,
    /** @export */
    __stack_pointer: ___stack_pointer,
    /** @export */
    __table_base: ___table_base,
    /** @export */
    _abort_js: __abort_js,
    /** @export */
    emscripten_resize_heap: _emscripten_resize_heap,
    /** @export */
    fd_close: _fd_close,
    /** @export */
    fd_seek: _fd_seek,
    /** @export */
    fd_write: _fd_write,
    /** @export */
    memory: wasmMemory,
    /** @export */
    tree_sitter_log_callback: _tree_sitter_log_callback,
    /** @export */
    tree_sitter_parse_callback: _tree_sitter_parse_callback,
    /** @export */
    tree_sitter_progress_callback: _tree_sitter_progress_callback,
    /** @export */
    tree_sitter_query_progress_callback: _tree_sitter_query_progress_callback
  };
  function callMain(args2 = []) {
    var entryFunction = resolveGlobalSymbol("main").sym;
    if (!entryFunction) return;
    args2.unshift(thisProgram);
    var argc = args2.length;
    var argv = stackAlloc((argc + 1) * 4);
    var argv_ptr = argv;
    args2.forEach((arg) => {
      LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, stringToUTF8OnStack(arg));
      argv_ptr += 4;
    });
    LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, 0);
    try {
      var ret = entryFunction(argc, argv);
      exitJS(
        ret,
        /* implicit = */
        true
      );
      return ret;
    } catch (e) {
      return handleException(e);
    }
  }
  __name(callMain, "callMain");
  function run(args2 = arguments_) {
    if (runDependencies > 0) {
      dependenciesFulfilled = run;
      return;
    }
    preRun();
    if (runDependencies > 0) {
      dependenciesFulfilled = run;
      return;
    }
    function doRun() {
      Module["calledRun"] = true;
      if (ABORT) return;
      initRuntime();
      preMain();
      readyPromiseResolve?.(Module);
      Module["onRuntimeInitialized"]?.();
      var noInitialRun = Module["noInitialRun"] || false;
      if (!noInitialRun) callMain(args2);
      postRun();
    }
    __name(doRun, "doRun");
    if (Module["setStatus"]) {
      Module["setStatus"]("Running...");
      setTimeout(() => {
        setTimeout(() => Module["setStatus"](""), 1);
        doRun();
      }, 1);
    } else {
      doRun();
    }
  }
  __name(run, "run");
  var wasmExports;
  wasmExports = await createWasm();
  run();
  if (runtimeInitialized) {
    moduleRtn = Module;
  } else {
    moduleRtn = new Promise((resolve3, reject) => {
      readyPromiseResolve = resolve3;
      readyPromiseReject = reject;
    });
  }
  return moduleRtn;
}
__name(Module2, "Module");
var web_tree_sitter_default = Module2;
var Module3 = null;
async function initializeBinding(moduleOptions) {
  return Module3 ??= await web_tree_sitter_default(moduleOptions);
}
__name(initializeBinding, "initializeBinding");
function checkModule() {
  return !!Module3;
}
__name(checkModule, "checkModule");
var TRANSFER_BUFFER;
var LANGUAGE_VERSION;
var MIN_COMPATIBLE_VERSION;
var Parser = class {
  static {
    __name(this, "Parser");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  [1] = 0;
  // Internal handle for Wasm
  /** @internal */
  logCallback = null;
  /** The parser's current language. */
  language = null;
  /**
   * This must always be called before creating a Parser.
   *
   * You can optionally pass in options to configure the Wasm module, the most common
   * one being `locateFile` to help the module find the `.wasm` file.
   */
  static async init(moduleOptions) {
    setModule(await initializeBinding(moduleOptions));
    TRANSFER_BUFFER = C._ts_init();
    LANGUAGE_VERSION = C.getValue(TRANSFER_BUFFER, "i32");
    MIN_COMPATIBLE_VERSION = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
  }
  /**
   * Create a new parser.
   */
  constructor() {
    this.initialize();
  }
  /** @internal */
  initialize() {
    if (!checkModule()) {
      throw new Error("cannot construct a Parser before calling `init()`");
    }
    C._ts_parser_new_wasm();
    this[0] = C.getValue(TRANSFER_BUFFER, "i32");
    this[1] = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
  }
  /** Delete the parser, freeing its resources. */
  delete() {
    C._ts_parser_delete(this[0]);
    C._free(this[1]);
    this[0] = 0;
    this[1] = 0;
  }
  /**
   * Set the language that the parser should use for parsing.
   *
   * If the language was not successfully assigned, an error will be thrown.
   * This happens if the language was generated with an incompatible
   * version of the Tree-sitter CLI. Check the language's version using
   * {@link Language#version} and compare it to this library's
   * {@link LANGUAGE_VERSION} and {@link MIN_COMPATIBLE_VERSION} constants.
   */
  setLanguage(language) {
    let address;
    if (!language) {
      address = 0;
      this.language = null;
    } else if (language.constructor === Language) {
      address = language[0];
      const version = C._ts_language_abi_version(address);
      if (version < MIN_COMPATIBLE_VERSION || LANGUAGE_VERSION < version) {
        throw new Error(
          `Incompatible language version ${version}. Compatibility range ${MIN_COMPATIBLE_VERSION} through ${LANGUAGE_VERSION}.`
        );
      }
      this.language = language;
    } else {
      throw new Error("Argument must be a Language");
    }
    C._ts_parser_set_language(this[0], address);
    return this;
  }
  /**
   * Parse a slice of UTF8 text.
   *
   * @param {string | ParseCallback} callback - The UTF8-encoded text to parse or a callback function.
   *
   * @param {Tree | null} [oldTree] - A previous syntax tree parsed from the same document. If the text of the
   *   document has changed since `oldTree` was created, then you must edit `oldTree` to match
   *   the new text using {@link Tree#edit}.
   *
   * @param {ParseOptions} [options] - Options for parsing the text.
   *  This can be used to set the included ranges, or a progress callback.
   *
   * @returns {Tree | null} A {@link Tree} if parsing succeeded, or `null` if:
   *  - The parser has not yet had a language assigned with {@link Parser#setLanguage}.
   *  - The progress callback returned true.
   */
  parse(callback, oldTree, options) {
    if (typeof callback === "string") {
      C.currentParseCallback = (index) => callback.slice(index);
    } else if (typeof callback === "function") {
      C.currentParseCallback = callback;
    } else {
      throw new Error("Argument must be a string or a function");
    }
    if (options?.progressCallback) {
      C.currentProgressCallback = options.progressCallback;
    } else {
      C.currentProgressCallback = null;
    }
    if (this.logCallback) {
      C.currentLogCallback = this.logCallback;
      C._ts_parser_enable_logger_wasm(this[0], 1);
    } else {
      C.currentLogCallback = null;
      C._ts_parser_enable_logger_wasm(this[0], 0);
    }
    let rangeCount = 0;
    let rangeAddress = 0;
    if (options?.includedRanges) {
      rangeCount = options.includedRanges.length;
      rangeAddress = C._calloc(rangeCount, SIZE_OF_RANGE);
      let address = rangeAddress;
      for (let i2 = 0; i2 < rangeCount; i2++) {
        marshalRange(address, options.includedRanges[i2]);
        address += SIZE_OF_RANGE;
      }
    }
    const treeAddress = C._ts_parser_parse_wasm(
      this[0],
      this[1],
      oldTree ? oldTree[0] : 0,
      rangeAddress,
      rangeCount
    );
    if (!treeAddress) {
      C.currentParseCallback = null;
      C.currentLogCallback = null;
      C.currentProgressCallback = null;
      return null;
    }
    if (!this.language) {
      throw new Error("Parser must have a language to parse");
    }
    const result = new Tree(INTERNAL, treeAddress, this.language, C.currentParseCallback);
    C.currentParseCallback = null;
    C.currentLogCallback = null;
    C.currentProgressCallback = null;
    return result;
  }
  /**
   * Instruct the parser to start the next parse from the beginning.
   *
   * If the parser previously failed because of a callback, 
   * then by default, it will resume where it left off on the
   * next call to {@link Parser#parse} or other parsing functions.
   * If you don't want to resume, and instead intend to use this parser to
   * parse some other document, you must call `reset` first.
   */
  reset() {
    C._ts_parser_reset(this[0]);
  }
  /** Get the ranges of text that the parser will include when parsing. */
  getIncludedRanges() {
    C._ts_parser_included_ranges_wasm(this[0]);
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const buffer = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const result = new Array(count);
    if (count > 0) {
      let address = buffer;
      for (let i2 = 0; i2 < count; i2++) {
        result[i2] = unmarshalRange(address);
        address += SIZE_OF_RANGE;
      }
      C._free(buffer);
    }
    return result;
  }
  /** Set the logging callback that a parser should use during parsing. */
  setLogger(callback) {
    if (!callback) {
      this.logCallback = null;
    } else if (typeof callback !== "function") {
      throw new Error("Logger callback must be a function");
    } else {
      this.logCallback = callback;
    }
    return this;
  }
  /** Get the parser's current logger. */
  getLogger() {
    return this.logCallback;
  }
};
var PREDICATE_STEP_TYPE_CAPTURE = 1;
var PREDICATE_STEP_TYPE_STRING = 2;
var QUERY_WORD_REGEX = /[\w-]+/g;
var CaptureQuantifier = {
  Zero: 0,
  ZeroOrOne: 1,
  ZeroOrMore: 2,
  One: 3,
  OneOrMore: 4
};
var isCaptureStep = /* @__PURE__ */ __name((step) => step.type === "capture", "isCaptureStep");
var isStringStep = /* @__PURE__ */ __name((step) => step.type === "string", "isStringStep");
var QueryErrorKind = {
  Syntax: 1,
  NodeName: 2,
  FieldName: 3,
  CaptureName: 4,
  PatternStructure: 5
};
var QueryError = class _QueryError extends Error {
  constructor(kind, info2, index, length) {
    super(_QueryError.formatMessage(kind, info2));
    this.kind = kind;
    this.info = info2;
    this.index = index;
    this.length = length;
    this.name = "QueryError";
  }
  static {
    __name(this, "QueryError");
  }
  /** Formats an error message based on the error kind and info */
  static formatMessage(kind, info2) {
    switch (kind) {
      case QueryErrorKind.NodeName:
        return `Bad node name '${info2.word}'`;
      case QueryErrorKind.FieldName:
        return `Bad field name '${info2.word}'`;
      case QueryErrorKind.CaptureName:
        return `Bad capture name @${info2.word}`;
      case QueryErrorKind.PatternStructure:
        return `Bad pattern structure at offset ${info2.suffix}`;
      case QueryErrorKind.Syntax:
        return `Bad syntax at offset ${info2.suffix}`;
    }
  }
};
function parseAnyPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}`
    );
  }
  if (!isCaptureStep(steps[1])) {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}"`
    );
  }
  const isPositive = operator === "eq?" || operator === "any-eq?";
  const matchAll = !operator.startsWith("any-");
  if (isCaptureStep(steps[2])) {
    const captureName1 = steps[1].name;
    const captureName2 = steps[2].name;
    textPredicates[index].push((captures) => {
      const nodes1 = [];
      const nodes2 = [];
      for (const c of captures) {
        if (c.name === captureName1) nodes1.push(c.node);
        if (c.name === captureName2) nodes2.push(c.node);
      }
      const compare = /* @__PURE__ */ __name((n1, n2, positive) => {
        return positive ? n1.text === n2.text : n1.text !== n2.text;
      }, "compare");
      return matchAll ? nodes1.every((n1) => nodes2.some((n2) => compare(n1, n2, isPositive))) : nodes1.some((n1) => nodes2.some((n2) => compare(n1, n2, isPositive)));
    });
  } else {
    const captureName = steps[1].name;
    const stringValue = steps[2].value;
    const matches = /* @__PURE__ */ __name((n) => n.text === stringValue, "matches");
    const doesNotMatch = /* @__PURE__ */ __name((n) => n.text !== stringValue, "doesNotMatch");
    textPredicates[index].push((captures) => {
      const nodes = [];
      for (const c of captures) {
        if (c.name === captureName) nodes.push(c.node);
      }
      const test = isPositive ? matches : doesNotMatch;
      return matchAll ? nodes.every(test) : nodes.some(test);
    });
  }
}
__name(parseAnyPredicate, "parseAnyPredicate");
function parseMatchPredicate(steps, index, operator, textPredicates) {
  if (steps.length !== 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  if (steps[2].type !== "string") {
    throw new Error(
      `Second argument of \`#${operator}\` predicate must be a string. Got @${steps[2].name}.`
    );
  }
  const isPositive = operator === "match?" || operator === "any-match?";
  const matchAll = !operator.startsWith("any-");
  const captureName = steps[1].name;
  const regex = new RegExp(steps[2].value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    const test = /* @__PURE__ */ __name((text, positive) => {
      return positive ? regex.test(text) : !regex.test(text);
    }, "test");
    if (nodes.length === 0) return !isPositive;
    return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
  });
}
__name(parseMatchPredicate, "parseMatchPredicate");
function parseAnyOfPredicate(steps, index, operator, textPredicates) {
  if (steps.length < 2) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected at least 1. Got ${steps.length - 1}.`
    );
  }
  if (steps[1].type !== "capture") {
    throw new Error(
      `First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`
    );
  }
  const isPositive = operator === "any-of?";
  const captureName = steps[1].name;
  const stringSteps = steps.slice(2);
  if (!stringSteps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const values = stringSteps.map((s) => s.value);
  textPredicates[index].push((captures) => {
    const nodes = [];
    for (const c of captures) {
      if (c.name === captureName) nodes.push(c.node.text);
    }
    if (nodes.length === 0) return !isPositive;
    return nodes.every((text) => values.includes(text)) === isPositive;
  });
}
__name(parseAnyOfPredicate, "parseAnyOfPredicate");
function parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(
      `Wrong number of arguments to \`#${operator}\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`
    );
  }
  if (!steps.every(isStringStep)) {
    throw new Error(
      `Arguments to \`#${operator}\` predicate must be strings.".`
    );
  }
  const properties = operator === "is?" ? assertedProperties : refutedProperties;
  if (!properties[index]) properties[index] = {};
  properties[index][steps[1].value] = steps[2]?.value ?? null;
}
__name(parseIsPredicate, "parseIsPredicate");
function parseSetDirective(steps, index, setProperties) {
  if (steps.length < 2 || steps.length > 3) {
    throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
  }
  if (!steps.every(isStringStep)) {
    throw new Error(`Arguments to \`#set!\` predicate must be strings.".`);
  }
  if (!setProperties[index]) setProperties[index] = {};
  setProperties[index][steps[1].value] = steps[2]?.value ?? null;
}
__name(parseSetDirective, "parseSetDirective");
function parsePattern(index, stepType, stepValueId, captureNames, stringValues, steps, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
  if (stepType === PREDICATE_STEP_TYPE_CAPTURE) {
    const name22 = captureNames[stepValueId];
    steps.push({ type: "capture", name: name22 });
  } else if (stepType === PREDICATE_STEP_TYPE_STRING) {
    steps.push({ type: "string", value: stringValues[stepValueId] });
  } else if (steps.length > 0) {
    if (steps[0].type !== "string") {
      throw new Error("Predicates must begin with a literal value");
    }
    const operator = steps[0].value;
    switch (operator) {
      case "any-not-eq?":
      case "not-eq?":
      case "any-eq?":
      case "eq?":
        parseAnyPredicate(steps, index, operator, textPredicates);
        break;
      case "any-not-match?":
      case "not-match?":
      case "any-match?":
      case "match?":
        parseMatchPredicate(steps, index, operator, textPredicates);
        break;
      case "not-any-of?":
      case "any-of?":
        parseAnyOfPredicate(steps, index, operator, textPredicates);
        break;
      case "is?":
      case "is-not?":
        parseIsPredicate(steps, index, operator, assertedProperties, refutedProperties);
        break;
      case "set!":
        parseSetDirective(steps, index, setProperties);
        break;
      default:
        predicates[index].push({ operator, operands: steps.slice(1) });
    }
    steps.length = 0;
  }
}
__name(parsePattern, "parsePattern");
var Query = class {
  static {
    __name(this, "Query");
  }
  /** @internal */
  [0] = 0;
  // Internal handle for Wasm
  /** @internal */
  exceededMatchLimit;
  /** @internal */
  textPredicates;
  /** The names of the captures used in the query. */
  captureNames;
  /** The quantifiers of the captures used in the query. */
  captureQuantifiers;
  /**
   * The other user-defined predicates associated with the given index.
   *
   * This includes predicates with operators other than:
   * - `match?`
   * - `eq?` and `not-eq?`
   * - `any-of?` and `not-any-of?`
   * - `is?` and `is-not?`
   * - `set!`
   */
  predicates;
  /** The properties for predicates with the operator `set!`. */
  setProperties;
  /** The properties for predicates with the operator `is?`. */
  assertedProperties;
  /** The properties for predicates with the operator `is-not?`. */
  refutedProperties;
  /** The maximum number of in-progress matches for this cursor. */
  matchLimit;
  /**
   * Create a new query from a string containing one or more S-expression
   * patterns.
   *
   * The query is associated with a particular language, and can only be run
   * on syntax nodes parsed with that language. References to Queries can be
   * shared between multiple threads.
   *
   * @link {@see https://tree-sitter.github.io/tree-sitter/using-parsers/queries}
   */
  constructor(language, source) {
    const sourceLength = C.lengthBytesUTF8(source);
    const sourceAddress = C._malloc(sourceLength + 1);
    C.stringToUTF8(source, sourceAddress, sourceLength + 1);
    const address = C._ts_query_new(
      language[0],
      sourceAddress,
      sourceLength,
      TRANSFER_BUFFER,
      TRANSFER_BUFFER + SIZE_OF_INT
    );
    if (!address) {
      const errorId = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
      const errorByte = C.getValue(TRANSFER_BUFFER, "i32");
      const errorIndex = C.UTF8ToString(sourceAddress, errorByte).length;
      const suffix = source.slice(errorIndex, errorIndex + 100).split("\n")[0];
      const word = suffix.match(QUERY_WORD_REGEX)?.[0] ?? "";
      C._free(sourceAddress);
      switch (errorId) {
        case QueryErrorKind.Syntax:
          throw new QueryError(QueryErrorKind.Syntax, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
        case QueryErrorKind.NodeName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.FieldName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.CaptureName:
          throw new QueryError(errorId, { word }, errorIndex, word.length);
        case QueryErrorKind.PatternStructure:
          throw new QueryError(errorId, { suffix: `${errorIndex}: '${suffix}'...` }, errorIndex, 0);
      }
    }
    const stringCount = C._ts_query_string_count(address);
    const captureCount = C._ts_query_capture_count(address);
    const patternCount = C._ts_query_pattern_count(address);
    const captureNames = new Array(captureCount);
    const captureQuantifiers = new Array(patternCount);
    const stringValues = new Array(stringCount);
    for (let i2 = 0; i2 < captureCount; i2++) {
      const nameAddress = C._ts_query_capture_name_for_id(
        address,
        i2,
        TRANSFER_BUFFER
      );
      const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
      captureNames[i2] = C.UTF8ToString(nameAddress, nameLength);
    }
    for (let i2 = 0; i2 < patternCount; i2++) {
      const captureQuantifiersArray = new Array(captureCount);
      for (let j = 0; j < captureCount; j++) {
        const quantifier = C._ts_query_capture_quantifier_for_id(address, i2, j);
        captureQuantifiersArray[j] = quantifier;
      }
      captureQuantifiers[i2] = captureQuantifiersArray;
    }
    for (let i2 = 0; i2 < stringCount; i2++) {
      const valueAddress = C._ts_query_string_value_for_id(
        address,
        i2,
        TRANSFER_BUFFER
      );
      const nameLength = C.getValue(TRANSFER_BUFFER, "i32");
      stringValues[i2] = C.UTF8ToString(valueAddress, nameLength);
    }
    const setProperties = new Array(patternCount);
    const assertedProperties = new Array(patternCount);
    const refutedProperties = new Array(patternCount);
    const predicates = new Array(patternCount);
    const textPredicates = new Array(patternCount);
    for (let i2 = 0; i2 < patternCount; i2++) {
      const predicatesAddress = C._ts_query_predicates_for_pattern(address, i2, TRANSFER_BUFFER);
      const stepCount = C.getValue(TRANSFER_BUFFER, "i32");
      predicates[i2] = [];
      textPredicates[i2] = [];
      const steps = new Array();
      let stepAddress = predicatesAddress;
      for (let j = 0; j < stepCount; j++) {
        const stepType = C.getValue(stepAddress, "i32");
        stepAddress += SIZE_OF_INT;
        const stepValueId = C.getValue(stepAddress, "i32");
        stepAddress += SIZE_OF_INT;
        parsePattern(
          i2,
          stepType,
          stepValueId,
          captureNames,
          stringValues,
          steps,
          textPredicates,
          predicates,
          setProperties,
          assertedProperties,
          refutedProperties
        );
      }
      Object.freeze(textPredicates[i2]);
      Object.freeze(predicates[i2]);
      Object.freeze(setProperties[i2]);
      Object.freeze(assertedProperties[i2]);
      Object.freeze(refutedProperties[i2]);
    }
    C._free(sourceAddress);
    this[0] = address;
    this.captureNames = captureNames;
    this.captureQuantifiers = captureQuantifiers;
    this.textPredicates = textPredicates;
    this.predicates = predicates;
    this.setProperties = setProperties;
    this.assertedProperties = assertedProperties;
    this.refutedProperties = refutedProperties;
    this.exceededMatchLimit = false;
  }
  /** Delete the query, freeing its resources. */
  delete() {
    C._ts_query_delete(this[0]);
    this[0] = 0;
  }
  /**
   * Iterate over all of the matches in the order that they were found.
   *
   * Each match contains the index of the pattern that matched, and a list of
   * captures. Because multiple patterns can match the same set of nodes,
   * one match may contain captures that appear *before* some of the
   * captures from a previous match.
   *
   * @param {Node} node - The node to execute the query on.
   *
   * @param {QueryOptions} options - Options for query execution.
   */
  matches(node, options = {}) {
    const startPosition = options.startPosition ?? ZERO_POINT;
    const endPosition = options.endPosition ?? ZERO_POINT;
    const startIndex = options.startIndex ?? 0;
    const endIndex = options.endIndex ?? 0;
    const startContainingPosition = options.startContainingPosition ?? ZERO_POINT;
    const endContainingPosition = options.endContainingPosition ?? ZERO_POINT;
    const startContainingIndex = options.startContainingIndex ?? 0;
    const endContainingIndex = options.endContainingIndex ?? 0;
    const matchLimit = options.matchLimit ?? 4294967295;
    const maxStartDepth = options.maxStartDepth ?? 4294967295;
    const progressCallback = options.progressCallback;
    if (typeof matchLimit !== "number") {
      throw new Error("Arguments must be numbers");
    }
    this.matchLimit = matchLimit;
    if (endIndex !== 0 && startIndex > endIndex) {
      throw new Error("`startIndex` cannot be greater than `endIndex`");
    }
    if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
      throw new Error("`startPosition` cannot be greater than `endPosition`");
    }
    if (endContainingIndex !== 0 && startContainingIndex > endContainingIndex) {
      throw new Error("`startContainingIndex` cannot be greater than `endContainingIndex`");
    }
    if (endContainingPosition !== ZERO_POINT && (startContainingPosition.row > endContainingPosition.row || startContainingPosition.row === endContainingPosition.row && startContainingPosition.column > endContainingPosition.column)) {
      throw new Error("`startContainingPosition` cannot be greater than `endContainingPosition`");
    }
    if (progressCallback) {
      C.currentQueryProgressCallback = progressCallback;
    }
    marshalNode(node);
    C._ts_query_matches_wasm(
      this[0],
      node.tree[0],
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column,
      startIndex,
      endIndex,
      startContainingPosition.row,
      startContainingPosition.column,
      endContainingPosition.row,
      endContainingPosition.column,
      startContainingIndex,
      endContainingIndex,
      matchLimit,
      maxStartDepth
    );
    const rawCount = C.getValue(TRANSFER_BUFFER, "i32");
    const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
    const result = new Array(rawCount);
    this.exceededMatchLimit = Boolean(didExceedMatchLimit);
    let filteredCount = 0;
    let address = startAddress;
    for (let i2 = 0; i2 < rawCount; i2++) {
      const patternIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureCount = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captures = new Array(captureCount);
      address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
      if (this.textPredicates[patternIndex].every((p) => p(captures))) {
        result[filteredCount] = { patternIndex, captures };
        const setProperties = this.setProperties[patternIndex];
        result[filteredCount].setProperties = setProperties;
        const assertedProperties = this.assertedProperties[patternIndex];
        result[filteredCount].assertedProperties = assertedProperties;
        const refutedProperties = this.refutedProperties[patternIndex];
        result[filteredCount].refutedProperties = refutedProperties;
        filteredCount++;
      }
    }
    result.length = filteredCount;
    C._free(startAddress);
    C.currentQueryProgressCallback = null;
    return result;
  }
  /**
   * Iterate over all of the individual captures in the order that they
   * appear.
   *
   * This is useful if you don't care about which pattern matched, and just
   * want a single, ordered sequence of captures.
   *
   * @param {Node} node - The node to execute the query on.
   *
   * @param {QueryOptions} options - Options for query execution.
   */
  captures(node, options = {}) {
    const startPosition = options.startPosition ?? ZERO_POINT;
    const endPosition = options.endPosition ?? ZERO_POINT;
    const startIndex = options.startIndex ?? 0;
    const endIndex = options.endIndex ?? 0;
    const startContainingPosition = options.startContainingPosition ?? ZERO_POINT;
    const endContainingPosition = options.endContainingPosition ?? ZERO_POINT;
    const startContainingIndex = options.startContainingIndex ?? 0;
    const endContainingIndex = options.endContainingIndex ?? 0;
    const matchLimit = options.matchLimit ?? 4294967295;
    const maxStartDepth = options.maxStartDepth ?? 4294967295;
    const progressCallback = options.progressCallback;
    if (typeof matchLimit !== "number") {
      throw new Error("Arguments must be numbers");
    }
    this.matchLimit = matchLimit;
    if (endIndex !== 0 && startIndex > endIndex) {
      throw new Error("`startIndex` cannot be greater than `endIndex`");
    }
    if (endPosition !== ZERO_POINT && (startPosition.row > endPosition.row || startPosition.row === endPosition.row && startPosition.column > endPosition.column)) {
      throw new Error("`startPosition` cannot be greater than `endPosition`");
    }
    if (endContainingIndex !== 0 && startContainingIndex > endContainingIndex) {
      throw new Error("`startContainingIndex` cannot be greater than `endContainingIndex`");
    }
    if (endContainingPosition !== ZERO_POINT && (startContainingPosition.row > endContainingPosition.row || startContainingPosition.row === endContainingPosition.row && startContainingPosition.column > endContainingPosition.column)) {
      throw new Error("`startContainingPosition` cannot be greater than `endContainingPosition`");
    }
    if (progressCallback) {
      C.currentQueryProgressCallback = progressCallback;
    }
    marshalNode(node);
    C._ts_query_captures_wasm(
      this[0],
      node.tree[0],
      startPosition.row,
      startPosition.column,
      endPosition.row,
      endPosition.column,
      startIndex,
      endIndex,
      startContainingPosition.row,
      startContainingPosition.column,
      endContainingPosition.row,
      endContainingPosition.column,
      startContainingIndex,
      endContainingIndex,
      matchLimit,
      maxStartDepth
    );
    const count = C.getValue(TRANSFER_BUFFER, "i32");
    const startAddress = C.getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
    const didExceedMatchLimit = C.getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
    const result = new Array();
    this.exceededMatchLimit = Boolean(didExceedMatchLimit);
    const captures = new Array();
    let address = startAddress;
    for (let i2 = 0; i2 < count; i2++) {
      const patternIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureCount = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      const captureIndex = C.getValue(address, "i32");
      address += SIZE_OF_INT;
      captures.length = captureCount;
      address = unmarshalCaptures(this, node.tree, address, patternIndex, captures);
      if (this.textPredicates[patternIndex].every((p) => p(captures))) {
        const capture = captures[captureIndex];
        const setProperties = this.setProperties[patternIndex];
        capture.setProperties = setProperties;
        const assertedProperties = this.assertedProperties[patternIndex];
        capture.assertedProperties = assertedProperties;
        const refutedProperties = this.refutedProperties[patternIndex];
        capture.refutedProperties = refutedProperties;
        result.push(capture);
      }
    }
    C._free(startAddress);
    C.currentQueryProgressCallback = null;
    return result;
  }
  /** Get the predicates for a given pattern. */
  predicatesForPattern(patternIndex) {
    return this.predicates[patternIndex];
  }
  /**
   * Disable a certain capture within a query.
   *
   * This prevents the capture from being returned in matches, and also
   * avoids any resource usage associated with recording the capture.
   */
  disableCapture(captureName) {
    const captureNameLength = C.lengthBytesUTF8(captureName);
    const captureNameAddress = C._malloc(captureNameLength + 1);
    C.stringToUTF8(captureName, captureNameAddress, captureNameLength + 1);
    C._ts_query_disable_capture(this[0], captureNameAddress, captureNameLength);
    C._free(captureNameAddress);
  }
  /**
   * Disable a certain pattern within a query.
   *
   * This prevents the pattern from matching, and also avoids any resource
   * usage associated with the pattern. This throws an error if the pattern
   * index is out of bounds.
   */
  disablePattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    C._ts_query_disable_pattern(this[0], patternIndex);
  }
  /**
   * Check if, on its last execution, this cursor exceeded its maximum number
   * of in-progress matches.
   */
  didExceedMatchLimit() {
    return this.exceededMatchLimit;
  }
  /** Get the byte offset where the given pattern starts in the query's source. */
  startIndexForPattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    return C._ts_query_start_byte_for_pattern(this[0], patternIndex);
  }
  /** Get the byte offset where the given pattern ends in the query's source. */
  endIndexForPattern(patternIndex) {
    if (patternIndex >= this.predicates.length) {
      throw new Error(
        `Pattern index is ${patternIndex} but the pattern count is ${this.predicates.length}`
      );
    }
    return C._ts_query_end_byte_for_pattern(this[0], patternIndex);
  }
  /** Get the number of patterns in the query. */
  patternCount() {
    return C._ts_query_pattern_count(this[0]);
  }
  /** Get the index for a given capture name. */
  captureIndexForName(captureName) {
    return this.captureNames.indexOf(captureName);
  }
  /** Check if a given pattern within a query has a single root node. */
  isPatternRooted(patternIndex) {
    return C._ts_query_is_pattern_rooted(this[0], patternIndex) === 1;
  }
  /** Check if a given pattern within a query has a single root node. */
  isPatternNonLocal(patternIndex) {
    return C._ts_query_is_pattern_non_local(this[0], patternIndex) === 1;
  }
  /**
   * Check if a given step in a query is 'definite'.
   *
   * A query step is 'definite' if its parent pattern will be guaranteed to
   * match successfully once it reaches the step.
   */
  isPatternGuaranteedAtStep(byteIndex) {
    return C._ts_query_is_pattern_guaranteed_at_step(this[0], byteIndex) === 1;
  }
};

// lib/symbol-outline.js
import { join as join4, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readFileSync3 } from "node:fs";
var __dirname = dirname2(fileURLToPath(import.meta.url));
var MAX_SYMBOL_FILE_BYTES = 512 * 1024;
var EXT_TO_GRAMMAR = {
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".py": "tree-sitter-python.wasm"
};
var EXT_TO_LANG = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".tsx": "typescript",
  ".py": "python"
};
var ORPHAN_EXCLUDE = {
  javascript: /* @__PURE__ */ new Set(["import_statement", "comment", "empty_statement", "hash_bang_line"]),
  typescript: /* @__PURE__ */ new Set(["import_statement", "comment", "empty_statement", "hash_bang_line"]),
  python: /* @__PURE__ */ new Set(["import_statement", "import_from_statement", "comment", "pass_statement"])
};
var parser = null;
var parserReady = false;
var initPromise = null;
var grammarPromises = /* @__PURE__ */ new Map();
var grammars = /* @__PURE__ */ new Map();
var grammarAttempts = /* @__PURE__ */ new Map();
var MAX_GRAMMAR_ATTEMPTS = 3;
var REGEX_EXTS = /* @__PURE__ */ new Set([".md"]);
function isGrammarLoaded(ext) {
  return grammars.has(EXT_TO_GRAMMAR[ext]);
}
function canExtract(ext) {
  ext = ext.toLowerCase();
  if (REGEX_EXTS.has(ext)) return true;
  return parserReady && isGrammarLoaded(ext);
}
var _wasmDir = __dirname;
function initParser({ wasmDir } = {}) {
  if (parserReady) return Promise.resolve();
  if (initPromise) return initPromise;
  if (wasmDir) _wasmDir = wasmDir;
  initPromise = Parser.init({ locateFile: (file) => join4(_wasmDir, file) }).then(() => {
    parser = new Parser();
    parserReady = true;
  }).catch((err2) => {
    initPromise = null;
    throw err2;
  });
  return initPromise;
}
function loadGrammar(ext, { wasmDir } = {}) {
  const file = EXT_TO_GRAMMAR[ext];
  if (!file) return Promise.resolve();
  if (grammars.has(file)) return Promise.resolve();
  if (grammarPromises.has(file)) return grammarPromises.get(file);
  if ((grammarAttempts.get(file) || 0) >= MAX_GRAMMAR_ATTEMPTS) return Promise.resolve();
  const dir = wasmDir || _wasmDir;
  const promise = initParser().then(() => Language.load(join4(dir, file))).then((lang) => {
    grammars.set(file, lang);
  }).catch((err2) => {
    grammarPromises.delete(file);
    if (parserReady) grammarAttempts.set(file, (grammarAttempts.get(file) || 0) + 1);
    throw err2;
  });
  grammarPromises.set(file, promise);
  return promise;
}
function getLanguage(ext) {
  const file = EXT_TO_GRAMMAR[ext];
  return file ? grammars.get(file) : void 0;
}
function parse(code, ext) {
  const lang = getLanguage(ext);
  if (!lang) return null;
  parser.setLanguage(lang);
  return parser.parse(code);
}
function withTree(code, ext, fn) {
  const tree = parse(code, ext);
  if (!tree) return null;
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}
var JS_LEVEL0_TYPES = /* @__PURE__ */ new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration"
]);
var JS_LEVEL0_VAR_TYPES = /* @__PURE__ */ new Set(["lexical_declaration", "variable_declaration"]);
var TS_EXTRA_LEVEL0 = /* @__PURE__ */ new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]);
function extractName(node) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : null;
}
function varDeclName(node) {
  for (let i2 = 0; i2 < node.namedChildCount; i2++) {
    const child = node.namedChild(i2);
    if (child.type === "variable_declarator") {
      const n = child.childForFieldName("name");
      return n ? n.text : null;
    }
  }
  return null;
}
function nodeSpan(node) {
  return node.endPosition.row - node.startPosition.row + 1;
}
var MD_HEADING_RE = /^ {0,3}(#{1,3})\s+(.+?)(?:\s+#+\s*)?$/;
var MD_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
var MD_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
function _extractMarkdownSymbols(code) {
  const normalized = code.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const headings = [];
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  let startIdx = 0;
  if (lines[0] && lines[0].trim() === "---") {
    const fmLimit = Math.min(lines.length, 50);
    for (let i2 = 1; i2 < fmLimit; i2++) {
      if (lines[i2].trim() === "---") {
        startIdx = i2 + 1;
        break;
      }
    }
  }
  for (let i2 = startIdx; i2 < lines.length; i2++) {
    const line = lines[i2];
    if (!inFence) {
      const openMatch = line.match(MD_FENCE_OPEN_RE);
      if (openMatch) {
        const ch = openMatch[1][0];
        if (ch === "`") {
          const afterFence = line.slice(line.indexOf(openMatch[1]) + openMatch[1].length);
          if (afterFence.includes("`")) {
          } else {
            inFence = true;
            fenceChar = ch;
            fenceLen = openMatch[1].length;
            continue;
          }
        } else {
          inFence = true;
          fenceChar = ch;
          fenceLen = openMatch[1].length;
          continue;
        }
      }
    } else {
      const closeMatch = line.match(MD_FENCE_CLOSE_RE);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const match = line.match(MD_HEADING_RE);
    if (match) {
      const level = match[1].length;
      const rawName = match[2].trim();
      if (!rawName) continue;
      headings.push({ level, rawName, startLine: i2 + 1 });
    }
  }
  if (headings.length === 0) return [];
  const totalLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const symbols = [];
  const stack = [];
  for (let i2 = 0; i2 < headings.length; i2++) {
    const h = headings[i2];
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    const fullName = stack.length > 0 ? `${stack[stack.length - 1].fullName} > ${h.rawName}` : h.rawName;
    stack.push({ level: h.level, fullName });
    let endLine = totalLines;
    for (let j = i2 + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].startLine - 1;
        break;
      }
    }
    symbols.push({ name: fullName, startLine: h.startLine, endLine, depth: stack.length - 1 });
  }
  const seen = /* @__PURE__ */ new Set();
  for (const s of symbols) {
    if (seen.has(s.name)) return [];
    seen.add(s.name);
  }
  return symbols;
}
function extractSymbols(code, ext) {
  ext = ext.toLowerCase();
  if (ext === ".md") {
    if (code.length > MAX_SYMBOL_FILE_BYTES) return [];
    return _extractMarkdownSymbols(code);
  }
  return withTree(code, ext, (tree) => {
    const lang = EXT_TO_LANG[ext] || "javascript";
    return _extractFromTree(tree, ext, lang);
  }) || [];
}
function _extractFromTree(tree, ext, lang) {
  const symbols = [];
  const root = tree.rootNode;
  for (let i2 = 0; i2 < root.namedChildCount; i2++) {
    let node = root.namedChild(i2);
    if (node.type === "export_statement" || node.type === "export_default_declaration") {
      const decl = node.childForFieldName("declaration") || node.namedChild(0);
      if (decl && decl.type !== node.type) node = decl;
      else continue;
    }
    if (lang === "python" && node.type === "decorated_definition") {
      const outerStart = node.startPosition.row + 1;
      const outerEnd = node.endPosition.row + 1;
      const inner = node.childForFieldName("definition") || node.namedChild(node.namedChildCount - 1);
      if (inner && (inner.type === "function_definition" || inner.type === "class_definition" || inner.type === "async_function_definition")) {
        const name3 = extractName(inner);
        if (name3) {
          symbols.push({ name: name3, startLine: outerStart, endLine: outerEnd, depth: 0 });
          if (inner.type === "class_definition") {
            extractClassMethods(inner, name3, symbols, lang);
          }
        }
      }
      continue;
    }
    if (lang === "python") {
      if (node.type === "function_definition" || node.type === "async_function_definition" || node.type === "class_definition") {
        const name3 = extractName(node);
        if (name3) {
          symbols.push({ name: name3, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
          if (node.type === "class_definition") {
            extractClassMethods(node, name3, symbols, lang);
          }
        }
        continue;
      }
      if (node.type === "expression_statement" && nodeSpan(node) >= 3) {
        const assign = node.namedChild(0);
        if (assign && assign.type === "assignment") {
          const left = assign.childForFieldName("left");
          if (left) {
            symbols.push({ name: left.text, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
          }
        }
      }
      continue;
    }
    if (JS_LEVEL0_TYPES.has(node.type) || lang === "typescript" && TS_EXTRA_LEVEL0.has(node.type)) {
      const name3 = extractName(node);
      if (!name3) continue;
      const span = nodeSpan(node);
      if (lang === "typescript" && TS_EXTRA_LEVEL0.has(node.type) && span < 3) continue;
      symbols.push({ name: name3, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
      if (node.type === "class_declaration") {
        extractClassMethods(node, name3, symbols, lang);
      }
      continue;
    }
    if (JS_LEVEL0_VAR_TYPES.has(node.type) && nodeSpan(node) >= 3) {
      const name3 = varDeclName(node);
      if (name3) {
        symbols.push({ name: name3, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 0 });
      }
    }
  }
  symbols.sort((a, b) => a.startLine - b.startLine);
  return symbols;
}
function extractClassMethods(classNode, className, symbols, lang) {
  let body2 = null;
  for (let i2 = 0; i2 < classNode.namedChildCount; i2++) {
    const child = classNode.namedChild(i2);
    if (child.type === "class_body" || child.type === "block") {
      body2 = child;
      break;
    }
  }
  if (!body2) return;
  for (let i2 = 0; i2 < body2.namedChildCount; i2++) {
    let node = body2.namedChild(i2);
    if (lang === "python" && node.type === "decorated_definition") {
      const outerStart = node.startPosition.row + 1;
      const outerEnd = node.endPosition.row + 1;
      const inner = node.childForFieldName("definition") || node.namedChild(node.namedChildCount - 1);
      if (inner && (inner.type === "function_definition" || inner.type === "async_function_definition")) {
        const name3 = extractName(inner);
        if (name3) symbols.push({ name: `${className}.${name3}`, startLine: outerStart, endLine: outerEnd, depth: 1 });
      }
      continue;
    }
    if (node.type === "method_definition") {
      const name3 = extractName(node) || node.childForFieldName("name")?.text;
      if (name3) symbols.push({ name: `${className}.${name3}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
      continue;
    }
    if (lang === "python" && (node.type === "function_definition" || node.type === "async_function_definition")) {
      const name3 = extractName(node);
      if (name3) symbols.push({ name: `${className}.${name3}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
      continue;
    }
    if (lang === "typescript" && node.type === "field_definition" && nodeSpan(node) >= 3) {
      const nameNode = node.childForFieldName("property") || node.childForFieldName("name");
      if (nameNode) symbols.push({ name: `${className}.${nameNode.text}`, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth: 1 });
    }
  }
}
function fitLinesToSymbols(lineNumbers, symbols) {
  const matched = /* @__PURE__ */ new Set();
  const orphanLines = [];
  let coveredCount = 0;
  for (const line of lineNumbers) {
    let tightest = null;
    let tightestSpan = Infinity;
    for (const sym of symbols) {
      if (sym.startLine <= line && line <= sym.endLine) {
        const span = sym.endLine - sym.startLine;
        if (span < tightestSpan) {
          tightest = sym;
          tightestSpan = span;
        }
      }
    }
    if (tightest) {
      matched.add(tightest.name);
      coveredCount++;
    } else {
      orphanLines.push(line);
    }
  }
  return { activeSymbols: [...matched], coveredCount, orphanLines };
}
function classifyOrphans(orphanLines, tree, language) {
  const excludeSet = ORPHAN_EXCLUDE[language] || ORPHAN_EXCLUDE.javascript;
  let excluded = 0;
  for (const line of orphanLines) {
    const node = tree.rootNode.descendantForPosition({ row: line - 1, column: 0 });
    if (node) {
      let current = node;
      while (current.parent && current.parent !== tree.rootNode) current = current.parent;
      if (excludeSet.has(current.type)) {
        excluded++;
      }
    }
  }
  return { excluded, structural: orphanLines.length - excluded };
}
function _selectActiveSymbols(symbols, fitResult, totalBucketLines, hasFullSnapshot, excludedOrphanCount) {
  const cap = 30;
  if (hasFullSnapshot) {
    let selected = symbols;
    if (selected.length > cap) {
      const maxDepth = selected.reduce((m, s) => Math.max(m, s.depth), 0);
      for (let d = maxDepth; d > 1 && selected.length > cap; d--) {
        const atThisDepth = selected.filter((s) => s.depth === d);
        const others = selected.filter((s) => s.depth !== d);
        const keep = cap - others.length;
        if (keep <= 0) {
          selected = others;
        } else {
          selected = others.concat(atThisDepth.slice(0, keep));
          selected.sort((a, b) => a.startLine - b.startLine);
        }
      }
      if (selected.length > cap) selected = selected.slice(0, cap);
    }
    const names = selected.map((s) => s.name);
    return { activeSymbols: names.length ? names : null };
  }
  const { activeSymbols, coveredCount } = fitResult;
  if (totalBucketLines === 0) return { activeSymbols: null };
  const adjustedTotal = totalBucketLines - excludedOrphanCount;
  const adjustedCoverage = adjustedTotal > 0 ? coveredCount / adjustedTotal : 1;
  if (adjustedCoverage < 0.5) return { activeSymbols: null };
  const activeSet = new Set(activeSymbols);
  const seen = /* @__PURE__ */ new Set();
  const ordered = [];
  for (const s of symbols) {
    if (activeSet.has(s.name) && !seen.has(s.name)) {
      seen.add(s.name);
      ordered.push(s.name);
    }
  }
  const capped = ordered.slice(0, cap);
  return { activeSymbols: capped.length ? capped : null };
}
function activeSymbolsForPath(code, ext, bucketLineNumbers, hasFullSnapshot) {
  ext = ext.toLowerCase();
  if (!canExtract(ext)) return { activeSymbols: null };
  if (code.length > MAX_SYMBOL_FILE_BYTES) return { activeSymbols: null };
  if (ext === ".md") {
    const symbols = _extractMarkdownSymbols(code);
    if (symbols.length === 0) return { activeSymbols: null };
    const fitResult = fitLinesToSymbols(bucketLineNumbers, symbols);
    return _selectActiveSymbols(symbols, fitResult, bucketLineNumbers.length, hasFullSnapshot, 0);
  }
  return withTree(code, ext, (tree) => {
    const lang = EXT_TO_LANG[ext] || "javascript";
    const symbols = _extractFromTree(tree, ext, lang);
    const fitResult = fitLinesToSymbols(bucketLineNumbers, symbols);
    const { excluded } = classifyOrphans(fitResult.orphanLines, tree, lang);
    return _selectActiveSymbols(symbols, fitResult, bucketLineNumbers.length, hasFullSnapshot, excluded);
  }) || { activeSymbols: null };
}
function buildSymbolRanges(code, ext, keptNames, bucketLineNumbers) {
  ext = ext.toLowerCase();
  if (!canExtract(ext)) return /* @__PURE__ */ Object.create(null);
  if (code.length > MAX_SYMBOL_FILE_BYTES) return /* @__PURE__ */ Object.create(null);
  const symbols = extractSymbols(code, ext);
  const symMap = /* @__PURE__ */ new Map();
  for (const s of symbols) {
    if (!symMap.has(s.name)) symMap.set(s.name, s);
  }
  const result = /* @__PURE__ */ Object.create(null);
  for (const name3 of keptNames) {
    const sym = symMap.get(name3);
    if (!sym) continue;
    const linesInSymbol = bucketLineNumbers.filter((l) => l >= sym.startLine && l <= sym.endLine);
    if (linesInSymbol.length === 0) continue;
    linesInSymbol.sort((a, b) => a - b);
    const ranges = [];
    let start2 = linesInSymbol[0], end = linesInSymbol[0];
    for (let i2 = 1; i2 < linesInSymbol.length; i2++) {
      if (linesInSymbol[i2] <= end + 1) {
        end = linesInSymbol[i2];
      } else {
        ranges.push([start2, end]);
        start2 = linesInSymbol[i2];
        end = linesInSymbol[i2];
      }
    }
    ranges.push([start2, end]);
    result[name3] = ranges;
  }
  return result;
}
function resolveSymbolLines(code, ext, symbolRanges) {
  ext = ext.toLowerCase();
  const resolved = [];
  const stale = [];
  if (!code || !canExtract(ext)) {
    for (const [name3, ranges] of Object.entries(symbolRanges || {})) {
      stale.push({ name: name3, storedRanges: ranges });
    }
    return { resolved, stale };
  }
  const symbols = extractSymbols(code, ext);
  const symMap = /* @__PURE__ */ new Map();
  for (const s of symbols) {
    if (!symMap.has(s.name)) symMap.set(s.name, s);
  }
  for (const [name3, ranges] of Object.entries(symbolRanges || {})) {
    const sym = symMap.get(name3);
    if (sym) {
      resolved.push({ name: name3, startLine: sym.startLine, endLine: sym.endLine });
    } else {
      stale.push({ name: name3, storedRanges: ranges });
    }
  }
  return { resolved, stale };
}

// lib/resource-enrichment.js
function createResourceEnrichment({
  readFile = (absPath) => readFileSync4(absPath, "utf8"),
  // The grammar prewarm request. It performs no filtering of its own: an extension with no grammar, and one
  // already loaded, are both a resolved promise inside `loadGrammar`.
  warmer = loadGrammar,
  loadGrammar: loadGrammar2 = loadGrammar,
  canExtract: canExtract2 = canExtract
} = {}) {
  function warm(keys) {
    for (const key of keys ?? []) {
      const ext = extname(String(key)).toLowerCase();
      try {
        const pending = warmer(ext);
        if (pending && typeof pending.catch === "function") pending.catch(() => {
        });
      } catch {
      }
    }
    return void 0;
  }
  function readCode(absPath) {
    try {
      return readFile(absPath);
    } catch {
      return null;
    }
  }
  function activeSymbols({ path: path3, lineNumbers = [], fullSnapshot = false }) {
    const ext = extname(path3);
    if (!canExtract2(ext)) return null;
    const code = readCode(path3);
    if (code == null) return null;
    try {
      return activeSymbolsForPath(code, ext, lineNumbers ?? [], fullSnapshot === true).activeSymbols;
    } catch {
      return null;
    }
  }
  function symbolRanges({ path: path3, symbols, lineNumbers }) {
    if (!Array.isArray(symbols) || symbols.length === 0) return null;
    const ext = extname(path3);
    if (!canExtract2(ext)) return null;
    const code = readCode(path3);
    if (code == null) return null;
    const coverage = Array.isArray(lineNumbers) ? lineNumbers : [];
    if (coverage.length === 0) return null;
    try {
      const ranges = buildSymbolRanges(code, ext, symbols, coverage);
      return ranges && Object.keys(ranges).length > 0 ? ranges : null;
    } catch {
      return null;
    }
  }
  async function resolveSymbols({ path: path3, symbolRanges: storedRanges, projectDir }) {
    const stored = storedRanges && typeof storedRanges === "object" ? storedRanges : {};
    const staleAll = Object.entries(stored).map(([name3, ranges]) => ({ name: name3, storedRanges: ranges }));
    const ext = extname(path3).toLowerCase();
    try {
      await loadGrammar2(ext);
    } catch {
    }
    if (!canExtract2(ext)) return { parsed: false, readable: false, resolved: [], stale: staleAll };
    const absolute = isAbsolute2(path3) ? path3 : projectDir ? join5(projectDir, path3) : path3;
    const code = readCode(absolute);
    if (code == null) return { parsed: true, readable: false, resolved: [], stale: staleAll };
    const { resolved, stale } = resolveSymbolLines(code, ext, stored);
    return { parsed: true, readable: true, resolved, stale };
  }
  return { warm, activeSymbols, symbolRanges, resolveSymbols };
}

// lib/l-measure.js
function classifyMiss({ cacheRead, prevL }) {
  if (!(prevL > 0)) return false;
  return cacheRead < prevL * MISS_CR_DROP;
}

// lib/settle.js
function settleDeferred(deltaL, deltaB, pathDeltas, ledger, { epsilon = 1e-6 } = {}) {
  const dL = Math.max(0, deltaL);
  const bSurplus = Math.max(0, deltaB - dL);
  const lSurplus = Math.max(0, dL - deltaB);
  let posTotal = 0;
  if (pathDeltas) {
    for (const d of pathDeltas.values()) if (d > 0) posTotal += d;
  }
  const banked = bSurplus;
  if (banked > 0 && posTotal > 0) {
    for (const [p, d] of pathDeltas) {
      if (d <= 0) continue;
      ledger.byPath.set(p, (ledger.byPath.get(p) || 0) + banked * (d / posTotal));
    }
  }
  const retired = Math.min(ledger.total, lSurplus);
  const residual = lSurplus - retired;
  if (retired > 0 && ledger.total > 0) {
    const frac = retired / ledger.total;
    for (const [p, amt] of ledger.byPath) {
      const next = amt - amt * frac;
      if (next > epsilon) ledger.byPath.set(p, next);
      else ledger.byPath.delete(p);
    }
  }
  let sum = 0;
  for (const v of ledger.byPath.values()) sum += v;
  ledger.total = sum;
  return { residual, banked, retired };
}

// lib/rate-lamp.js
function computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio }) {
  if (!(B_rebuild > 0) || !(cRatio > 0)) return NaN;
  return Math.max(0, L_read - B_post) / (cRatio * B_rebuild);
}

// lib/measurement/position.js
function baselineOf(dead, carried, selector) {
  let sum = dead;
  for (const [resourceKey, tokens] of carried) if (selector(resourceKey)) sum += tokens;
  return sum;
}
function createPathFold({ dead, R, selector }) {
  const carried = /* @__PURE__ */ new Map();
  let u = 0, lambda = 0, F = 0;
  let growthSum = 0, intervals = 0;
  let prev = null;
  function absorb(growth) {
    if (!growth) return;
    let excess = growth.stock;
    for (const [resourceKey, delta] of growth.resources) if (selector(resourceKey)) excess -= delta;
    growthSum += Math.max(0, excess);
    intervals += 1;
  }
  const rate = () => intervals > 0 ? growthSum / intervals : 0;
  return {
    rate,
    push(frame) {
      for (const [resourceKey, tokens] of frame.resourceTokens) carried.set(resourceKey, tokens);
      const B = baselineOf(dead, carried, selector);
      const x = frame.L / B;
      if (prev === null) {
        absorb(frame.growth);
        prev = { B, g: rate(), L: frame.L };
        return { seq: frame.seq, bDefault: B, x, u: 0, pp: null, mf: null, mfLocal: null, br: null, deltaW: null };
      }
      u += Math.sqrt(prev.g / (2 * R * prev.B));
      const V = Math.sqrt(2 * R * prev.B * prev.g);
      lambda += V;
      F += prev.B + R * prev.g;
      const mfLocal = V / (prev.B + R * prev.g + V);
      const pp = u > 0 ? (u - 1) * (u - 1) / (2 * u) : null;
      const mf = lambda / (F + lambda);
      const br = pp === null ? null : mf * pp;
      let deltaW = null;
      if (prev.B > 0) {
        const rPrev = computeFullCarryBurnRate({ L_read: prev.L, B_post: prev.B, B_rebuild: prev.B, cRatio: R });
        const rNow = computeFullCarryBurnRate({ L_read: frame.L, B_post: B, B_rebuild: prev.B, cRatio: R });
        deltaW = 0.5 * (rPrev + rNow);
      }
      absorb(frame.growth);
      prev = { B, g: rate(), L: frame.L };
      return { seq: frame.seq, bDefault: B, x, u, pp, mf, mfLocal, br, deltaW };
    }
  };
}
function fitAffine(points) {
  const fitted = [];
  let su = 0;
  const distinct = /* @__PURE__ */ new Set();
  for (const p of points) {
    if (p.pp === null) continue;
    fitted.push(p);
    su += p.u;
    distinct.add(p.u);
  }
  if (distinct.size < 2) return null;
  const n = fitted.length, uMean = su / n, x0 = fitted[0].x;
  let suu = 0, sux = 0, sx = 0;
  for (const p of fitted) {
    const du = p.u - uMean;
    suu += du * du;
    sux += du * (p.x - x0);
    sx += p.x;
  }
  const d = sux / suu;
  if (!(Number.isFinite(d) && d > 0)) return null;
  return { a: sx / n - d * uMean, d };
}
function landmarksOf(reference, mf) {
  if (!reference || !(Number.isFinite(mf) && mf > 0)) {
    return { xSweet: null, xBrAmberL: null, xBrAmberR: null, xBrRedR: null };
  }
  const xAt = (u) => reference.a + reference.d * u;
  return {
    xSweet: xAt(1),
    xBrAmberL: xAt(uLeftAtBr(mf, BR_AMBER)),
    xBrAmberR: xAt(uAtBr(mf, BR_AMBER)),
    xBrRedR: xAt(uAtBr(mf, BR_RED))
  };
}

// lib/measurement/resident-ledger.js
var TOUCH_HISTORY_MAX = 128;
var TOUCH_HISTORY_KEEP = 64;
var MUTATION_KINDS = /* @__PURE__ */ new Set(["replace-fragments", "merge-fragments", "adjust-total"]);
function invariant2(ok, message) {
  if (!ok) throw new Error(`resident ledger invariant: ${message}`);
}
function isTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isSignedTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function resourceTokensOf(resource, correction = 0) {
  return Math.max(0, resource.fragmentTotal + resource.adjustment + resource.overhead - correction);
}
function createResidentLedger() {
  const resources = /* @__PURE__ */ new Map();
  const residuals = /* @__PURE__ */ new Map();
  function newResource() {
    return {
      fragments: /* @__PURE__ */ new Map(),
      fragmentTotal: 0,
      adjustment: 0,
      overhead: 0,
      accumulatedSpend: 0,
      readCount: 0,
      editCount: 0,
      pureRereads: 0,
      // Two independent facts: whether a whole-content snapshot has ever landed (a consumer that wants
      // line coverage should read the file instead), and whether the next whole-content read is a pure
      // re-read (write access invalidates that claim).
      fullSnapshot: false,
      wholeContentEligible: false,
      lastTurn: 0,
      lastCallSeq: 0,
      touches: []
    };
  }
  function setFragment(resource, key, tokens) {
    const previous = resource.fragments.get(key) || 0;
    resource.fragments.set(key, tokens);
    resource.fragmentTotal += tokens - previous;
  }
  function pushTouch(owner, seq, mode) {
    owner.touches.push({ seq, mode });
    if (owner.touches.length > TOUCH_HISTORY_MAX) {
      owner.touches.splice(0, owner.touches.length - TOUCH_HISTORY_KEEP);
    }
  }
  function applyEffect(effect, context) {
    invariant2(effect !== null && typeof effect === "object", "effect must be an object");
    const access = effect.access;
    invariant2(access === "read" || access === "write", "effect access must be read or write");
    invariant2(isTokenCount(effect.overheadTokens), "effect overheadTokens must be a non-negative finite number");
    invariant2(isTokenCount(effect.spentTokens), "effect spentTokens must be a non-negative finite number");
    const impacts = effect.impacts;
    invariant2(Array.isArray(impacts) && impacts.length > 0, "effect must carry at least one impact");
    invariant2(context !== null && typeof context === "object", "effect context must be an object");
    const plans = impacts.map((impact) => {
      invariant2(impact !== null && typeof impact === "object", "impact must be an object");
      const { resourceKey, mutation } = impact;
      invariant2(
        typeof resourceKey === "string" && resourceKey.length > 0,
        "impact resourceKey must be a non-empty string"
      );
      invariant2(mutation !== null && typeof mutation === "object", "impact mutation must be an object");
      invariant2(MUTATION_KINDS.has(mutation.kind), `unsupported mutation kind: ${String(mutation.kind)}`);
      if (mutation.kind === "adjust-total") {
        invariant2(impacts.length === 1, "adjust-total is single-impact");
        invariant2(isSignedTokenCount(mutation.deltaTokens), "adjust-total deltaTokens must be a finite number");
        return { resourceKey, mutation, incomingTokens: 0 };
      }
      const fragments = mutation.fragments;
      invariant2(Array.isArray(fragments), "a fragment mutation must carry a fragments array");
      const seen = /* @__PURE__ */ new Set();
      let incomingTokens = 0;
      for (const fragment of fragments) {
        invariant2(fragment !== null && typeof fragment === "object", "fragment must be an object");
        invariant2(fragment.key !== void 0 && fragment.key !== null, "fragment key must be present");
        invariant2(!seen.has(fragment.key), `duplicate fragment key in one impact: ${String(fragment.key)}`);
        seen.add(fragment.key);
        invariant2(isTokenCount(fragment.tokens), "fragment tokens must be a non-negative finite number");
        incomingTokens += fragment.tokens;
      }
      return { resourceKey, mutation, incomingTokens };
    });
    const single = plans.length === 1;
    const perImpactOverhead = single && plans[0].mutation.kind === "adjust-total" ? 0 : effect.overheadTokens / plans.length;
    let injectedTotal = 0;
    for (const plan of plans) injectedTotal += plan.incomingTokens + perImpactOverhead;
    for (const plan of plans) {
      plan.overhead = perImpactOverhead;
      plan.spend = single ? effect.spentTokens : injectedTotal > 0 ? effect.spentTokens * ((plan.incomingTokens + perImpactOverhead) / injectedTotal) : effect.spentTokens / plans.length;
    }
    const before = /* @__PURE__ */ new Map();
    for (const plan of plans) {
      if (before.has(plan.resourceKey)) continue;
      const existing = resources.get(plan.resourceKey);
      before.set(plan.resourceKey, existing ? resourceTokensOf(existing) : 0);
    }
    const newResourceKeys = [];
    for (const plan of plans) {
      let resource = resources.get(plan.resourceKey);
      if (!resource) {
        resource = newResource();
        resources.set(plan.resourceKey, resource);
        newResourceKeys.push(plan.resourceKey);
      }
      const { mutation } = plan;
      if (mutation.kind === "replace-fragments") {
        resource.fragments = /* @__PURE__ */ new Map();
        resource.fragmentTotal = 0;
        resource.adjustment = 0;
        for (const fragment of mutation.fragments) setFragment(resource, fragment.key, fragment.tokens);
        resource.overhead = plan.overhead;
      } else if (mutation.kind === "merge-fragments") {
        for (const fragment of mutation.fragments) setFragment(resource, fragment.key, fragment.tokens);
        resource.overhead = plan.overhead;
      } else {
        resource.adjustment += mutation.deltaTokens;
      }
      const wholeContent = mutation.kind === "replace-fragments";
      if (wholeContent) resource.fullSnapshot = true;
      if (access === "write") {
        resource.wholeContentEligible = false;
      } else if (wholeContent) {
        if (resource.wholeContentEligible && plan.incomingTokens > 0) resource.pureRereads += 1;
        resource.wholeContentEligible = true;
      }
      if (plan.spend > 0) resource.accumulatedSpend += plan.spend;
      if (access === "write") resource.editCount += 1;
      else resource.readCount += 1;
      resource.lastTurn = context.turn;
      resource.lastCallSeq = context.foldedSeq;
      pushTouch(resource, context.foldedSeq, access === "write" ? "w" : "r");
    }
    const positiveResourceDeltas = [];
    for (const [resourceKey, beforeTokens] of before) {
      const growth = resourceTokensOf(resources.get(resourceKey)) - beforeTokens;
      if (growth > 0) positiveResourceDeltas.push({ resourceKey, growth });
    }
    return { newResourceKeys, positiveResourceDeltas, diagnostics: [] };
  }
  function applyResidualAllocation(allocation) {
    invariant2(allocation !== null && typeof allocation === "object", "allocation must be an object");
    const { groupKey, tokens, turn, foldedSeq, hadError, meta } = allocation;
    invariant2(
      typeof groupKey === "string" && groupKey.length > 0,
      "allocation groupKey must be a non-empty string"
    );
    invariant2(isTokenCount(tokens) && tokens > 0, "allocation tokens must be a positive finite number");
    let residual = residuals.get(groupKey);
    if (!residual) {
      residual = { tokens: 0, count: 0, lastTurn: 0, lastCallSeq: 0, touches: [], meta: null };
      residuals.set(groupKey, residual);
    }
    residual.tokens += tokens;
    residual.count += 1;
    residual.lastTurn = turn;
    residual.lastCallSeq = foldedSeq;
    pushTouch(residual, foldedSeq, hadError === true ? "e" : "w");
    residual.meta = meta ?? null;
  }
  function residentTotals() {
    const out2 = [];
    for (const [resourceKey, resource] of resources) {
      const tokens = resourceTokensOf(resource);
      if (tokens > 0) out2.push({ resourceKey, tokens });
    }
    return out2;
  }
  function snapshot() {
    return {
      resources: [...resources.entries()].map(([resourceKey, value]) => ({
        resourceKey,
        ...structuredClone(value)
      })),
      residuals: [...residuals.entries()].map(([groupKey, value]) => ({
        groupKey,
        ...structuredClone(value)
      }))
    };
  }
  return { applyEffect, applyResidualAllocation, residentTotals, snapshot };
}

// lib/measurement/engine.js
var USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
var SETTLEMENT_EPSILON = 1e-6;
function invariant3(ok, message) {
  if (!ok) throw new Error(`measurement engine invariant: ${message}`);
}
function isTokenCount2(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function emaStep(prevG, gInput) {
  const level = ALPHA_EMA * gInput + (1 - ALPHA_EMA) * prevG;
  return Math.max(prevG - G_DELTA_CAP, Math.min(prevG + G_DELTA_CAP, level));
}
function effectiveG(gEma) {
  return Math.max(Number.isFinite(gEma) ? gEma : G_FLOOR, G_FLOOR);
}
function deriveQuantities({ L, bDefault, cRatio, g }) {
  const baselineValid = bDefault > 0 && cRatio > 0;
  const x = baselineValid ? L / bDefault : 1;
  const dhat = baselineValid ? nucleus(cRatio, g, bDefault) : null;
  return { baselineValid, x, dhat };
}
function diagnostic2(code, message) {
  return { scope: "measurement-engine", code, message };
}
function createMeasurementEngine({ resolveModelPolicy, resolveResourcePolicy } = {}) {
  invariant3(typeof resolveModelPolicy === "function", "resolveModelPolicy must be a function");
  invariant3(typeof resolveResourcePolicy === "function", "resolveResourcePolicy must be a function");
  let segmentSeq = 0;
  let turnSeq = 0;
  let pendingTurn = false;
  let foldedSeq = 0;
  let calls = [];
  let epochModel = null;
  let latestMeasuredModel = null;
  let epochPolicy = null;
  let stepsById = /* @__PURE__ */ new Map();
  let segmentSteps = [];
  let pendingResiduals = [];
  let gEma = null;
  let ledger = createResidentLedger();
  let dead = 0;
  let sessionFloor = 0;
  let settlementCursor = null;
  let deferred = { total: 0, byPath: /* @__PURE__ */ new Map() };
  let resourceGrowth = /* @__PURE__ */ new Map();
  let resourceOverrides = /* @__PURE__ */ new Map();
  let resourcePolicyByKey = /* @__PURE__ */ new Map();
  let frames = [];
  let recordedTokens = /* @__PURE__ */ new Map();
  let defaultFold = null;
  let segmentStartTurn = 0;
  let segmentOutputSum = 0;
  let segmentUsageCount = 0;
  let segmentInputSum = 0;
  let segmentFirstTs = null;
  let segmentLastTs = null;
  let segmentLPeak = 0;
  let segmentGMin = Infinity;
  function openFreshSegment() {
    segmentSeq += 1;
    epochModel = null;
    latestMeasuredModel = null;
    epochPolicy = null;
    stepsById = /* @__PURE__ */ new Map();
    segmentSteps = [];
    pendingResiduals = [];
    gEma = G_FLOOR;
    ledger = createResidentLedger();
    dead = 0;
    sessionFloor = 0;
    settlementCursor = null;
    deferred = { total: 0, byPath: /* @__PURE__ */ new Map() };
    resourceGrowth = /* @__PURE__ */ new Map();
    resourceOverrides = /* @__PURE__ */ new Map();
    resourcePolicyByKey = /* @__PURE__ */ new Map();
    frames = [];
    recordedTokens = /* @__PURE__ */ new Map();
    defaultFold = null;
    segmentStartTurn = turnSeq;
    segmentOutputSum = 0;
    segmentUsageCount = 0;
    segmentInputSum = 0;
    segmentFirstTs = null;
    segmentLastTs = null;
    segmentLPeak = 0;
    segmentGMin = Infinity;
  }
  function readModelPolicy(raw) {
    if (raw === null || typeof raw !== "object") return null;
    const { cRatio, contextCapacity } = raw;
    if (!(typeof cRatio === "number" && Number.isFinite(cRatio) && cRatio > 0)) return null;
    if (!(typeof contextCapacity === "number" && Number.isFinite(contextCapacity) && contextCapacity > 0)) return null;
    return { cRatio, contextCapacity };
  }
  function resolveEpochPolicy(modelId, diagnostics) {
    let raw = null;
    try {
      raw = resolveModelPolicy(modelId);
    } catch (error) {
      diagnostics.push(diagnostic2("model_policy_failed", `model policy resolver threw: ${error.message}`));
    }
    const policy = readModelPolicy(raw);
    if (policy) return policy;
    diagnostics.push(diagnostic2(
      "model_policy_invalid",
      `model policy for ${String(modelId)} is unusable; falling back to the resolver default`
    ));
    let fallback = null;
    try {
      fallback = readModelPolicy(resolveModelPolicy(null));
    } catch (error) {
      diagnostics.push(diagnostic2("model_policy_failed", `default model policy resolver threw: ${error.message}`));
    }
    return fallback;
  }
  function resolveResourceEntry(resourceKey, diagnostics) {
    let raw = null;
    try {
      raw = resolveResourcePolicy(resourceKey);
    } catch (error) {
      diagnostics.push(diagnostic2("resource_policy_failed", `resource policy resolver threw: ${error.message}`));
    }
    if (raw === null || typeof raw !== "object" || typeof raw.selectedByDefault !== "boolean") {
      diagnostics.push(diagnostic2(
        "resource_policy_invalid",
        `resource policy for ${String(resourceKey)} is unusable; defaulting to selected`
      ));
      return { selectedByDefault: true, defaultDiscardReason: null };
    }
    const reason = raw.defaultDiscardReason;
    return {
      selectedByDefault: raw.selectedByDefault,
      defaultDiscardReason: typeof reason === "string" && reason.length > 0 ? reason : null
    };
  }
  function policySignature() {
    const parts2 = [epochPolicy ? epochPolicy.cRatio : null, epochPolicy ? epochPolicy.contextCapacity : null];
    for (const [resourceKey, entry] of resourcePolicyByKey) {
      parts2.push(resourceKey, entry.selectedByDefault, entry.defaultDiscardReason);
    }
    for (const [resourceKey, value] of resourceOverrides) parts2.push(resourceKey, value);
    return JSON.stringify(parts2);
  }
  function selectedUnder(overrides, resourceKey) {
    const override = overrides.get(resourceKey);
    if (override === "include") return true;
    if (override === "exclude") return false;
    const entry = resourcePolicyByKey.get(resourceKey);
    return entry ? entry.selectedByDefault : true;
  }
  function selectorOf(overrides) {
    return (resourceKey) => selectedUnder(overrides, resourceKey);
  }
  function isSelected(resourceKey) {
    return selectedUnder(resourceOverrides, resourceKey);
  }
  function recordFrame(step, growth) {
    const resourceTokens = /* @__PURE__ */ new Map();
    const totals = ledger.residentTotals();
    const present = /* @__PURE__ */ new Set();
    for (const { resourceKey, tokens } of totals) {
      present.add(resourceKey);
      if (recordedTokens.get(resourceKey) === tokens) continue;
      resourceTokens.set(resourceKey, tokens);
      recordedTokens.set(resourceKey, tokens);
    }
    for (const [resourceKey, tokens] of recordedTokens) {
      if (!(tokens > 0) || present.has(resourceKey)) continue;
      resourceTokens.set(resourceKey, 0);
      recordedTokens.set(resourceKey, 0);
    }
    const frame = { seq: step.foldedSeq, L: step.L, growth, resourceTokens };
    frames.push(frame);
    return frame;
  }
  function foldFor(selector) {
    return epochPolicy ? createPathFold({ dead, R: epochPolicy.cRatio, selector }) : null;
  }
  function stampOf(point) {
    return {
      bDefault: point.bDefault,
      x: point.x,
      u: point.u,
      pp: point.pp,
      mf: point.mf,
      mfLocal: point.mfLocal,
      br: point.br,
      deltaW: point.deltaW
    };
  }
  function scenarioPoints(selector) {
    const fold = foldFor(selector);
    return fold ? { points: frames.map((frame) => fold.push(frame)), gBar: fold.rate() } : { points: [], gBar: 0 };
  }
  function stampNewFrame(step, frame) {
    if (frames.length === 1) defaultFold = foldFor(isSelected);
    step.stamp = defaultFold ? stampOf(defaultFold.push(frame)) : null;
  }
  function restampSegment() {
    defaultFold = foldFor(isSelected);
    const bySeq = new Map(segmentSteps.map((step) => [step.foldedSeq, step]));
    for (const step of segmentSteps) step.stamp = null;
    if (!defaultFold) return;
    for (const frame of frames) bySeq.get(frame.seq).stamp = stampOf(defaultFold.push(frame));
  }
  function stampedPoints() {
    const points = [];
    for (const step of segmentSteps) if (step.stamp) points.push(step.stamp);
    return points;
  }
  function describeScenario(points) {
    const last = points[points.length - 1];
    const relabelled = points.map((p) => ({ u: p.u, pp: p.pp, x: 1 + (p.x - 1) * p.bDefault / last.bDefault }));
    const fit = fitAffine(relabelled);
    return {
      u: last.u,
      pp: last.pp,
      mf: last.mf,
      mfLocal: last.mfLocal,
      br: last.br,
      bDefault: last.bDefault,
      reference: fit ? { a: fit.a, d: fit.d, provisional: last.u < 1 } : null,
      ...landmarksOf(fit, last.mf)
    };
  }
  function bDefaultOf(totals) {
    let sum = dead;
    for (const { resourceKey, tokens } of totals) if (isSelected(resourceKey)) sum += tokens;
    return sum;
  }
  function residentTotalOf(totals) {
    let sum = dead;
    for (const { tokens } of totals) sum += tokens;
    return sum;
  }
  function readUsage(raw) {
    invariant3(raw !== null && typeof raw === "object", "step usage must be an object");
    for (const key of USAGE_KEYS) {
      invariant3(isTokenCount2(raw[key]), `step usage ${key} must be a non-negative finite number`);
    }
    return { input: raw.input, output: raw.output, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite };
  }
  function readTimestamp(raw) {
    if (raw === void 0 || raw === null) return null;
    invariant3(typeof raw === "number" && Number.isFinite(raw), "step timestamp must be a finite number or null");
    return raw;
  }
  function ingestResidual(record) {
    invariant3(
      typeof record.groupKey === "string" && record.groupKey.length > 0,
      "residual groupKey must be a non-empty string"
    );
    invariant3(isTokenCount2(record.weight), "residual weight must be a non-negative finite number");
    pendingResiduals.push({
      groupKey: record.groupKey,
      weight: record.weight,
      hadError: record.hadError === true,
      meta: record.meta ?? null,
      turn: turnSeq,
      foldedSeq
    });
  }
  function ingestEffect(record, result) {
    const applied = ledger.applyEffect(record, { turn: turnSeq, foldedSeq });
    for (const { resourceKey, growth } of applied.positiveResourceDeltas) {
      resourceGrowth.set(resourceKey, (resourceGrowth.get(resourceKey) || 0) + growth);
    }
    for (const resourceKey of applied.newResourceKeys) {
      result.newResourceKeys.push(resourceKey);
      resourcePolicyByKey.set(resourceKey, resolveResourceEntry(resourceKey, result.diagnostics));
    }
    for (const entry of applied.diagnostics) result.diagnostics.push(entry);
  }
  function reviseStep(existing, record, usage, usageTotal, timestamp, result) {
    if (record.model !== void 0 && record.model !== existing.model) {
      result.diagnostics.push(diagnostic2(
        "step_model_conflict",
        `step ${existing.id} keeps its accepted model ${String(existing.model)}`
      ));
    }
    if (usageTotal < existing.usageTotal) {
      result.diagnostics.push(diagnostic2(
        "usage_revision_ignored",
        `step ${existing.id} keeps its higher-total usage`
      ));
      return;
    }
    segmentOutputSum += usage.output - existing.usage.output;
    segmentInputSum += usage.input - existing.usage.input;
    existing.usage = usage;
    existing.usageTotal = usageTotal;
    existing.timestamp = timestamp;
    if (Number.isFinite(timestamp)) segmentLastTs = timestamp;
    result.revisedCalls += 1;
  }
  function settle({ L, totalStock, residentTotal, totals }) {
    const cursor = settlementCursor;
    const deltaResident = residentTotal - cursor.residentTotal;
    const resourceDeltas = /* @__PURE__ */ new Map();
    const present = /* @__PURE__ */ new Set();
    for (const { resourceKey, tokens } of totals) {
      present.add(resourceKey);
      const delta = tokens - (cursor.resourceTotals.get(resourceKey) ?? 0);
      if (delta !== 0) resourceDeltas.set(resourceKey, delta);
    }
    for (const [resourceKey, tokens] of cursor.resourceTotals) {
      if (!present.has(resourceKey)) resourceDeltas.set(resourceKey, -tokens);
    }
    let deltaL = L - cursor.L;
    if (cursor.L < sessionFloor && deltaL > 0) deltaL = Math.max(0, L - sessionFloor);
    const pathDeltas = resourceGrowth;
    let attributable = 0;
    for (const d of pathDeltas.values()) if (d > 0) attributable += d;
    const trialDeferred = { total: deferred.total, byPath: new Map(deferred.byPath) };
    const settled = settleDeferred(deltaL, deltaResident, pathDeltas, trialDeferred);
    const escaped = settled.banked - attributable;
    invariant3(
      escaped <= SETTLEMENT_EPSILON,
      `resident growth of ${escaped} escaped per-resource attribution and cannot be banked`
    );
    deferred = trialDeferred;
    resourceGrowth = /* @__PURE__ */ new Map();
    let deltaStock = totalStock - cursor.totalStock;
    if (cursor.totalStock < sessionFloor && deltaStock > 0) deltaStock = Math.max(0, totalStock - sessionFloor);
    const unplacedGrowth = Math.max(0, deltaStock - deltaResident);
    gEma = emaStep(gEma, unplacedGrowth);
    distributeResidual(unplacedGrowth);
    return { stock: deltaStock, resources: resourceDeltas };
  }
  function distributeResidual(residual) {
    if (pendingResiduals.length === 0) return;
    const candidates = pendingResiduals;
    pendingResiduals = [];
    if (!(residual > 0)) return;
    let totalWeight = 0;
    for (const candidate of candidates) totalWeight += candidate.weight;
    for (const candidate of candidates) {
      const tokens = totalWeight > 0 ? residual * (candidate.weight / totalWeight) : residual / candidates.length;
      if (!(tokens > 0)) continue;
      ledger.applyResidualAllocation({
        groupKey: candidate.groupKey,
        tokens,
        turn: candidate.turn,
        foldedSeq: candidate.foldedSeq,
        hadError: candidate.hadError,
        meta: candidate.meta
      });
    }
  }
  function updateSegmentExtrema(L) {
    segmentLPeak = Math.max(segmentLPeak, L);
    segmentGMin = Math.min(segmentGMin, effectiveG(gEma));
  }
  function acceptNewStep(record, usage, usageTotal, timestamp, result) {
    const totalStock = usage.input + usage.cacheRead + usage.cacheWrite;
    const model = record.model ?? null;
    const firstOfEpoch = segmentSteps.length === 0;
    if (settlementCursor === null && totalStock > 0) {
      dead = totalStock;
      sessionFloor = totalStock;
    }
    const totals = ledger.residentTotals();
    const residentTotal = residentTotalOf(totals);
    const miss = settlementCursor !== null && classifyMiss({ cacheRead: usage.cacheRead, prevL: settlementCursor.L });
    const L = miss ? totalStock : usage.cacheRead;
    let growth = null;
    if (settlementCursor !== null) {
      growth = settle({ L, totalStock, residentTotal, totals });
    } else {
      if (gEma === null) gEma = G_FLOOR;
      resourceGrowth = /* @__PURE__ */ new Map();
    }
    if (pendingTurn || turnSeq === 0) {
      turnSeq += 1;
      pendingTurn = false;
    }
    foldedSeq += 1;
    if (firstOfEpoch) {
      epochModel = model;
      epochPolicy = resolveEpochPolicy(model, result.diagnostics);
    }
    latestMeasuredModel = model;
    const step = {
      id: record.id,
      model,
      timestamp,
      usage,
      usageTotal,
      segment: segmentSeq,
      L,
      miss,
      // Read-time cap for the display point: the belief may lead total stock during the cache-warm lag,
      // and the invariant-safe value is what a chart may show. The cursor below keeps the uncapped belief
      // so the next step's Δresident stays correct.
      bAtCall: Math.min(residentTotal, totalStock),
      gAtCall: effectiveG(gEma),
      turn: turnSeq,
      foldedSeq,
      stamp: null
    };
    stepsById.set(step.id, step);
    segmentSteps.push(step);
    calls.push(step);
    segmentOutputSum += usage.output;
    segmentUsageCount += 1;
    segmentInputSum += usage.input;
    if (Number.isFinite(timestamp)) {
      if (segmentFirstTs === null) segmentFirstTs = timestamp;
      segmentLastTs = timestamp;
    }
    updateSegmentExtrema(L);
    if (totalStock > 0) {
      settlementCursor = { L, totalStock, residentTotal, resourceTotals: new Map(totals.map((t) => [t.resourceKey, t.tokens])) };
      stampNewFrame(step, recordFrame(step, growth));
    }
    result.newCalls += 1;
  }
  function ingestStep(record, result) {
    invariant3(typeof record.id === "string" && record.id.length > 0, "step id must be a non-empty string");
    const usage = readUsage(record.usage);
    const timestamp = readTimestamp(record.timestamp);
    let usageTotal = 0;
    for (const key of USAGE_KEYS) usageTotal += usage[key];
    const existing = stepsById.get(record.id);
    if (existing) {
      reviseStep(existing, record, usage, usageTotal, timestamp, result);
      return;
    }
    acceptNewStep(record, usage, usageTotal, timestamp, result);
  }
  function ingest(records) {
    invariant3(Array.isArray(records), "ingest requires an array of records");
    const result = {
      newCalls: 0,
      revisedCalls: 0,
      newResourceKeys: [],
      closedSegments: [],
      diagnostics: []
    };
    for (const record of records) {
      invariant3(record !== null && typeof record === "object", "record must be an object");
      switch (record.type) {
        case "turn-boundary":
          pendingTurn = true;
          break;
        case "epoch": {
          const closed = finalizeSegment();
          if (closed) result.closedSegments.push(closed);
          break;
        }
        case "residual":
          ingestResidual(record);
          break;
        case "effect":
          ingestEffect(record, result);
          break;
        case "step":
          ingestStep(record, result);
          break;
        default:
          invariant3(false, `unsupported record type: ${String(record.type)}`);
      }
    }
    return result;
  }
  function finalizeSegment() {
    if (segmentSteps.length === 0) {
      openFreshSegment();
      return null;
    }
    const closing = ledger.snapshot();
    const corrections = new Map(deferred.byPath);
    const steps = segmentSteps.map((step) => ({
      id: step.id,
      foldedSeq: step.foldedSeq,
      timestamp: step.timestamp,
      usage: { ...step.usage }
    }));
    const closingDead = dead;
    const paths = [];
    let bTotal = closingDead;
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource, corrections.get(resource.resourceKey) || 0);
      if (!(tokens > 0)) continue;
      paths.push({ path: resource.resourceKey, tokens });
      bTotal += tokens;
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    const g = effectiveG(gEma);
    let brPeak = 0, ppPeak = 0, turnAtBrAmber = null, last = null;
    for (const step of segmentSteps) {
      if (!step.stamp) continue;
      last = step.stamp;
      brPeak = Math.max(brPeak, step.stamp.br);
      if (turnAtBrAmber === null && step.stamp.u >= 1 && step.stamp.br >= BR_AMBER) {
        turnAtBrAmber = step.turn - segmentStartTurn;
      }
      ppPeak = Math.max(ppPeak, step.stamp.pp);
    }
    const oAvg = segmentUsageCount > 0 ? segmentOutputSum / segmentUsageCount : null;
    const durationMs = Number.isFinite(segmentFirstTs) && Number.isFinite(segmentLastTs) ? segmentLastTs - segmentFirstTs : null;
    const closed = {
      segment: segmentSeq,
      epochModel,
      steps,
      metrics: {
        lFloor: closingDead,
        bTotal,
        lPeak: segmentLPeak,
        gFinal: g,
        oAvg,
        cRatio,
        turns: turnSeq - segmentStartTurn,
        durationMs,
        totalTokensRead: Number.isFinite(segmentInputSum) ? segmentInputSum : null,
        mf: last ? last.mf : null,
        ppExit: last ? last.pp : null,
        brExit: last ? last.br : null,
        brPeak,
        ppPeak,
        p0: cRatio > 0 && g > 0 ? closingDead / (cRatio * g) : null,
        bAxis: g > 0 && segmentUsageCount > 0 ? 2 * oAvg / g : null,
        xAxis: closingDead > 0 ? segmentLPeak / closingDead : null,
        gMin: Number.isFinite(segmentGMin) ? segmentGMin : null,
        turnAtBrAmber
      },
      paths
    };
    openFreshSegment();
    return closed;
  }
  function closeCurrentSegment() {
    const closed = finalizeSegment();
    return { closedSegments: closed ? [closed] : [], diagnostics: [] };
  }
  function readView() {
    const lastStep = segmentSteps.length ? segmentSteps[segmentSteps.length - 1] : null;
    const stamp = lastStep ? lastStep.stamp : null;
    const L = lastStep ? lastStep.L : 0;
    const B = lastStep ? lastStep.bAtCall : 0;
    const bDefault = stamp ? stamp.bDefault : 0;
    const g = effectiveG(gEma);
    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    const q = deriveQuantities({ L, bDefault, cRatio: cRatio ?? 0, g: defaultFold ? defaultFold.rate() : 0 });
    const lCap = epochPolicy ? epochPolicy.contextCapacity - RESERVED_OUTPUT - CTX_SAFETY_MARGIN : null;
    const scenario = q.baselineValid && stamp ? describeScenario(stampedPoints()) : null;
    const rateLamp = scenario ? {
      reliable: true,
      basis: "fullCarry",
      L_read: L,
      L_cap: lCap,
      B_post: B,
      B_rebuild: B,
      B_default: bDefault,
      C_RATIO: cRatio,
      x_display: q.x,
      dhat: q.dhat,
      uInst: q.dhat > 0 ? (q.x - 1) / q.dhat : null,
      gEma: g,
      ...scenario
    } : { reliable: false, unavailableReason: "insufficient_data" };
    return {
      x: q.x,
      dhat: q.dhat,
      L,
      B,
      bDefault,
      g,
      cRatio,
      rateLamp,
      u: scenario ? scenario.u : null,
      pp: scenario ? scenario.pp : null,
      mf: scenario ? scenario.mf : null,
      br: scenario ? scenario.br : null,
      xSweet: scenario ? scenario.xSweet : null,
      totalStock: settlementCursor ? settlementCursor.totalStock : 0,
      usage: lastStep ? { ...lastStep.usage } : null
    };
  }
  function getStatus() {
    const view = readView();
    return {
      L: view.L,
      B: view.B,
      bDefault: view.bDefault,
      g: view.g,
      x: view.x,
      dhat: view.dhat,
      xSweet: view.xSweet,
      u: view.u,
      pp: view.pp,
      mf: view.mf,
      br: view.br,
      model: epochModel,
      latestMeasuredModel,
      cRatio: view.cRatio,
      segment: segmentSeq,
      apiCalls: segmentSteps.length,
      turnSeq,
      usage: view.usage,
      rateLamp: view.rateLamp
    };
  }
  function getHistory() {
    return calls.map((step) => {
      const B = step.bAtCall;
      const L = step.usage.input + step.usage.cacheRead + step.usage.cacheWrite;
      return {
        ts: step.timestamp,
        segment: step.segment,
        L,
        B,
        x: step.stamp ? step.stamp.x : 1,
        bDefault: step.stamp ? step.stamp.bDefault : null,
        u: step.stamp ? step.stamp.u : null,
        pp: step.stamp ? step.stamp.pp : null,
        g: step.gAtCall,
        miss: step.miss === true,
        cacheRead: step.usage.cacheRead,
        cacheWrite: step.usage.cacheWrite,
        turnSeq: step.turn,
        foldedSeq: step.foldedSeq
      };
    });
  }
  function lineNumbersOf(resource) {
    const out2 = [];
    for (const key of resource.fragments.keys()) if (typeof key === "number" && Number.isFinite(key)) out2.push(key);
    return out2.sort((a, b) => a - b);
  }
  function getBucketData() {
    const totals = ledger.residentTotals();
    const residentTotal = residentTotalOf(totals);
    const totalStock = settlementCursor ? settlementCursor.totalStock : 0;
    const B = settlementCursor ? Math.min(residentTotal, totalStock) : residentTotal;
    const lastStep = segmentSteps.length ? segmentSteps[segmentSteps.length - 1] : null;
    const closing = ledger.snapshot();
    const paths = [];
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource);
      if (!(tokens > 0)) continue;
      const totalSpent = Math.max(tokens, Math.round(resource.accumulatedSpend));
      const entry = resourcePolicyByKey.get(resource.resourceKey);
      paths.push({
        path: resource.resourceKey,
        tokens,
        lastTurn: resource.lastTurn,
        lastCallSeq: resource.lastCallSeq,
        totalSpent,
        churn: totalSpent / tokens,
        efficiency: Math.round(tokens / totalSpent * 100),
        readCount: resource.readCount,
        editCount: resource.editCount,
        touchSeqs: resource.touches,
        pureRereads: resource.pureRereads,
        defaultSelected: entry ? entry.selectedByDefault : true,
        defaultDiscardReason: entry ? entry.defaultDiscardReason : null,
        userOverride: resourceOverrides.get(resource.resourceKey) || null,
        lineNumbers: lineNumbersOf(resource),
        fullSnapshot: resource.fullSnapshot
      });
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    const residual = closing.residuals.map((group) => ({
      groupKey: group.groupKey,
      tokens: group.tokens,
      count: group.count,
      lastTurn: group.lastTurn,
      lastCallSeq: group.lastCallSeq,
      touchSeqs: group.touches,
      meta: group.meta
    })).sort((a, b) => b.tokens - a.tokens);
    return {
      dead,
      paths,
      residual,
      totalB: B,
      totalL: lastStep ? lastStep.L : 0,
      bDefault: bDefaultOf(totals),
      // Read off the same cursor stock the residual candidates are drawn from, not off L: the
      // remainder a consumer derives by subtracting the allocated groups from this total then sits
      // on the channel those groups came from, where a cacheRead-channel total would fall short by
      // a tool result the stock already carries.
      totalResidualRaw: totalStock - B,
      totalResidual: Math.max(0, totalStock - B),
      currentTurnSeq: turnSeq,
      segment: segmentSeq
    };
  }
  function getHandoffMeasurement() {
    const view = readView();
    const closing = ledger.snapshot();
    const paths = [];
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource);
      if (!(tokens > 0)) continue;
      paths.push({
        path: resource.resourceKey,
        tokens,
        lastTurn: resource.lastTurn,
        fullSnapshot: resource.fullSnapshot,
        lineNumbers: lineNumbersOf(resource)
      });
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    return {
      segment: segmentSeq,
      turnSeq,
      epochModel,
      measurement: {
        L: view.L,
        B: view.B,
        bDefault: view.bDefault,
        g: view.g,
        gBar: defaultFold ? defaultFold.rate() : 0,
        mf: view.mf,
        br: view.br,
        u: view.u,
        pp: view.pp,
        x: view.x,
        dhat: view.dhat,
        cRatio: view.cRatio,
        dead,
        sessionFloor
      },
      paths
    };
  }
  function readRateLampFrame(sinceFoldedSeq) {
    const view = readView();
    const samples = [];
    for (const step of segmentSteps) {
      if (!(step.foldedSeq > sinceFoldedSeq)) continue;
      const sample = { seq: step.foldedSeq, reliable: view.rateLamp.reliable, turnSeq: step.turn, L_read: step.L };
      if (view.rateLamp.reliable) {
        sample.deltaW = step.stamp ? step.stamp.deltaW : null;
        sample.mf = step.stamp ? step.stamp.mfLocal : null;
      } else {
        sample.unavailableReason = view.rateLamp.unavailableReason;
      }
      samples.push(sample);
    }
    return {
      status: view.rateLamp,
      progress: { segment: segmentSeq, measuredCalls: segmentSteps.length, sinceFoldedSeq },
      samples,
      turnSeq,
      foldedCallSeq: foldedSeq
    };
  }
  function parseOverrides(overrides) {
    invariant3(
      overrides !== null && typeof overrides === "object" && !Array.isArray(overrides),
      "resource overrides must be a plain object"
    );
    const warnings = [];
    const known = new Set(ledger.residentTotals().map((total) => total.resourceKey));
    const next = /* @__PURE__ */ new Map();
    for (const [resourceKey, value] of Object.entries(overrides)) {
      if (!resourceKey || !known.has(resourceKey)) {
        warnings.push({ code: "unknown_resource", resourceKey, value });
        continue;
      }
      if (value !== "include" && value !== "exclude") {
        warnings.push({ code: "invalid_override_value", resourceKey, value });
        continue;
      }
      next.set(resourceKey, value);
    }
    return { next, warnings };
  }
  function replaceResourceOverrides(overrides) {
    const { next, warnings } = parseOverrides(overrides);
    let changed = next.size !== resourceOverrides.size;
    if (!changed) {
      for (const [resourceKey, value] of next) {
        if (resourceOverrides.get(resourceKey) !== value) {
          changed = true;
          break;
        }
      }
    }
    resourceOverrides = next;
    if (changed) restampSegment();
    return { changed, warnings, diagnostics: [] };
  }
  function refreshReadPolicies() {
    const diagnostics = [];
    const before = policySignature();
    if (segmentSteps.length > 0) epochPolicy = resolveEpochPolicy(epochModel, diagnostics);
    for (const resourceKey of [...resourcePolicyByKey.keys()]) {
      resourcePolicyByKey.set(resourceKey, resolveResourceEntry(resourceKey, diagnostics));
    }
    const changed = policySignature() !== before;
    if (changed) restampSegment();
    return { changed, diagnostics };
  }
  function readScenario(overrides) {
    const { next, warnings } = parseOverrides(overrides);
    const view = readView();
    if (!view.rateLamp.reliable) return { reliable: false };
    const { points, gBar } = scenarioPoints(selectorOf(next));
    return {
      reliable: true,
      gBar,
      trajectory: points.filter((p) => p.pp !== null).map((p) => ({ seq: p.seq, x: p.x, u: p.u, pp: p.pp })),
      ...describeScenario(points),
      wallP: wallPositionFor(view.cRatio),
      warnings
    };
  }
  return {
    ingest,
    closeCurrentSegment,
    getStatus,
    getHistory,
    getBucketData,
    getHandoffMeasurement,
    readRateLampFrame,
    readScenario,
    replaceResourceOverrides,
    refreshReadPolicies
  };
}

// lib/model-policy.js
var CTP_VERSION = 1;
function ctpFor(modelId) {
  const id = String(modelId || "");
  const ctp = CTP_TABLE.find((row) => row.match.test(id)) ?? DEFAULT_CTP;
  return { ascii: ctp.ascii, cjk: ctp.cjk, version: CTP_VERSION };
}
function cRatioFor(modelId, ttl) {
  const hit = C_RATIO_TABLE.find((r) => r.match.test(modelId));
  if (!hit) return DEFAULT_C_RATIO;
  if (typeof hit.ratio === "number") return hit.ratio;
  return Object.hasOwn(hit.ratio, ttl) ? hit.ratio[ttl] : hit.ratio[DEFAULT_CACHE_TTL];
}
function contextCapacityFor(modelId) {
  const hit = CONTEXT_WINDOW_TABLE.find((r) => r.match.test(modelId));
  return hit ? hit.window : DEFAULT_CONTEXT_WINDOW;
}
function pricingFor() {
  return {
    readPrice: null,
    writePrice: null,
    presets: MODEL_PRICING_PRESETS.map((preset) => ({ ...preset }))
  };
}
function modelPolicyFor(modelId, ttl) {
  const id = String(modelId ?? "");
  return {
    ctp: ctpFor(id),
    cRatio: cRatioFor(id, ttl),
    contextCapacity: contextCapacityFor(id),
    get pricing() {
      return pricingFor();
    }
  };
}

// lib/pricing-store.js
function tryGetStore() {
  try {
    return getStore();
  } catch {
    return null;
  }
}
var PRESET_ID_MAX_CHARS = 80;
var NO_MODEL_MESSAGE = "Model not yet detected; retry after first API call";
function sanitizePresetId(presetId) {
  return typeof presetId === "string" && presetId.length > 0 && presetId.length <= PRESET_ID_MAX_CHARS ? presetId : null;
}
function validatePricingInput({ readPrice, writePrice }) {
  if (!Number.isFinite(readPrice) || !Number.isFinite(writePrice))
    throw new Error("readPrice and writePrice must be finite numbers");
  if (readPrice <= 0) throw new Error("readPrice must be > 0");
  if (writePrice <= 0) throw new Error("writePrice must be > 0");
  const ratio = writePrice / readPrice;
  if (ratio < 1) throw new Error("ratio (write/read) must be >= 1");
  return ratio;
}
function savePricingOverride(model, { readPrice, writePrice, presetId }) {
  const ratio = validatePricingInput({ readPrice, writePrice });
  const record = { readPrice, writePrice, ratio, savedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (presetId != null) record.presetId = presetId;
  getStore().saveConfig(`pricing:${model}`, record);
  return record;
}
function loadPricingOverride(model) {
  const store = tryGetStore();
  if (!store) return null;
  const data = store.loadConfig(`pricing:${model}`);
  if (!data) return null;
  if (!Number.isFinite(data.ratio) || data.ratio < 1) return null;
  if (!Number.isFinite(data.readPrice) || data.readPrice <= 0) return null;
  if (!Number.isFinite(data.writePrice) || data.writePrice <= 0) return null;
  return data;
}
function deletePricingOverride(model) {
  getStore().deleteConfig(`pricing:${model}`);
}

// package.json
var package_default = {
  name: "@nomadop/session-watcher",
  version: "0.9.1",
  description: "Local Claude Code context-cost monitor, transcript replay, buckets, and handoff",
  type: "module",
  license: "MIT",
  author: "Longju Cheng",
  repository: {
    type: "git",
    url: "git+https://github.com/nomadop/session-watcher.git"
  },
  homepage: "https://nomadop.github.io/session-watcher/",
  bugs: {
    url: "https://github.com/nomadop/session-watcher/issues"
  },
  keywords: [
    "claude-code",
    "context-window",
    "prompt-caching",
    "transcript-replay",
    "handoff",
    "mcp",
    "developer-tools"
  ],
  bin: {
    "session-watcher": "./dist/bin/session-watcher.js"
  },
  files: [
    "dist/bin/",
    "dist/public/",
    "README.md",
    "LICENSE"
  ],
  publishConfig: {
    access: "public"
  },
  scripts: {
    build: "node scripts/build.js",
    "docs:build": "node scripts/build-pages.mjs",
    "docs:preview": "node scripts/build-pages.mjs && npx -y serve .pages",
    test: 'node --test "test/**/*.test.js"',
    "test:watch": 'node --test --watch "test/**/*.test.js"',
    start: "node server.js",
    e2e: "playwright test"
  },
  engines: {
    node: ">=22.16.0"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "^1.0.0",
    express: "^4.19.2",
    ignore: "^7.0.6",
    "web-tree-sitter": "^0.26.11",
    zod: "^3.23.8"
  },
  devDependencies: {
    "@playwright/test": "^1.45.0",
    "chart.js": "^4.5.1",
    esbuild: "^0.28.1",
    "github-slugger": "^2.0.0",
    katex: "^0.17.0",
    marked: "^18.0.7",
    "marked-katex-extension": "^5.1.10",
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    "tree-sitter-javascript": "^0.25.0",
    "tree-sitter-python": "^0.25.0",
    "tree-sitter-typescript": "^0.23.2"
  },
  overrides: {
    "tree-sitter-javascript": "$tree-sitter-javascript"
  }
};

// lib/version.js
var PLUGIN_VERSION = package_default.version;

// lib/harness/dsh/transcript-observation.js
var SCOPE = "dsh-transcript-observation";
var MESSAGE_NAMESPACE = "dsh:message:";
var isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var isIndex = (value) => Number.isSafeInteger(value) && value >= 0;
var isId = (value) => typeof value === "string" && value !== "";
var isSurfaceOp = (value) => value === "append" || isObject(value) && value.op === "replace";
var nothing = () => ({ observations: [], diagnostics: [] });
function violation(event, field) {
  const at = isIndex(event.seq) ? ` at seq ${event.seq}` : "";
  return {
    observations: [],
    diagnostics: [{ scope: SCOPE, code: "shape-violation", message: `${event.type}${at}: malformed ${field}` }]
  };
}
function faultOf(checks) {
  return checks.find(([, holds]) => !holds)?.[0] ?? null;
}
function envelopeChecks(event) {
  return [["seq", isIndex(event.seq)], ["time", Number.isFinite(event.time)]];
}
function baseOf(event) {
  return { sourceOrdinal: event.seq, sourceEntryId: String(event.seq), timestamp: event.time };
}
var textShaped = (block) => block.type !== "text" || typeof block.text === "string";
var toolCallShaped = (block) => block.type !== "tool-call" || isId(block.id) && typeof block.name === "string" && typeof block.arguments === "string";
function isContent(content, ...shapes) {
  return Array.isArray(content) && content.every((block) => isObject(block) && shapes.every((shaped) => shaped(block)));
}
function textOf(content) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function callIdOf(turn, step, id) {
  return `${turn}:${step}:${id}`;
}
function parseArguments(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}
function isUsage(usage) {
  return isObject(usage) && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) && (usage.cacheReadTokens === void 0 || Number.isFinite(usage.cacheReadTokens)) && (usage.cacheWriteTokens === void 0 || Number.isFinite(usage.cacheWriteTokens));
}
function usageOf(usage) {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0
  };
}
function reduceHumanMessage(event) {
  const { data } = event;
  const fault = faultOf([
    ...envelopeChecks(event),
    ["data.id", isId(data.id)],
    ["data.content", isContent(data.content, textShaped)]
  ]);
  if (fault !== null) return violation(event, fault);
  const base = baseOf(event);
  const observations = [{ type: "turn-boundary", ...base, provenance: "human" }];
  const text = textOf(data.content);
  if (text !== "") {
    observations.push({
      type: "text",
      role: "human",
      text,
      messageId: MESSAGE_NAMESPACE + data.id,
      ...base,
      provenance: "human"
    });
  }
  return { observations, diagnostics: [] };
}
function reduceCheckpoint(event) {
  if (!isSurfaceOp(event.surfaceOp)) return violation(event, "surfaceOp");
  if (event.surfaceOp === "append") return nothing();
  const fault = faultOf(envelopeChecks(event));
  if (fault !== null) return violation(event, fault);
  return { observations: [{ type: "epoch-boundary", ...baseOf(event), provenance: "harness" }], diagnostics: [] };
}
function reduceUserMessage(event) {
  const kind = event.data?.source?.kind;
  if (kind === "user") return reduceHumanMessage(event);
  if (kind === "compact-checkpoint") return reduceCheckpoint(event);
  return typeof kind === "string" ? nothing() : violation(event, "data.source.kind");
}
function reduceAssistantMessage(event) {
  const { data } = event;
  const message = data?.message;
  const fault = faultOf([
    ...envelopeChecks(event),
    ["data.turn", isIndex(data?.turn)],
    ["data.step", isIndex(data?.step)],
    ["data.message.id", isId(message?.id)],
    ["data.message.source.model", typeof message?.source?.model === "string"],
    ["data.message.content", isContent(message?.content, textShaped, toolCallShaped)],
    ["data.usage", data?.usage === void 0 || isUsage(data.usage)]
  ]);
  if (fault !== null) return violation(event, fault);
  const base = baseOf(event);
  const messageId = MESSAGE_NAMESPACE + message.id;
  const model = message.source.model;
  const observations = [];
  const text = textOf(message.content);
  if (text !== "") {
    observations.push({ type: "text", role: "assistant", text, messageId, ...base, provenance: "assistant" });
  }
  for (const block of message.content) {
    if (block.type !== "tool-call") continue;
    observations.push({
      type: "tool-use",
      messageId,
      model,
      cwd: null,
      toolUseId: callIdOf(data.turn, data.step, block.id),
      name: block.name,
      input: parseArguments(block.arguments),
      ...base,
      provenance: "assistant"
    });
  }
  if (data.usage !== void 0) {
    observations.push({
      type: "usage",
      messageId,
      model,
      usage: usageOf(data.usage),
      ...base,
      provenance: "assistant"
    });
  }
  return { observations, diagnostics: [] };
}
function reduceToolResult(event) {
  if (!isSurfaceOp(event.surfaceOp)) return violation(event, "surfaceOp");
  if (event.surfaceOp !== "append") return nothing();
  const { data } = event;
  const message = data?.message;
  const fault = faultOf([
    ...envelopeChecks(event),
    ["data.turn", isIndex(data?.turn)],
    ["data.step", isIndex(data?.step)],
    ["data.message.toolCallId", isId(message?.toolCallId)],
    ["data.message.isError", message?.isError === void 0 || typeof message.isError === "boolean"],
    ["data.message.content", isContent(message?.content, textShaped)]
  ]);
  if (fault !== null) return violation(event, fault);
  return {
    observations: [{
      type: "tool-result",
      toolUseId: callIdOf(data.turn, data.step, message.toolCallId),
      content: textOf(message.content),
      isError: message.isError,
      // The tool's private metadata and failure identity ride uninterpreted, as Claude Code's
      // `toolUseResult` does.
      resultMeta: { meta: data.meta ?? null, error: data.error ?? null },
      ...baseOf(event),
      provenance: "harness"
    }],
    diagnostics: []
  };
}
function reduceDshEvent(event) {
  switch (event.type) {
    case "user/message":
      return reduceUserMessage(event);
    case "assistant/message":
      return reduceAssistantMessage(event);
    case "tool/result":
      return reduceToolResult(event);
    default:
      return nothing();
  }
}
function reduceDshSnapshot(events) {
  const batches = [];
  const diagnostics = [];
  for (const event of events) {
    const reduced = reduceDshEvent(event);
    if (reduced.observations.length > 0) batches.push(reduced.observations);
    diagnostics.push(...reduced.diagnostics);
  }
  return { batches, observations: batches.flat(), diagnostics };
}

// lib/harness/dsh/dialogue-source.js
function createDshDialogueSource({ readSession }) {
  return {
    async read(sessionId) {
      let snapshot;
      try {
        snapshot = await readSession(sessionId);
      } catch {
        return { status: "unavailable", observations: [] };
      }
      return { status: "ok", observations: reduceDshSnapshot(snapshot.events).observations };
    }
  };
}

// lib/harness/dsh/history-turn-rules.js
import { isAbsolute as isAbsolute3, normalize as normalize2, resolve as resolve2 } from "node:path";

// lib/bash-feature.js
var LEADING_COMMENT_RE = /^(\s*#[^\n]*(\n|$))+/;
var DISPLAY_CHARS = 40;
var CD_PREAMBLE_RE = /^cd\s+(\S+)\s*(?:&&|;)\s*/;
var ECHO_PREAMBLE_RE = /^echo\s+("[^"$`\\\n]*"|'[^'\n]*'|[^\s"'$`;&|<>]+)\s*(?:&&|;)\s*/;
var FN_PREAMBLE_RE = /^fn\w+\s*&&\s*/;
function stripShellPreamble(command) {
  let rest = String(command || "").trim().replace(LEADING_COMMENT_RE, "").trim();
  let effectiveCwd = null;
  let headerLines = 0;
  for (; ; ) {
    let m = rest.match(CD_PREAMBLE_RE);
    if (m) {
      effectiveCwd = m[1];
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(ECHO_PREAMBLE_RE);
    if (m) {
      headerLines += 1;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(FN_PREAMBLE_RE);
    if (m) {
      rest = rest.slice(m[0].length);
      continue;
    }
    return { rest, effectiveCwd, headerLines };
  }
}
var SED_LINE_DROP_RE = /^sed\s+-n\s+(?:-e\s+)?(['"]?)[\d,$p;\s]+\1$/;
function splitByPipe(s) {
  const stages = [];
  let current = "";
  let i2 = 0;
  while (i2 < s.length) {
    if (s[i2] === '"') {
      current += s[i2++];
      while (i2 < s.length && s[i2] !== '"') {
        if (s[i2] === "\\") {
          current += s[i2++];
          if (i2 < s.length) current += s[i2++];
          continue;
        }
        current += s[i2++];
      }
      if (i2 < s.length) current += s[i2++];
    } else if (s[i2] === "'") {
      current += s[i2++];
      while (i2 < s.length && s[i2] !== "'") current += s[i2++];
      if (i2 < s.length) current += s[i2++];
    } else if (s[i2] === "\\" && i2 + 1 < s.length && s[i2 + 1] === "|") {
      let trailingBS = 0;
      for (let k = current.length - 1; k >= 0 && current[k] === "\\"; k--) trailingBS++;
      if (trailingBS % 2 === 1) {
        i2++;
        const trimmed2 = current.trim();
        if (trimmed2) stages.push(trimmed2);
        current = "";
        i2++;
      } else {
        current += s[i2++];
        current += s[i2++];
      }
    } else if (s[i2] === "|" && i2 + 1 < s.length && s[i2 + 1] === "|") {
      return null;
    } else if (s[i2] === "|") {
      const trimmed2 = current.trim();
      if (trimmed2) stages.push(trimmed2);
      current = "";
      i2++;
    } else {
      current += s[i2++];
    }
  }
  const trimmed = current.trim();
  if (trimmed) stages.push(trimmed);
  return stages;
}
function classifyPipe(firstCmd, baseType) {
  const allStages = splitByPipe(firstCmd);
  if (allStages === null) return null;
  if (allStages.length < 2) return baseType;
  const pipeStages = allStages.slice(1);
  const pipeTools = pipeStages.map((s) => s.trim().split(/\s+/)[0]);
  const keepsLines = (stage) => {
    const trimmed = stage.trim();
    return trimmed.split(/\s+/)[0] === "head" || SED_LINE_DROP_RE.test(trimmed);
  };
  if (baseType === "cat") {
    if (pipeTools[0] === "head" && pipeTools.slice(1).every((t) => t === "head")) return "head";
    if ((pipeTools[0] === "grep" || pipeTools[0] === "rg") && /(?:^|\s)-[A-Za-z]*n/.test(pipeStages[0]) && !/(?:^|\s)-[A-Za-z]*[clL]/.test(pipeStages[0]) && pipeStages.slice(1).every(keepsLines)) return "grep-n";
    return null;
  }
  if (baseType === "head") return pipeTools.every((t) => t === "head") ? "head" : null;
  if (baseType === "grep-n") return pipeStages.every(keepsLines) ? "grep-n" : null;
  return baseType;
}
function redactCmd(cmd) {
  return String(cmd).replace(/\b[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)\s*=\s*\S+/gi, (m) => m.split("=")[0] + "=***").replace(/(--?(?:token|api[-_]?key|password|pass|secret)[=\s]+)\S+/gi, "$1***").replace(/\b(Bearer)\s+\S+/gi, "$1 ***").replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@").replace(/\/(home|Users|root)\/[^/\s]+/g, "~").replace(/\b\w+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "***@<ip>");
}
function pipeActorDisplay(cmd) {
  const stripped = stripShellPreamble(cmd).rest;
  const firstLine = stripped.split("\n")[0].split(";")[0];
  const catMatch = firstLine.match(/^cat\s+(?:-[A-Za-z]*\s*)*['"]?([^\s|;><'"]+)/);
  const headMatch = !catMatch && firstLine.match(/^head\s+(?:-[A-Za-z]*\s*\d*\s+)*['"]?([^\s|;><'"]+)/);
  const sourceMatch = catMatch || headMatch;
  if (!sourceMatch) return null;
  const allStages = splitByPipe(firstLine);
  if (allStages === null || allStages.length < 2) return null;
  if (classifyPipe(firstLine, catMatch ? "cat" : "head") !== null) return null;
  const filePath = sourceMatch[1];
  const actorTool = allStages[1].trim().split(/\s+/)[0];
  return {
    name: actorTool.length > DISPLAY_CHARS ? actorTool.slice(0, DISPLAY_CHARS) : actorTool,
    detail: filePath.length > DISPLAY_CHARS ? filePath.slice(-DISPLAY_CHARS) : filePath
  };
}
function bashFeature(command) {
  if (!command || !String(command).trim()) return { name: "(bash)", detail: "" };
  let cmd = String(command).trim();
  cmd = cmd.replace(LEADING_COMMENT_RE, "").trim();
  if (!cmd) return { name: "(bash)", detail: "" };
  const pipeActorResult = pipeActorDisplay(cmd);
  if (pipeActorResult) return pipeActorResult;
  cmd = cmd.split("|")[0].trim();
  cmd = cmd.replace(/^source\s+\S+\s*;\s*/i, "");
  cmd = stripShellPreamble(cmd).rest;
  while (/^(sudo|env|time|nohup)\s+/.test(cmd)) cmd = cmd.replace(/^(sudo|env|time|nohup)\s+/, "");
  for (; ; ) {
    const before = cmd;
    cmd = cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']*)(?:\s+|\s*(?:&&|;)\s*))+/, "");
    cmd = stripShellPreamble(cmd.replace(/^(?:&&|;)\s*/, "")).rest;
    if (cmd === before) break;
  }
  const firstLine = cmd.split("\n")[0];
  const tokens = firstLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length === 0) return { name: "(bash)", detail: "" };
  const tool = tokens[0];
  if (tool.includes("/") || tool.includes("=")) return { name: "(script)", detail: "" };
  let name3;
  let argsStart;
  if (tool === "git") {
    let i2 = 1;
    while (i2 < tokens.length && tokens[i2].startsWith("-")) {
      if (tokens[i2] === "-C" || tokens[i2] === "-c") i2 += 2;
      else break;
    }
    const sub = i2 < tokens.length ? tokens[i2] : "";
    name3 = sub ? `git ${sub}` : "git";
    argsStart = i2 + 1;
  } else if (tool === "bash" || tool === "sh") {
    const script = tokens[1] || "";
    const basename2 = script.includes("/") ? script.split("/").pop() : script;
    name3 = basename2 ? `${tool} ${basename2}` : tool;
    argsStart = 2;
  } else if ((tool === "npm" || tool === "pnpm" || tool === "yarn") && tokens.length > 1) {
    const sub = tokens[1] || "";
    if (sub.startsWith("-")) {
      name3 = tool;
      argsStart = 1;
    } else {
      name3 = `${tool} ${sub}`;
      argsStart = 2;
    }
  } else if (tool === "docker" && tokens.length > 1 && !tokens[1].startsWith("-")) {
    name3 = `${tool} ${tokens[1]}`;
    argsStart = 2;
  } else {
    name3 = tool;
    argsStart = 1;
  }
  if (name3.length > DISPLAY_CHARS) name3 = name3.slice(0, DISPLAY_CHARS);
  let detail = "";
  for (const arg of tokens.slice(argsStart)) {
    if (/^(?:&&|;|>>?|<<?|&)$/.test(arg)) break;
    if (arg.startsWith("-")) continue;
    const urlMatch = arg.match(/^https?:\/\/([^/\s:@]+)/);
    if (urlMatch) {
      detail = urlMatch[1];
      break;
    }
    if (!arg.startsWith("$") && !arg.startsWith('"') && !arg.startsWith("'")) {
      detail = arg;
      break;
    }
  }
  detail = redactCmd(detail);
  if (detail.length > DISPLAY_CHARS) detail = detail.slice(0, DISPLAY_CHARS);
  return { name: name3, detail };
}

// lib/tool-effects.js
function lineFragments(lines) {
  const byLine = /* @__PURE__ */ new Map();
  for (const [line, tokens] of lines) byLine.set(line, tokens);
  return [...byLine].map(([key, tokens]) => ({ key, tokens }));
}
function effectFor(update, resourceKey) {
  const spentTokens = update.spent > 0 ? update.spent : 0;
  if (update.type === "grepMultiFile") {
    return {
      access: "read",
      overheadTokens: update.overhead,
      spentTokens,
      impacts: Object.entries(update.files).map(([key, entries]) => ({
        resourceKey: key,
        mutation: { kind: "merge-fragments", fragments: lineFragments(entries) }
      }))
    };
  }
  if (update.type === "fullSet") {
    return {
      access: "read",
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: "replace-fragments", fragments: lineFragments(update.lines) } }]
    };
  }
  if (update.type === "write") {
    return {
      access: "write",
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: "replace-fragments", fragments: lineFragments(update.lines) } }]
    };
  }
  if (update.type === "lineUpdate") {
    return {
      access: "read",
      overheadTokens: update.overhead,
      spentTokens,
      impacts: [{ resourceKey, mutation: { kind: "merge-fragments", fragments: lineFragments(update.lines) } }]
    };
  }
  return {
    access: "write",
    overheadTokens: 0,
    spentTokens,
    impacts: [{ resourceKey, mutation: { kind: "adjust-total", deltaTokens: update.value } }]
  };
}
function pathEventsFor(update, resourceKey, rawPath, toolType) {
  if (update.type === "grepMultiFile") {
    return Object.keys(update.files).map((key) => ({ path: key, rawPath: key, toolType, isFullRead: 0 }));
  }
  if (resourceKey == null) return [];
  const isFullRead = update.type === "fullSet" ? 1 : update.type === "lineUpdate" ? 0 : null;
  return [{ path: resourceKey, rawPath, toolType, isFullRead }];
}

// lib/harness/dsh/native-tools.js
function canonicalizerFor(context) {
  const ops = context && context.path;
  if (!ops) return (raw) => String(raw);
  return (raw, base) => {
    const abs = ops.isAbsolute(raw) ? raw : ops.resolve(base || "/", raw);
    return ops.normalize(abs).split("\\").join("/");
  };
}
function baseDirFor(row, context) {
  if (typeof row.cwd === "string" && row.cwd.length > 0) return row.cwd;
  if (typeof context.sessionCwd === "string" && context.sessionCwd.length > 0) return context.sessionCwd;
  return null;
}
var READ_LINE_RE = /^(\d+): /;
var END_OF_FILE_RE = /^\(End of file - total \d+ lines\)$/;
var GREP_SECTION_SEPARATOR = "\n\n";
var GREP_ROW_RE = /^Line (\d+): /;
var sumTokens = (lines) => lines.reduce((sum, [, tokens]) => sum + tokens, 0);
var fileTarget = (input, base, canon) => input.file_path ? canon(input.file_path, base) : null;
var EFFECT_ADAPTERS = /* @__PURE__ */ new Map([
  ["read", {
    toolType: "read",
    extractTarget: fileTarget,
    computeUpdate: (_input, text, _base, ctp) => {
      const lines = [];
      let reachedEnd = false;
      for (const line of text.split("\n")) {
        const numbered = READ_LINE_RE.exec(line);
        if (numbered) lines.push([Number(numbered[1]), charsToTokens(line, ctp)]);
        else if (END_OF_FILE_RE.test(line)) reachedEnd = true;
      }
      const isFullRead = reachedEnd && lines.length > 0 && lines[0][0] === 1;
      const spent = sumTokens(lines) + TOOL_OVERHEAD.Read;
      return { type: isFullRead ? "fullSet" : "lineUpdate", lines, overhead: TOOL_OVERHEAD.Read, spent };
    }
  }],
  ["write", {
    toolType: "write",
    extractTarget: fileTarget,
    // Written content is raw and a later read numbers it, so the write prices the read's form and the two
    // observations of one file agree. `buildWindow` counts a final unterminated line but no line after a
    // final newline, so neither does this.
    computeUpdate: (input, _text, _base, ctp) => {
      const rawLines = String(input.content ?? "").split("\n");
      if (rawLines.at(-1) === "") rawLines.pop();
      const lines = rawLines.map((line, index) => [index + 1, charsToTokens(`${index + 1}: ${line}`, ctp)]);
      return { type: "write", lines, overhead: TOOL_OVERHEAD.Write, spent: sumTokens(lines) + TOOL_OVERHEAD.Write };
    }
  }],
  ["edit", {
    toolType: "edit",
    extractTarget: fileTarget,
    // An edit adjusts the total rather than replacing content: it observes no whole file. It charges no
    // framing overhead because the corrective read that follows most edits charges its own. Each line it
    // adds or removes carries a line-number prefix in the read's form.
    computeUpdate: (input, _text, _base, ctp) => {
      const oldString = input.old_string ?? "";
      const newString = input.new_string ?? "";
      const oldTokens = charsToTokens(oldString, ctp);
      const newTokens = charsToTokens(newString, ctp);
      const lineDelta = (newString.match(/\n/g) || []).length - (oldString.match(/\n/g) || []).length;
      const value = newTokens - oldTokens + lineDelta * (4 / ctp.ascii);
      return { type: "editDelta", value, spent: oldTokens + newTokens + TOOL_OVERHEAD.Edit };
    }
  }],
  ["grep", {
    toolType: "grep",
    extractTarget: () => null,
    // the files are named by the result, not by the input
    computeUpdate: (_input, text, base, ctp, canon) => {
      const files = /* @__PURE__ */ Object.create(null);
      for (const section of text.split(GREP_SECTION_SEPARATOR)) {
        const [path3, ...rows] = section.split("\n");
        if (GREP_ROW_RE.test(path3)) continue;
        const lines = [];
        for (const row of rows) {
          const numbered = GREP_ROW_RE.exec(row);
          if (!numbered) continue;
          const rendered = `${numbered[1]}: ${row.slice(numbered[0].length)}`;
          lines.push([Number(numbered[1]), charsToTokens(rendered, ctp)]);
        }
        if (lines.length === 0) continue;
        files[canon(path3, base)] = lines;
      }
      const spent = Object.values(files).reduce((sum, lines) => sum + sumTokens(lines), TOOL_OVERHEAD.Grep);
      return { type: "grepMultiFile", files, overhead: TOOL_OVERHEAD.Grep, spent };
    }
  }],
  ["skill", {
    toolType: "skill",
    // A skill is a resource without a file: its key is its own namespace, so no base path applies.
    extractTarget: (input) => input.name ? "skill:" + input.name : null,
    computeUpdate: (_input, text, _base, ctp) => {
      const tokens = charsToTokens(text, ctp);
      return { type: "fullSet", lines: [[1, tokens]], overhead: TOOL_OVERHEAD.Read, spent: tokens + TOOL_OVERHEAD.Read };
    }
  }]
]);
function isEffectiveUpdate(update, target) {
  if (update.type === "grepMultiFile") return Object.keys(update.files).length > 0;
  if (update.type === "fullSet" || update.type === "lineUpdate") return target != null && update.lines.length > 0;
  return target != null;
}
var MCP_PREFIX = "mcp__";
var AGENT_TOOLS = /* @__PURE__ */ new Set(["subagent", "subagent_fork", "workflow", "send_message"]);
function residualIdentityFor(name3, input) {
  const inputLength = JSON.stringify(input).length;
  if (name3 === "bash") {
    const feature = bashFeature(input.command);
    return { groupKey: feature.name, kind: "bash", detail: feature.detail, inputLength };
  }
  if (name3.startsWith(MCP_PREFIX)) {
    return { groupKey: name3.slice(MCP_PREFIX.length), kind: "mcp", detail: "", inputLength };
  }
  return { groupKey: name3, kind: AGENT_TOOLS.has(name3) ? "agent" : "tool", detail: "", inputLength };
}
function isLoadHandoffTool(name3) {
  return name3.endsWith("load_handoff");
}
function resolvedLoadToken(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.load_token === "string" ? parsed.load_token : null;
  } catch {
    return null;
  }
}
function interpretDshToolUse(observation, context) {
  const { toolUseId, name: name3 } = observation;
  const issuingStepId = observation.messageId ?? null;
  const issuingPolicy = context.resolveModelPolicy(observation.model ?? null);
  const input = observation.input ?? {};
  const explicitToken = isLoadHandoffTool(name3) && typeof input.load_token === "string" ? input.load_token : null;
  const awaitLoadToken = isLoadHandoffTool(name3) && explicitToken === null;
  const telemetry = { toolUseId, issuingStepId, loadToken: explicitToken, pathEvents: [] };
  const call = { toolUseId, issuingStepId, issuingPolicy, awaitLoadToken };
  const adapter = EFFECT_ADAPTERS.get(name3);
  let pending = null;
  if (adapter === void 0) {
    pending = { kind: "residual", ...call, residual: residualIdentityFor(name3, input) };
  } else {
    const base = baseDirFor(observation, context);
    try {
      const target = adapter.extractTarget(input, base, canonicalizerFor(context));
      pending = { kind: "effect", ...call, adapter, input, base, target, rawPath: input.file_path || target };
    } catch {
    }
  }
  return { pending, effects: [], residuals: [], telemetry };
}
function completeDshToolResult(pending, observation, context) {
  const text = observation.content;
  const telemetry = {
    toolUseId: pending.toolUseId,
    issuingStepId: pending.issuingStepId,
    loadToken: pending.awaitLoadToken ? resolvedLoadToken(text) : null,
    pathEvents: []
  };
  const hadError = observation.isError === true;
  if (pending.kind === "residual") {
    const { groupKey, kind, detail, inputLength } = pending.residual;
    return {
      effects: [],
      residuals: [{ groupKey, weight: inputLength + text.length, hadError, meta: { kind, detail } }],
      telemetry,
      skillContinuation: null
    };
  }
  const nothing2 = { effects: [], residuals: [], telemetry, skillContinuation: null };
  if (hadError) return nothing2;
  const { adapter, input, base, target, rawPath, issuingPolicy } = pending;
  let update;
  try {
    update = adapter.computeUpdate(input, text, base, issuingPolicy.ctp, canonicalizerFor(context));
  } catch {
    return nothing2;
  }
  if (!isEffectiveUpdate(update, target)) return nothing2;
  telemetry.pathEvents = pathEventsFor(update, target, rawPath, adapter.toolType);
  return { effects: [effectFor(update, target)], residuals: [], telemetry, skillContinuation: null };
}
function resolveDshToolTarget(pair, context) {
  const adapter = EFFECT_ADAPTERS.get(pair.name);
  if (adapter === void 0) return null;
  try {
    return adapter.extractTarget(pair.input ?? {}, baseDirFor(pair, context), canonicalizerFor(context));
  } catch {
    return null;
  }
}
function classifyDshToolPair(pair, ctp) {
  const adapter = EFFECT_ADAPTERS.get(pair.name);
  if (adapter === void 0 || pair.result == null || pair.isError === true) return "residual";
  let update;
  try {
    update = adapter.computeUpdate(pair.input ?? {}, pair.result, null, ctp, canonicalizerFor(null));
  } catch {
    return "residual";
  }
  if (!isEffectiveUpdate(update, pair.resourceKey)) return "residual";
  return pair.name === "skill" ? "skill" : "path";
}

// lib/harness/dsh/history-turn-rules.js
function createDshHumanHeadRule() {
  return (line) => {
    if (line.kind !== "visible" || line.message.role !== "human") return PASS;
    const text = line.message.text.trim();
    return text === "" ? ABSORB : { kind: "HEAD", text };
  };
}
var ASK_TOOL_NAME = "ask_user_question";
function answerText(result) {
  let value;
  try {
    value = JSON.parse(result);
  } catch {
    return "";
  }
  const lines = [];
  for (const answer of Array.isArray(value?.answers) ? value.answers : []) {
    if (Array.isArray(answer?.selected)) lines.push(...answer.selected);
    if (answer?.custom) lines.push(answer.custom);
  }
  return lines.join("\n");
}
function createDshAskHeadRule() {
  return (line) => {
    if (line.kind !== "tool" || line.tool.name !== ASK_TOOL_NAME) return PASS;
    if (line.tool.isError === true) return ABSORB;
    const text = answerText(line.tool.result).trim();
    return text === "" ? ABSORB : { kind: "HEAD", text };
  };
}
function createDshDialogueProjection({ sessionCwd }) {
  const context = { path: { isAbsolute: isAbsolute3, resolve: resolve2, normalize: normalize2 }, sessionCwd };
  const rules = [
    createDshHumanHeadRule(),
    createDshAskHeadRule()
  ];
  return {
    project(observations) {
      const { folds } = projectDialogue(observations);
      for (const fold of folds) {
        for (const pair of fold.toolPairs) {
          pair.resourceKey = resolveDshToolTarget(pair, context);
        }
      }
      return { folds };
    },
    groupTurns(lines) {
      return groupTurns(lines, rules);
    }
  };
}

// lib/harness/dsh/measurement-projection.js
import nodePath from "node:path";

// lib/measurement-projection.js
function emptyFacts() {
  return { toolUseIds: /* @__PURE__ */ new Set(), loadToken: null, pathEvents: [] };
}
function stepRowFor(step, facts) {
  return {
    foldedSeq: step.foldedSeq,
    ts: step.timestamp,
    input: step.usage.input,
    output: step.usage.output,
    cacheRead: step.usage.cacheRead,
    cacheCreation: step.usage.cacheWrite,
    toolCalls: facts ? facts.toolUseIds.size : 0,
    loadToken: facts ? facts.loadToken : null
  };
}
function joinFacts(factsByStepId, closedSegment) {
  const steps = [];
  const events = [];
  for (const step of closedSegment.steps) {
    const facts = factsByStepId.get(step.id) ?? null;
    steps.push(stepRowFor(step, facts));
    if (!facts) continue;
    let eventOrdinal = 0;
    for (const event of facts.pathEvents) {
      events.push({
        foldedSeq: step.foldedSeq,
        eventOrdinal: eventOrdinal++,
        path: event.path,
        rawPath: event.rawPath,
        toolType: event.toolType,
        isFullRead: event.isFullRead
      });
    }
  }
  return { steps, events };
}
function createMeasurementProjection({
  scope,
  context,
  captureSources,
  interpretToolUse,
  completeToolResult,
  interpretSkillPayload
}) {
  const invariantPrefix = `${scope.replaceAll("-", " ")} invariant`;
  function invariant7(ok, message) {
    if (!ok) throw new Error(`${invariantPrefix}: ${message}`);
  }
  function diagnostic3(code, message) {
    return { scope, code, message };
  }
  let callByToolUseId = /* @__PURE__ */ new Map();
  let sidecarByStepId = /* @__PURE__ */ new Map();
  function factsFor(stepId) {
    let facts = sidecarByStepId.get(stepId);
    if (!facts) {
      facts = emptyFacts();
      sidecarByStepId.set(stepId, facts);
    }
    return facts;
  }
  function mergeTelemetry(telemetry, diagnostics) {
    if (!telemetry) return;
    const stepId = telemetry.issuingStepId;
    if (typeof stepId !== "string" || stepId.length === 0) return;
    const facts = factsFor(stepId);
    if (telemetry.toolUseId != null) facts.toolUseIds.add(telemetry.toolUseId);
    if (typeof telemetry.loadToken === "string" && telemetry.loadToken.length > 0) {
      if (facts.loadToken === null) facts.loadToken = telemetry.loadToken;
      else if (facts.loadToken !== telemetry.loadToken) {
        diagnostics.push(diagnostic3(
          "multiple_load_tokens",
          `step ${stepId} keeps its first load token`
        ));
      }
    }
    for (const event of telemetry.pathEvents ?? []) facts.pathEvents.push(event);
  }
  function pushRecords(interpreted, records) {
    for (const effect of interpreted.effects) records.push({ type: "effect", ...effect });
    for (const residual of interpreted.residuals) records.push({ type: "residual", ...residual });
  }
  function projectToolUse(observation, records, diagnostics) {
    const id = observation.toolUseId;
    const entry = callByToolUseId.get(id);
    if (entry && (entry.phase === "await-skill-payload" || entry.phase === "completed")) return;
    const interpreted = interpretToolUse(observation, context);
    mergeTelemetry(interpreted.telemetry, diagnostics);
    callByToolUseId.set(id, interpreted.pending ? { phase: "await-result", pending: interpreted.pending } : { phase: "issued" });
    pushRecords(interpreted, records);
    if (entry && entry.phase === "held") projectToolResult(entry.result, records, diagnostics);
  }
  function projectToolResult(observation, records, diagnostics) {
    const id = observation.toolUseId;
    const entry = callByToolUseId.get(id);
    if (!entry) {
      callByToolUseId.set(id, { phase: "held", result: observation });
      return;
    }
    if (entry.phase === "issued") {
      callByToolUseId.set(id, { phase: "completed" });
      return;
    }
    if (entry.phase !== "await-result") return;
    const completed = completeToolResult(entry.pending, observation, context);
    mergeTelemetry(completed.telemetry, diagnostics);
    callByToolUseId.set(id, completed.skillContinuation ? {
      phase: "await-skill-payload",
      resourceKey: completed.skillContinuation.resourceKey,
      issuingPolicy: completed.skillContinuation.issuingPolicy
    } : { phase: "completed" });
    pushRecords(completed, records);
  }
  function projectSkillPayload(observation, records, diagnostics) {
    const entry = callByToolUseId.get(observation.toolUseId);
    if (!entry || entry.phase !== "await-skill-payload") return;
    callByToolUseId.set(observation.toolUseId, { phase: "completed" });
    const interpreted = interpretSkillPayload(
      { resourceKey: entry.resourceKey, issuingPolicy: entry.issuingPolicy },
      observation
    );
    mergeTelemetry(interpreted.telemetry, diagnostics);
    pushRecords(interpreted, records);
  }
  function project(observation) {
    invariant7(observation !== null && typeof observation === "object", "observation must be an object");
    const records = [];
    const diagnostics = [];
    switch (observation.type) {
      case "epoch-boundary":
        callByToolUseId = /* @__PURE__ */ new Map();
        records.push({ type: "epoch" });
        break;
      case "turn-boundary":
        records.push({ type: "turn-boundary" });
        break;
      case "usage":
        records.push({
          type: "step",
          id: observation.messageId,
          model: observation.model ?? null,
          timestamp: observation.timestamp ?? null,
          usage: {
            input: observation.usage.input,
            output: observation.usage.output,
            cacheRead: observation.usage.cacheRead,
            cacheWrite: observation.usage.cacheWrite
          }
        });
        break;
      case "tool-use":
        projectToolUse(observation, records, diagnostics);
        break;
      case "tool-result":
        projectToolResult(observation, records, diagnostics);
        break;
      case "skill-payload":
        projectSkillPayload(observation, records, diagnostics);
        break;
      case "text":
        break;
      default:
        invariant7(false, `unsupported observation type: ${String(observation.type)}`);
    }
    return { records, diagnostics };
  }
  function finishSegment(closedSegment, { captureMode = "live" } = {}) {
    const closing = sidecarByStepId;
    sidecarByStepId = /* @__PURE__ */ new Map();
    callByToolUseId = /* @__PURE__ */ new Map();
    const diagnostics = [];
    if (closedSegment == null) return { artifact: null, diagnostics };
    let payload;
    try {
      payload = joinFacts(closing, closedSegment);
    } catch (error) {
      diagnostics.push(diagnostic3("segment_telemetry_join_failed", `telemetry join failed: ${error.message}`));
      return { artifact: null, diagnostics };
    }
    return {
      artifact: {
        captureSource: captureMode === "replay" ? captureSources.replay : captureSources.live,
        payload
      },
      diagnostics
    };
  }
  return { project, finishSegment };
}

// lib/harness/dsh/measurement-projection.js
function invariant4(ok, message) {
  if (!ok) throw new Error(`dsh measurement projection invariant: ${message}`);
}
function noSkillPayload() {
  invariant4(false, "no skill payload phase in DSH");
}
function createDshMeasurementProjection({
  cwd = null,
  projectRoot = null,
  resolveModelPolicy,
  interpretToolUse,
  completeToolResult
} = {}) {
  invariant4(typeof interpretToolUse === "function", "interpretToolUse must be a function");
  invariant4(typeof completeToolResult === "function", "completeToolResult must be a function");
  const context = { path: nodePath, sessionCwd: cwd || projectRoot || null, resolveModelPolicy };
  return createMeasurementProjection({
    scope: "dsh-measurement-projection",
    context,
    captureSources: { live: "dsh-live", replay: "dsh-replay" },
    interpretToolUse,
    completeToolResult,
    interpretSkillPayload: noSkillPayload
  });
}

// dsh/src/composition.js
var DSH_TURN_NOTES_ROOT = join6(tmpdir(), "session-watcher", "turn-notes");
function composeWatcher({ sessionId, cwd, store, turnNotesRoot, readSession, isIgnored, cacheTtl }) {
  const dialogueSource = createDshDialogueSource({ readSession });
  const dialogueProjection = createDshDialogueProjection({ sessionCwd: cwd });
  const watcher = new SessionWatcher({
    sessionId,
    sourceLocator: sessionId,
    projectId: resolveProjectKey({ cwd }),
    projectRoot: cwd,
    turnNotesRoot,
    resourcePolicy: createResourcePolicy({ projectRoot: cwd, isIgnored }),
    resourceEnrichment: createResourceEnrichment(),
    handoffComposition: createHandoffComposition(),
    loaderVersion: PLUGIN_VERSION,
    store,
    dialogueSource,
    dialogueProjection,
    createEngine: createMeasurementEngine,
    createMeasurementProjection: (_locator, resolveModelPolicy) => createDshMeasurementProjection({
      cwd,
      projectRoot: cwd,
      resolveModelPolicy,
      interpretToolUse: interpretDshToolUse,
      completeToolResult: completeDshToolResult
    }),
    modelPolicyFor: (modelId) => {
      const policy = modelPolicyFor(modelId, cacheTtl() ?? DEFAULT_CACHE_TTL);
      const saved = loadPricingOverride(modelId);
      if (saved) policy.cRatio = saved.ratio;
      return policy;
    }
  });
  return { watcher, dialogueSource, dialogueProjection };
}

// lib/harness/dsh/source-driver.js
function invariant5(ok, message) {
  if (!ok) throw new Error(`dsh source driver invariant: ${message}`);
}
function createDshSourceDriver({ sessionId, onDiagnostics } = {}) {
  invariant5(typeof onDiagnostics === "function", "onDiagnostics must be a function");
  const queue = [];
  let installed = false;
  let drained = false;
  let snapshotTail;
  function report(diagnostics) {
    if (diagnostics.length > 0) onDiagnostics(diagnostics);
  }
  function liveFrame(event) {
    const { observations, diagnostics } = reduceDshEvent(event);
    report(diagnostics);
    if (observations.length === 0) return null;
    return { transition: "append", batches: [observations], sourceObserved: true, captureMode: "live" };
  }
  function install(snapshotEvents) {
    invariant5(!installed, "install runs once");
    const { batches, diagnostics } = reduceDshSnapshot(snapshotEvents);
    installed = true;
    snapshotTail = snapshotEvents.length === 0 ? -1 : snapshotEvents.at(-1).seq;
    report(diagnostics);
    return {
      transition: "replace",
      sourceLocator: sessionId,
      batches,
      sourceObserved: true,
      captureMode: "replay"
    };
  }
  function feed(event) {
    if (drained) return liveFrame(event);
    queue.push(event);
    return null;
  }
  function drain() {
    invariant5(installed, "drain follows install");
    drained = true;
    const frames = [];
    for (const event of queue.splice(0)) {
      if (event.seq <= snapshotTail) continue;
      const frame = liveFrame(event);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }
  return { install, feed, drain };
}

// lib/ledger-schema.js
var SCHEMA_VERSION = 3;
var intFields = [
  "billCycleCount",
  "walletLapCount",
  "lastAppliedFoldedCallSeq",
  "currentTurnSeq",
  "cacheExpiryCount",
  "ledgerRevision"
];
var PAUSE_REASONS = /* @__PURE__ */ new Set([
  null,
  "folded_seq_gap",
  "metrics_unreliable",
  "invalid_baseline",
  "insufficient_data",
  "cache_unstable",
  "seq_history_mismatch",
  "invalid_sample"
]);
function validateLedgerState(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof obj.stateKey !== "string") return null;
  if (obj.billingBasis !== "fullCarry") return null;
  if (obj.ledgerRevision === void 0) obj.ledgerRevision = 0;
  if (obj.recentStopEvents === void 0) obj.recentStopEvents = [];
  if (obj.recentProcessedHookEventIds === void 0) obj.recentProcessedHookEventIds = [];
  if (!(typeof obj.billProgress === "number" && obj.billProgress >= 0 && obj.billProgress < 1)) return null;
  if (!(typeof obj.walletPhase === "number" && obj.walletPhase >= 0 && obj.walletPhase < 1)) return null;
  for (const f of intFields) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  if (!PAUSE_REASONS.has(obj.pausedReason)) return null;
  if (obj.lastStopEvent != null && typeof obj.lastStopEvent !== "object") return null;
  if (!Array.isArray(obj.recentStopEvents) || obj.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) return null;
  for (const e of obj.recentStopEvents) {
    if (!e || typeof e !== "object") return null;
    if (typeof e.kind !== "string") return null;
  }
  if (!Array.isArray(obj.recentProcessedHookEventIds) || obj.recentProcessedHookEventIds.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) return null;
  for (const id of obj.recentProcessedHookEventIds) if (typeof id !== "string") return null;
  return obj;
}
function validateRateLampSample(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.reliable !== "boolean") return false;
  if (!Number.isInteger(obj.seq) || obj.seq < 0) return false;
  if (!Number.isInteger(obj.turnSeq) || obj.turnSeq < 0) return false;
  if (obj.reliable) {
    if (!(Number.isFinite(obj.L_read) && obj.L_read >= 0)) return false;
    if (obj.deltaW !== null && !(Number.isFinite(obj.deltaW) && obj.deltaW >= 0)) return false;
    if (obj.mf !== null && !Number.isFinite(obj.mf)) return false;
  }
  return true;
}

// lib/rate-lamp-store.js
function stateKeyOf({ segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion }) {
  return JSON.stringify([segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion]);
}
function stateKeyForStatus(status) {
  return stateKeyOf({
    segmentId: status.segment,
    model: null,
    cRatio: null,
    baselineFingerprint: null,
    contextCap: null,
    schemaVersion: 1
  });
}
function freshLedger(stateKey) {
  return {
    schemaVersion: SCHEMA_VERSION,
    stateKey,
    billingBasis: "fullCarry",
    billProgress: 0,
    billCycleCount: 0,
    walletPhase: 0,
    walletLapCount: 0,
    lastAppliedFoldedCallSeq: 0,
    currentTurnSeq: 0,
    pausedReason: null,
    cacheExpiryCount: 0,
    lastStopEvent: null,
    // condition-cleared: visible until the next human turn boundary
    ledgerRevision: 0,
    recentStopEvents: [],
    recentProcessedHookEventIds: []
  };
}
function invalidPausedLedger(prev) {
  const stateKey = prev && typeof prev === "object" && typeof prev.stateKey === "string" ? prev.stateKey : "__invalid__";
  const s = freshLedger(stateKey);
  s.pausedReason = "invalid_sample";
  return s;
}
function pushStopEventRing(ledgerOrDraft, evt) {
  if (!ledgerOrDraft.recentStopEvents) ledgerOrDraft.recentStopEvents = [];
  ledgerOrDraft.recentStopEvents.push(evt);
  if (ledgerOrDraft.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) {
    ledgerOrDraft.recentStopEvents.splice(0, ledgerOrDraft.recentStopEvents.length - RECENT_STOP_EVENTS_LIMIT);
  }
}
function applyFoldedCallSample(prev, sample) {
  if (!validateLedgerState(prev)) return invalidPausedLedger(prev);
  const s = { ...prev };
  if (!validateRateLampSample(sample)) {
    s.pausedReason = "invalid_sample";
    return s;
  }
  if (sample.seq <= s.lastAppliedFoldedCallSeq) return s;
  if (s.lastAppliedFoldedCallSeq !== 0 && sample.seq !== s.lastAppliedFoldedCallSeq + 1) {
    s.pausedReason = "folded_seq_gap";
    s.lastAppliedFoldedCallSeq = sample.seq;
    return s;
  }
  s.lastAppliedFoldedCallSeq = sample.seq;
  if (!sample.reliable) {
    s.pausedReason = sample.unavailableReason || "insufficient_data";
    return s;
  }
  if (sample.deltaW === null) return s;
  s.pausedReason = null;
  let bill = s.billProgress + sample.deltaW;
  while (bill >= 1) {
    bill -= 1;
    s.billCycleCount += 1;
  }
  s.billProgress = bill;
  const interval = walletIntervalFor(sample.mf, BR_AMBER);
  let phase = s.walletPhase + sample.deltaW / interval;
  while (phase >= 1) {
    phase -= 1;
    s.walletLapCount += 1;
  }
  s.walletPhase = phase;
  return s;
}
function drainFrame(ledger, frame) {
  const preExisting = ledger.lastStopEvent;
  for (const sample of frame.samples) {
    if (!(sample.seq > ledger.lastAppliedFoldedCallSeq)) continue;
    if (sample.turnSeq > ledger.currentTurnSeq && ledger.lastStopEvent && ledger.lastStopEvent === preExisting) {
      ledger.lastStopEvent = null;
    }
    const lapsBefore = ledger.walletLapCount;
    Object.assign(ledger, applyFoldedCallSample(ledger, sample));
    if (ledger.walletLapCount > lapsBefore) {
      const event = {
        kind: "backstop",
        delivery: "reader_path",
        message: `Carry rent reminder ${ledger.walletLapCount}: accumulated rent reached the reminder point. Consider restart/compact at the next natural boundary.`,
        billCount: ledger.walletLapCount,
        seq: sample.seq
      };
      ledger.lastStopEvent = event;
      pushStopEventRing(ledger, event);
    }
  }
  ledger.currentTurnSeq = frame.turnSeq;
}
function loadRateLampState(sessionId) {
  try {
    return validateLedgerState(getStore().load(sessionId, "ledger"));
  } catch {
    return null;
  }
}
function saveRateLampState(sessionId, state) {
  getStore().save(sessionId, "ledger", state);
}

// lib/rate-lamp-manager.js
var RENT_METER_DEFAULT = () => ({
  cycleProgress: 0,
  depthActive: false,
  depthProgress: 0,
  backstopInterval: null,
  backstopLapCount: 0,
  depthHot: false
});
var _ledgers = /* @__PURE__ */ new Map();
var _lastSaved = /* @__PURE__ */ new Map();
var _lastPersistedRevision = /* @__PURE__ */ new Map();
var _lastSeenRevision = /* @__PURE__ */ new Map();
var _pendingPersistSids = /* @__PURE__ */ new Set();
var _enospcPaused = /* @__PURE__ */ new Set();
var _counters = {
  diskWrites: 0,
  coalesceHits: 0,
  // schedulePersist calls that joined an existing pending
  coalesceMisses: 0,
  // schedulePersist calls that added a new pending
  revisionGateBlocks: 0,
  // writes refused by the revision gate
  enospcEngagements: 0,
  enospcRecoveries: 0
};
var _testWriter = null;
var _testScheduler = null;
var _coalescedTimer = null;
function _startCoalescedTimer() {
  if (_coalescedTimer) return;
  const schedulerFn = _testScheduler || setInterval;
  _coalescedTimer = schedulerFn(_flushCoalescedPersist, COALESCED_PERSIST_MS);
  if (_coalescedTimer && typeof _coalescedTimer.unref === "function") _coalescedTimer.unref();
}
function _flushCoalescedPersist() {
  for (const sid of _pendingPersistSids) {
    if (_enospcPaused.has(sid)) continue;
    try {
      const ledger = _ledgers.get(sid);
      if (!ledger) {
        _pendingPersistSids.delete(sid);
        continue;
      }
      persistLedger(sid, ledger);
    } catch (e) {
      _enospcPaused.add(sid);
      _counters.enospcEngagements++;
      if (process.env.SW_DEBUG) console.error(`[rate-lamp] ENOSPC pause engaged for ${sid}:`, e.message);
    }
  }
  _pendingPersistSids.clear();
  for (const sid of _enospcPaused) {
    try {
      const ledger = _ledgers.get(sid);
      if (!ledger) {
        _enospcPaused.delete(sid);
        continue;
      }
      persistLedger(sid, ledger, { force: true });
      clearEnospcPause(sid);
    } catch {
    }
  }
}
function schedulePersist(sessionId) {
  if (_enospcPaused.has(sessionId)) return;
  if (_pendingPersistSids.has(sessionId)) {
    _counters.coalesceHits++;
  } else {
    _counters.coalesceMisses++;
    _pendingPersistSids.add(sessionId);
  }
  _startCoalescedTimer();
}
function clearEnospcPause(sessionId) {
  _enospcPaused.delete(sessionId);
  _counters.enospcRecoveries++;
}
function persistLedger(sessionId, ledger, { force = false } = {}) {
  const ledgerRev = ledger.ledgerRevision ?? 0;
  const lastPersistedRev = _lastPersistedRevision.get(sessionId) ?? 0;
  if (!force && ledgerRev < lastPersistedRev) {
    _counters.revisionGateBlocks++;
    if (process.env.SW_DEBUG) console.error(`[rate-lamp] revision gate: refusing rev ${ledgerRev} <= last-persisted ${lastPersistedRev} for ${sessionId}`);
    return;
  }
  if (ledgerRev === lastPersistedRev && !force) {
    const savedContent = _lastSaved.get(sessionId);
    if (savedContent !== void 0) {
      if (JSON.stringify(ledger) !== savedContent) {
        _counters.revisionGateBlocks++;
        console.error(`[rate-lamp] DEAD-LETTER: escaped mutation for ${sessionId} \u2014 content differs at same revision ${ledgerRev}. mutateLedger was bypassed (invariant breach).`);
      }
      return;
    }
  }
  const serialized = JSON.stringify(ledger);
  if (!force && _lastSaved.get(sessionId) === serialized) return;
  if (_testWriter) {
    _testWriter(sessionId, ledger);
  } else {
    saveRateLampState(sessionId, ledger);
  }
  _lastSaved.set(sessionId, serialized);
  _lastPersistedRevision.set(sessionId, ledgerRev);
  _counters.diskWrites++;
}
function reanchorLedger(persisted, { currentKey, frameTailSeq, frameTurnSeq }) {
  const matches = persisted && persisted.stateKey === currentKey;
  const base = matches ? { ...persisted } : freshLedger(currentKey);
  return {
    ...base,
    stateKey: currentKey,
    // PRESERVED on a match: billProgress, billCycleCount, walletPhase, walletLapCount.
    // The folded cursor moves to the frame TAIL, which is what skips this frame's samples.
    lastAppliedFoldedCallSeq: frameTailSeq,
    pausedReason: null,
    // A pulse is an in-process single-turn signal. Carrying `lastStopEvent` across a discontinuity would
    // re-render an alert for context this stream no longer contains.
    lastStopEvent: null,
    currentTurnSeq: frameTurnSeq
  };
}
function mergeLedgerIntoStatus(status, ledger, currentKey) {
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();
  if (!status.rateLamp?.reliable || !ledger || ledger.stateKey !== currentKey) {
    status.rateLamp.dhat = status.rateLamp.dhat ?? null;
    return status;
  }
  const rl = status.rateLamp;
  rl.billProgress = ledger.billProgress;
  rl.billingCycle = { progress: ledger.billProgress };
  rl.billCycleCount = ledger.billCycleCount ?? 0;
  rl.currentTurnSeq = ledger.currentTurnSeq;
  if (ledger.lastStopEvent) rl.lastStopEvent = ledger.lastStopEvent;
  const interval = walletIntervalFor(rl.mfLocal, BR_AMBER);
  rl.rentMeter = {
    cycleProgress: ledger.billProgress,
    depthActive: true,
    depthProgress: ledger.walletPhase,
    backstopInterval: Number.isFinite(interval) ? interval : null,
    backstopLapCount: ledger.walletLapCount,
    depthHot: ledger.walletLapCount >= DEPTH_HOT_LAP_COUNT
  };
  enrichStatusLandmarks(status);
  return status;
}
function enrichStatusLandmarks(status) {
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();
  const rl = status.rateLamp;
  if (!(rl.B_default > 0 && rl.C_RATIO > 0)) return status;
  rl.wallP = wallPositionFor(rl.C_RATIO);
  return status;
}
function mutateLedger(ledger, reason, fn) {
  const before = JSON.stringify(ledger);
  const draft = structuredClone(ledger);
  fn(draft);
  const after = JSON.stringify(draft);
  if (after === before) return ledger;
  draft.ledgerRevision = (ledger.ledgerRevision ?? 0) + 1;
  return draft;
}
function hydrateLedger(sessionId) {
  const live2 = _ledgers.get(sessionId);
  if (live2) return live2;
  const disk = loadRateLampState(sessionId);
  if (!disk) return null;
  const cleaned = { ...disk, lastStopEvent: null };
  _lastPersistedRevision.set(sessionId, cleaned.ledgerRevision ?? 0);
  _ledgers.set(sessionId, cleaned);
  return cleaned;
}
function advanceRateLampToCurrent(watcher, sessionId, { forcePoll = false } = {}) {
  void forcePoll;
  let ledger = hydrateLedger(sessionId);
  const frame = watcher.readRateLampFrame(ledger ? ledger.lastAppliedFoldedCallSeq : 0);
  const reliable = frame.status?.reliable === true;
  if (!reliable) {
    if (!ledger) return { ledger: null, status: frame.status, bill: null };
    ledger = mutateLedger(ledger, "unreliable-frame", (l) => {
      l.pausedReason = frame.status?.unavailableReason || "insufficient_data";
      l.lastAppliedFoldedCallSeq = frame.foldedCallSeq;
      l.currentTurnSeq = frame.turnSeq;
    });
    _ledgers.set(sessionId, ledger);
    schedulePersist(sessionId);
    return { ledger, status: frame.status, bill: null };
  }
  const currentKey = stateKeyForStatus({ segment: frame.progress.segment });
  const seenRevision = _lastSeenRevision.get(sessionId);
  const revisionChanged = seenRevision !== frame.streamRevision;
  const sequenceGap = ledger != null && frame.foldedCallSeq < ledger.lastAppliedFoldedCallSeq;
  if (sequenceGap && process.env.SW_DEBUG) {
    console.error("[rate-lamp] seq mismatch \u2192 re-anchored, cycleCount preserved");
  }
  let drained = frame;
  if (revisionChanged || sequenceGap || !ledger || ledger.stateKey !== currentKey) {
    ledger = reanchorLedger(ledger, { currentKey, frameTailSeq: frame.foldedCallSeq, frameTurnSeq: frame.turnSeq });
    drained = { ...frame, samples: [] };
    _lastSeenRevision.set(sessionId, frame.streamRevision);
  }
  ledger = mutateLedger(ledger, "advance-events", (l) => drainFrame(l, drained));
  _ledgers.set(sessionId, ledger);
  schedulePersist(sessionId);
  return { ledger, status: frame.status, bill: null };
}
function getLiveLedger(sessionId) {
  return _ledgers.get(sessionId) ?? null;
}
function releaseSession(sessionId) {
  const ledger = _ledgers.get(sessionId);
  if (ledger) {
    try {
      persistLedger(sessionId, ledger, { force: true });
    } catch {
    }
  }
  _ledgers.delete(sessionId);
  _lastSaved.delete(sessionId);
  _lastPersistedRevision.delete(sessionId);
  _lastSeenRevision.delete(sessionId);
  _pendingPersistSids.delete(sessionId);
  _enospcPaused.delete(sessionId);
}

// dsh/src/watcher-table.js
var HOST_SCOPE = "dsh-host";
function writeDiagnostic(sessionId, { scope, code, message }) {
  const line = `[${scope}] ${code}: ${message}`;
  console.error(sessionId == null ? line : `${sessionId} ${line}`);
}
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var hostDiagnostic = (code, error) => ({ scope: HOST_SCOPE, code, message: messageOf(error) });
function handlerFailed(error) {
  return hostDiagnostic("handler_failed", error);
}
var missingEntry = (sessionId) => new Error(`session ${sessionId} has no watcher`);
var aborted = (sessionId, signal) => new Error(
  `session ${sessionId}: the wait for its watcher was aborted`,
  { cause: signal.reason }
);
var PASS_THROUGH_NAMES = {
  warm: () => Promise.resolve([]),
  pairsOf: () => [],
  mapEvent: (event) => event
};
function createWatcherTable({ compose, readSession, cacheTtlFor = () => null, modelNames = PASS_THROUGH_NAMES }) {
  const entries = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  let closed = false;
  function notify(sessionId) {
    for (const listener of listeners) {
      try {
        listener(sessionId);
      } catch (error) {
        writeDiagnostic(sessionId, handlerFailed(error));
      }
    }
  }
  function writeAll(sessionId, diagnostics) {
    for (const diagnostic3 of diagnostics) writeDiagnostic(sessionId, diagnostic3);
  }
  function noteRoute(entry, event) {
    if (event.type === "assistant/message") entry.cacheTtl = cacheTtlFor(event.data?.message?.source?.provider);
  }
  function liveView(entry) {
    const { watcher, dialogueSource, dialogueProjection, cacheTtl } = entry;
    return { state: "live", watcher, dialogueSource, dialogueProjection, cacheTtl };
  }
  function settleWaiters(entry, settle) {
    for (const waiter of entry.waiters) {
      waiter.release();
      settle(waiter);
    }
    entry.waiters.clear();
  }
  function fail(entry, diagnostic3) {
    entry.state = "failed";
    entry.diagnostic = diagnostic3;
    writeDiagnostic(entry.sessionId, diagnostic3);
    releaseSession(entry.sessionId);
    settleWaiters(entry, (waiter) => waiter.reject(new Error(diagnostic3.message)));
    notify(entry.sessionId);
  }
  function remove(entry) {
    const removed = entries.delete(entry.sessionId);
    releaseSession(entry.sessionId);
    settleWaiters(entry, (waiter) => waiter.reject(missingEntry(entry.sessionId)));
    if (removed) notify(entry.sessionId);
  }
  function apply2(entry, frame) {
    writeAll(entry.sessionId, entry.watcher.applyHarnessFrame(frame).diagnostics);
    try {
      advanceRateLampToCurrent(entry.watcher, entry.sessionId, { forcePoll: false });
    } catch (error) {
      writeDiagnostic(entry.sessionId, handlerFailed(error));
    }
  }
  function onFramePath(entry, run2) {
    try {
      run2();
      return true;
    } catch (error) {
      fail(entry, hostDiagnostic("frame_application_failed", error));
      return false;
    }
  }
  const mapped = (event) => modelNames.mapEvent(event);
  function install(entry, events) {
    const lastCall = events.findLast((event) => event.type === "assistant/message");
    if (lastCall !== void 0) noteRoute(entry, lastCall);
    apply2(entry, entry.driver.install(events.map(mapped)));
    for (const event of entry.pending) entry.driver.feed(mapped(event));
    entry.pending = [];
    for (const frame of entry.driver.drain()) apply2(entry, frame);
  }
  async function bootstrap(entry, reading) {
    try {
      let snapshot;
      try {
        snapshot = await reading;
      } catch (error) {
        fail(entry, hostDiagnostic("read_session_rejected", error));
        return;
      }
      await modelNames.warm(modelNames.pairsOf([...snapshot.events, ...entry.pending]));
      if (entry.state !== "bootstrapping") return;
      if (!onFramePath(entry, () => install(entry, snapshot.events))) return;
      if (entry.disposed) {
        try {
          writeAll(entry.sessionId, entry.watcher.closeCurrentSegment().diagnostics);
        } finally {
          remove(entry);
        }
        return;
      }
      entry.state = "live";
      const view = liveView(entry);
      settleWaiters(entry, (waiter) => waiter.resolve(view));
      notify(entry.sessionId);
    } catch (error) {
      fail(entry, handlerFailed(error));
    } finally {
      if (entry.disposed) remove(entry);
    }
  }
  function ensure(session) {
    if (closed) throw new Error("the watcher table is closed");
    const sessionId = session.id;
    if (entries.has(sessionId)) return;
    const entry = {
      sessionId,
      state: "bootstrapping",
      disposed: false,
      cacheTtl: null,
      diagnostic: null,
      waiters: /* @__PURE__ */ new Set(),
      pending: []
    };
    const { watcher, dialogueSource, dialogueProjection } = compose({
      sessionId,
      cwd: session.header.cwd,
      cacheTtl: () => entry.cacheTtl
    });
    Object.assign(entry, { watcher, dialogueSource, dialogueProjection });
    entry.driver = createDshSourceDriver({ sessionId, onDiagnostics: (diagnostics) => writeAll(sessionId, diagnostics) });
    const reading = readSession(sessionId);
    entries.set(sessionId, entry);
    void bootstrap(entry, reading);
  }
  function feed(sessionId, event) {
    const entry = entries.get(sessionId);
    if (entry === void 0 || entry.state !== "bootstrapping" && entry.state !== "live") return;
    if (event.type === "request/header") void modelNames.warm(modelNames.pairsOf([event]));
    let frame = null;
    const applied = onFramePath(entry, () => {
      noteRoute(entry, event);
      if (entry.state === "bootstrapping") {
        entry.pending.push(event);
        return;
      }
      frame = entry.driver.feed(mapped(event));
      if (frame !== null) apply2(entry, frame);
    });
    if (applied && frame !== null) notify(sessionId);
  }
  function dispose(sessionId) {
    const entry = entries.get(sessionId);
    if (entry === void 0) return;
    if (entry.state === "bootstrapping") {
      entry.disposed = true;
      return;
    }
    if (entry.state === "failed") {
      remove(entry);
      return;
    }
    try {
      writeAll(sessionId, entry.watcher.closeCurrentSegment().diagnostics);
    } finally {
      remove(entry);
    }
  }
  function disposeAll() {
    closed = true;
    for (const sessionId of [...entries.keys()]) {
      try {
        dispose(sessionId);
      } catch (error) {
        writeDiagnostic(sessionId, handlerFailed(error));
      }
    }
  }
  function get(sessionId) {
    const entry = entries.get(sessionId);
    if (entry === void 0) return { state: "unobserved" };
    if (entry.state === "live") return liveView(entry);
    if (entry.state === "failed") return { state: "failed", diagnostic: entry.diagnostic };
    return { state: "bootstrapping" };
  }
  function waitLive(sessionId, signal) {
    const entry = entries.get(sessionId);
    if (entry === void 0) return Promise.reject(missingEntry(sessionId));
    if (entry.state === "live") return Promise.resolve(liveView(entry));
    if (entry.state === "failed") return Promise.reject(new Error(entry.diagnostic.message));
    if (signal.aborted) return Promise.reject(aborted(sessionId, signal));
    return new Promise((resolve3, reject) => {
      const onAbort = () => reject(aborted(sessionId, signal));
      const waiter = { resolve: resolve3, reject, release: () => signal.removeEventListener("abort", onAbort) };
      entry.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function live2() {
    return [...entries.values()].filter((entry) => entry.state === "live").map(({ sessionId, watcher }) => ({ sessionId, watcher }));
  }
  function onChange(listener) {
    listeners.add(listener);
  }
  return { ensure, feed, dispose, disposeAll, get, waitLive, live: live2, onChange };
}

// dsh/src/model-names.js
var keyOf = (provider, id) => `${provider}\0${id}`;
var isName = (name3) => typeof name3 === "string" && name3.length > 0;
function pairOf(fields) {
  const { provider, model } = fields ?? {};
  return typeof provider === "string" && typeof model === "string" ? { provider, model } : void 0;
}
function pairOfEvent(event) {
  if (event?.type === "request/header") return pairOf(event.data?.header?.config);
  if (event?.type === "assistant/message") return pairOf(event.data?.message?.source);
  return void 0;
}
function createModelNames({ resolve: resolve3 }) {
  const names = /* @__PURE__ */ new Map();
  const inFlight = /* @__PURE__ */ new Map();
  const store = (key) => ({ name: name3 }) => {
    if (isName(name3)) names.set(key, name3);
  };
  const nameOf = (provider, id) => names.get(keyOf(provider, id));
  function warm(pairs) {
    const waits = [];
    for (const { provider, model } of pairs) {
      const key = keyOf(provider, model);
      if (names.has(key)) continue;
      let pending = inFlight.get(key);
      if (pending === void 0) {
        pending = resolve3(provider, model).then(store(key)).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      waits.push(pending);
    }
    return Promise.allSettled(waits);
  }
  function pairsOf(events) {
    const pairs = /* @__PURE__ */ new Map();
    for (const event of events) {
      const pair = pairOfEvent(event);
      if (pair !== void 0) pairs.set(keyOf(pair.provider, pair.model), pair);
    }
    return [...pairs.values()];
  }
  function mapEvent(event) {
    if (event?.type !== "assistant/message") return event;
    const pair = pairOf(event.data?.message?.source);
    const name3 = pair && nameOf(pair.provider, pair.model);
    if (name3 === void 0) return event;
    const { data } = event;
    const { message } = data;
    return { ...event, data: { ...data, message: { ...message, source: { ...message.source, model: name3 } } } };
  }
  return { nameOf, warm, pairsOf, mapEvent };
}

// lib/lineage.js
function walk(store, projectId, headHandoff, seen = /* @__PURE__ */ new Set()) {
  const chain = [];
  let node = headHandoff;
  while (node && !seen.has(node.sessionId)) {
    seen.add(node.sessionId);
    chain.push({
      sessionId: node.sessionId,
      sourceLocator: node.transcriptPath || null,
      sourceLabel: node.transcriptPath || null,
      handoffId: node.handoffId
    });
    node = store.findParentDelivery(projectId, node.sessionId, node.createdAt);
  }
  return chain.reverse();
}
function fromHandoff({ store, handoffId }) {
  const head = store.getHandoff(handoffId);
  if (!head) return [];
  return walk(store, head.projectId, head);
}
function forLoadedHandoff({ store, sessionId }) {
  const head = store.findLatestDeliveryInSession(sessionId);
  return head ? fromHandoff({ store, handoffId: head.handoffId }) : [];
}

// lib/turn-browse.js
var ROOT_HEADLINE_JOIN = " \xB7 ";
function rootHeadline(rows) {
  const opening = [];
  for (const row of rows) {
    opening.push(row.uText);
    if ((row.note ?? "") !== "") break;
  }
  return opening.join(ROOT_HEADLINE_JOIN);
}
function buildTurnBrowse({ store, lineage }) {
  const sources = labelHistorySources(lineage);
  const sections = [];
  sources.forEach((entry, i2) => {
    const rows = [...store.listTurnNotes(entry.sessionId)].sort((a, b) => a.turnNoteId - b.turnNoteId);
    if (rows.length === 0) return;
    const entries = rows.map((row) => {
      const out2 = { u_text: row.uText };
      if (row.note != null) out2.note = row.note;
      return out2;
    });
    const headline = i2 === 0 ? rootHeadline(rows) : store.getHandoff(sources[i2 - 1].handoffId)?.nextTask ?? "";
    sections.push({ label: entry.label, headline, entries });
  });
  return { sections };
}
function lineageHeadlines({ store, lineage }) {
  return buildTurnBrowse({ store, lineage }).sections.map(({ label, headline }) => ({ label, headline }));
}

// lib/wire.js
function statusWire(status) {
  const { sourceLocator, ...rest } = status;
  const rateLamp = status.rateLamp;
  const lamp = rateLamp?.reliable ? lampZone(rateLamp.br, { u: rateLamp.u, mf: rateLamp.mf }) : null;
  return { ...rest, transcriptPath: sourceLocator ?? null, lamp };
}
function statusWireWithLedger(status, ledger) {
  const payload = statusWire(status);
  const currentKey = payload.rateLamp?.reliable ? stateKeyForStatus(payload) : null;
  mergeLedgerIntoStatus(payload, ledger, currentKey);
  return payload;
}
function statusDigest(payload) {
  const rl = payload.rateLamp;
  const reliable = Boolean(rl.reliable);
  const base = { reliable, model: payload.model, L: payload.L, B: payload.bDefault ?? payload.B };
  if (!reliable) return { ...base, lamp: null, phase: null, br: null, u: null, gEma: null, alert: null };
  return {
    ...base,
    lamp: payload.lamp,
    phase: rl.rentMeter?.depthActive ? rl.rentMeter.depthProgress : null,
    br: rl.br,
    u: rl.u,
    gEma: rl.gEma,
    alert: rl.lastStopEvent?.message ?? null
  };
}
function bucketsPayload({ bucketData, status, sessionId, now }) {
  const paths = bucketData.paths.map((p) => ({ ...p, last_active_turn: p.lastTurn }));
  return {
    ...bucketData,
    paths,
    session_id: sessionId,
    segment: bucketData.segment,
    current_turn: bucketData.currentTurnSeq,
    generated_at: now,
    metrics: { br: status.br, mf: status.mf, pp: status.pp, g: status.g, b_total: status.B, c_ratio: status.cRatio }
  };
}
function bucketSummaryPayload(payload) {
  const row = ({ tokens, readCount, editCount, defaultSelected, defaultDiscardReason, userOverride, activeSymbols }) => ({
    tokens: Math.round(tokens),
    readCount,
    editCount,
    defaultSelected,
    ...defaultDiscardReason ? { defaultDiscardReason } : {},
    userOverride,
    ...activeSymbols ? { activeSymbols } : {}
  });
  return {
    skills: payload.skills.map((s) => ({ name: s.name, ...row(s) })),
    paths: payload.paths.map((p) => ({ path: p.path, ...row(p) })),
    session_id: payload.session_id,
    segment: payload.segment,
    metrics: { br: payload.metrics.br }
  };
}
function overrideWarnings(warnings) {
  return (warnings ?? []).map((w) => w.code === "unknown_resource" ? `ignored: path "${w.resourceKey}" not in current bRebuild` : `ignored: invalid value "${w.value}" for path "${w.resourceKey}"`);
}
var INVALID_OVERRIDES_MESSAGE = 'Body must contain { overrides: { path: "include"|"exclude" } }';
function isOverrideMap(overrides) {
  return Boolean(overrides) && typeof overrides === "object" && !Array.isArray(overrides);
}
function pricingResponse({ model, saved, policy, cliRatio }) {
  const modelRatio = policy.cRatio;
  const presets = policy.pricing.presets;
  let effectiveRatio, source, effectiveRead = null, effectiveWrite = null;
  if (saved) {
    effectiveRatio = saved.ratio;
    source = "saved";
    effectiveRead = saved.readPrice;
    effectiveWrite = saved.writePrice;
    if (saved.presetId) {
      const preset = presets.find((p) => p.id === saved.presetId);
      if (preset && preset.readPrice === saved.readPrice && preset.writePrice === saved.writePrice) {
        source = "preset";
      }
    }
  } else if (cliRatio != null) {
    effectiveRatio = cliRatio;
    source = "cli";
  } else {
    effectiveRatio = modelRatio;
    source = "model_default";
  }
  return {
    effective: { ratio: effectiveRatio, readToWrite: 1 / effectiveRatio, source, readPrice: effectiveRead, writePrice: effectiveWrite },
    saved: saved || null,
    modelDefault: { model, ratio: modelRatio, readPrice: policy.pricing.readPrice, writePrice: policy.pricing.writePrice },
    presets
  };
}
function turnPageWire({ turnPage, nextBefore }) {
  return {
    turn_page: turnPage,
    ...nextBefore ? { next_before: nextBefore } : {}
  };
}
async function loadedHandoffPayload(core, { store, turnPageBuilder, dialogueSource, dialogueProjection, notice }) {
  try {
    const sessions = fromHandoff({ store, handoffId: core.handoff_id });
    return {
      ...core,
      lineage: lineageHeadlines({ store, lineage: sessions }),
      ...turnPageWire(await turnPageBuilder({ store, lineage: sessions, dialogueSource, dialogueProjection, notice }))
    };
  } catch (err2) {
    if (process.env.SW_DEBUG) console.error("[turn_page_load]", err2);
    return { ...core, turn_page_error: "turn_page_unavailable" };
  }
}

// dsh/src/rpc.js
var failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
var live = (payload) => ({ ok: true, value: { state: "live", payload } });
function createRpcHandler({ table, store, now = Date.now, publish = () => {
}, resolvePersisted = async () => null }) {
  function pricing({ watcher, cacheTtl }) {
    const model = watcher.getEpochModel() ?? "";
    return pricingResponse({
      model,
      saved: loadPricingOverride(model),
      policy: modelPolicyFor(model, cacheTtl ?? DEFAULT_CACHE_TTL),
      cliRatio: null
    });
  }
  function refreshLive() {
    for (const { sessionId, watcher } of table.live()) {
      const { changed, diagnostics } = watcher.refreshReadPolicies();
      for (const diagnostic3 of diagnostics) writeDiagnostic(sessionId, diagnostic3);
      if (changed) publish(sessionId);
    }
  }
  function writePricing(entry, write) {
    const model = entry.watcher.getEpochModel() ?? "";
    if (!model) return failure("no_model", NO_MODEL_MESSAGE);
    write(model);
    refreshLive();
    return live(pricing(entry));
  }
  const endpoints = {
    status: ({ watcher }, { sessionId }) => live(statusWireWithLedger(watcher.getStatus(), getLiveLedger(sessionId))),
    history: ({ watcher }) => live(watcher.getHistory()),
    buckets: ({ watcher }, { sessionId }) => live(bucketsPayload({
      bucketData: watcher.getBucketData({ includeSymbols: false }),
      status: watcher.getStatus(),
      sessionId,
      now: now()
    })),
    "turn/browse": (_entry, { sessionId }) => {
      const { sections } = buildTurnBrowse({ store, lineage: forLoadedHandoff({ store, sessionId }) });
      return live({ sections });
    },
    "user-overrides": ({ watcher }, { sessionId, overrides }) => {
      if (!isOverrideMap(overrides)) return failure("invalid_body", INVALID_OVERRIDES_MESSAGE);
      const warnings = overrideWarnings(watcher.replaceUserOverrides(overrides).warnings);
      const response = statusWire(watcher.getStatus());
      if (warnings.length > 0) response.warnings = warnings;
      const reply = live(response);
      publish(sessionId);
      return reply;
    },
    preview: ({ watcher }, { overrides }) => {
      if (!isOverrideMap(overrides)) return failure("invalid_body", INVALID_OVERRIDES_MESSAGE);
      return live({ scenario: watcher.readScenario(overrides) });
    },
    pricing: (entry) => live(pricing(entry)),
    "pricing/save": (entry, { readPrice, writePrice, presetId }) => {
      try {
        validatePricingInput({ readPrice, writePrice });
      } catch (error) {
        return failure("invalid_input", error.message);
      }
      return writePricing(entry, (model) => savePricingOverride(model, { readPrice, writePrice, presetId: sanitizePresetId(presetId) }));
    },
    "pricing/delete": (entry) => writePricing(entry, deletePricingOverride)
  };
  return async (endpoint, payload) => {
    if (!Object.hasOwn(endpoints, endpoint)) return failure("unknown_endpoint", `unknown endpoint ${endpoint}`);
    const body2 = payload || {};
    if (typeof body2.sessionId !== "string") return failure("invalid_body", "Body must contain { sessionId: string }");
    let entry = table.get(body2.sessionId);
    if (entry.state === "unobserved") {
      try {
        await resolvePersisted(body2.sessionId);
      } catch (error) {
        const diagnostic3 = handlerFailed(error);
        writeDiagnostic(body2.sessionId, diagnostic3);
        return failure(diagnostic3.code, diagnostic3.message);
      }
      entry = table.get(body2.sessionId);
    }
    if (entry.state !== "live") return { ok: true, value: entry };
    return endpoints[endpoint](entry, body2);
  };
}

// dsh/src/signal.js
var EVENTS_PATH = "/api/session-watcher.events";
var encoder = new TextEncoder();
var OPEN_FRAME = encoder.encode(": open\n\n");
function createSignalHub() {
  const streams = /* @__PURE__ */ new Set();
  let lifetime = new AbortController();
  async function fetch2(request) {
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let stream;
    const body2 = new ReadableStream({
      start(controller) {
        let ended = false;
        const end = ({ close }) => {
          if (ended) return;
          ended = true;
          signal.removeEventListener("abort", onAbort);
          streams.delete(stream);
          if (close) controller.close();
        };
        const onAbort = () => end({ close: true });
        stream = {
          // `request.signal` follows the carrier's disconnect only while the Request is reachable, and the bridge drops it once `fetch` returns.
          request,
          write(chunk) {
            controller.enqueue(chunk);
          },
          cancel: () => end({ close: false })
        };
        controller.enqueue(OPEN_FRAME);
        streams.add(stream);
        signal.addEventListener("abort", onAbort, { once: true });
      },
      cancel() {
        stream.cancel();
      }
    });
    return new Response(body2, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  function publish(sessionId) {
    const frame = encoder.encode(`data: ${JSON.stringify({ sessionId })}

`);
    for (const stream of streams) stream.write(frame);
  }
  function closeAll() {
    lifetime.abort();
    streams.clear();
    lifetime = new AbortController();
  }
  return {
    route: () => ({ path: EVENTS_PATH, methods: ["GET"], requestBody: "buffered", fetch: fetch2 }),
    publish,
    closeAll
  };
}

// lib/turn-page.js
var notFound = () => Object.assign(new Error("not_found"), { code: "not_found" });
function invariant6(ok, message) {
  if (!ok) throw new Error(`turn page invariant: ${message}`);
}
var physicalLines = (text) => String(text).replace(/\r\n?/g, "\n").split("\n");
function renderRecord(label, record) {
  const address = record.t === null ? null : turnAddress(label, record.t);
  const pad = address === null ? "" : " ".repeat(address.length + 1);
  const rows = physicalLines(record.u).map((line, i2) => `${i2 === 0 && address ? `${address} ` : pad}| U: ${line}`);
  if (record.note != null) rows.push(...physicalLines(record.note).map((line) => `${pad}| A: ${line}`));
  return rows.join("\n");
}
function renderPage(entries, notice) {
  const blocks = [notice];
  let openIndex = null;
  for (const entry of entries) {
    if (entry.index !== openIndex) {
      blocks.push(`${entry.label}  ${entry.sourceLabel}`);
      openIndex = entry.index;
    }
    blocks.push(renderRecord(entry.label, entry.record));
  }
  return blocks.join("\n\n");
}
var byOrdinal = (a, b) => a.record.t - b.record.t;
var byAnchor = (a, b) => a.anchorUuid < b.anchorUuid ? -1 : a.anchorUuid > b.anchorUuid ? 1 : 0;
async function projectSession(store, entry, readSource) {
  const { readable, turns } = await readSource(entry.sourceLocator);
  const ordinals = readable ? activePathOrdinals(turns) : null;
  const addressable = ordinals !== null && ordinals.size > 0;
  const records = [];
  for (const row of store.listTurnNotes(entry.sessionId)) {
    const record = projectTurnRecord(row, ordinals);
    if (record.t === null && addressable) continue;
    records.push({
      index: entry.index,
      label: entry.label,
      sessionId: entry.sessionId,
      sourceLabel: entry.sourceLabel,
      record,
      anchorUuid: row.anchorUuid
    });
  }
  records.sort(addressable ? byOrdinal : byAnchor);
  return { readable, records };
}
async function buildTurnPage({ store, lineage, before = null, dialogueSource, dialogueProjection, notice }) {
  invariant6(typeof notice === "string" && notice.length > 0, "notice is required");
  const sources = labelHistorySources(lineage);
  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const parsed = /* @__PURE__ */ new Map();
  const sessionAt = (index) => {
    if (!parsed.has(index)) parsed.set(index, projectSession(store, sources[index], readSource));
    return parsed.get(index);
  };
  const boundary = before == null ? null : await resolveBefore(before, sources, sessionAt);
  const newestIndex = boundary ? boundary.index : sources.length - 1;
  const windowAt = async (index) => {
    const { records } = await sessionAt(index);
    if (!boundary || index !== boundary.index || boundary.t === null) return records;
    return records.filter((e) => e.record.t < boundary.t);
  };
  let entries = [];
  let turnPage = "";
  let olderRemains = false;
  fill:
    for (let index = newestIndex; index >= 0; index--) {
      const window2 = await windowAt(index);
      for (let i2 = window2.length - 1; i2 >= 0; i2--) {
        const candidate = [window2[i2], ...entries];
        const rendered = renderPage(candidate, notice);
        if (!isWithinHistoryBudget(estimateWireTokens({ turn_page: rendered }, DEFAULT_CTP))) {
          olderRemains = true;
          break fill;
        }
        entries = candidate;
        turnPage = rendered;
      }
    }
  if (entries.length === 0) return { turnPage: "", nextBefore: null };
  const head = entries[0].record;
  const nextBefore = olderRemains && head.t !== null ? turnAddress(entries[0].label, head.t) : null;
  return { turnPage, nextBefore };
}
async function resolveBefore(before, sources, sessionAt) {
  const parsed = parseTurnPageBoundary(before);
  if (!parsed) throw notFound();
  const index = sources.findIndex((entry) => entry.label === parsed.label);
  if (index < 0) throw notFound();
  if (parsed.sourceOrdinal === null) return { index, t: null };
  const t = parsed.sourceOrdinal;
  if (!(await sessionAt(index)).records.some((entry) => entry.record.t === t)) throw notFound();
  return { index, t };
}

// lib/turn-tool-recovery.js
var NO_HANDOFF_LOADED = Object.freeze({
  error: "no_handoff_loaded",
  recovery: "This session has no delivered handoff, so there is no lineage to read. Call load_handoff first; the read tools resolve their lineage from that delivery."
});
var STALE_CURSOR_MESSAGE = "That before boundary resolves to nothing in this lineage. Omit before to start again from the newest page, or take a session label from the load reply's lineage.";
var SCOPE_ABSENT_MESSAGE = "That S{k}:{T} scope names a turn this lineage does not contain. Call turn_locate for a current scope, or omit scope to cover the whole lineage.";
var PAGE_IS_THE_FALLBACK = "Read the lineage with turn_page instead \u2014 it paginates deterministically over the same sessions and needs no query.";
function withPageRecovery(result) {
  if (result?.error === "turn_page_unavailable") {
    return { ...result, recovery: "Call turn_page again; it reads the transcript and the store afresh on every call. Search and locate have independent projections and may still answer." };
  }
  return result;
}
function withSearchRecovery(result, { hitRecovery } = {}) {
  if (result?.error === "search_unavailable") {
    return { ...result, recovery: PAGE_IS_THE_FALLBACK };
  }
  if (result?.found === false) {
    return { ...result, recovery: "No readable transcript holds that literal; a near-miss misses like an absent one. Search a shorter fragment or a token seen verbatim \u2014 an id, a path, a commit hash \u2014 or call turn_locate with a remembered term for candidate turns and the wording actually used." };
  }
  if (result?.truncated === true) {
    return { ...result, recovery: "Older matches were dropped to fit the budget, and the cut falls on a match, so the oldest entry may be incomplete. Narrow and search again: a longer literal, the scope of an entry near what you are after, or turn_locate for a candidate." };
  }
  if (result?.found === true) {
    return { ...result, recovery: hitRecovery };
  }
  return result;
}
function withLocateRecovery(result, { hitRecovery } = {}) {
  if (result?.error === "locate_unavailable") {
    return { ...result, recovery: PAGE_IS_THE_FALLBACK };
  }
  if (result?.found === false) {
    return { ...result, recovery: "The index holds only turns captured at handoff time, so a miss bounds the index, not the history. Retry with fewer words, read the lineage with turn_page, or turn_search a fragment you are sure of." };
  }
  if (result?.found === true) {
    return { ...result, recovery: hitRecovery };
  }
  return result;
}
function withLoadRecovery(result) {
  if (result?.error === "handoff_delivery_unavailable") {
    return { ...result, recovery: "The delivery record could not be written, so this response carries no content. Call load_handoff again with the same token once the store is writable." };
  }
  if (result?.turn_page_error) {
    return { ...result, recovery: "The handoff loaded and the rest of this response is complete; only its turn page and the lineage headlines beside it failed to build. Call turn_page to obtain the page." };
  }
  return result;
}

// lib/turn-query.js
var LOCATE_CANDIDATES = 5;
var LOCATE_WINDOW = 2;
var scopeNotFound = () => Object.assign(new Error("scope_not_found"), { code: "scope_not_found" });
function foldAscii(s) {
  let out2 = "";
  for (let i2 = 0; i2 < s.length; i2++) {
    const c = s.charCodeAt(i2);
    out2 += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i2];
  }
  return out2;
}
function canonicalEntities(fold, includeToolEvidence2) {
  const entities = [];
  for (const line of dialogueFoldLines(fold)) {
    if (line.kind === "visible") {
      entities.push({ text: line.message.text, line: line.sourceOrdinal });
      continue;
    }
    if (!includeToolEvidence2(line.tool)) continue;
    const useLine = line.sourceOrdinal;
    if (typeof line.tool.name === "string") entities.push({ text: line.tool.name, line: useLine });
    if (line.tool.input != null) entities.push({ text: stableStringify(line.tool.input), line: useLine });
    const { resultStr } = serializeResult(line.tool.result);
    if (resultStr !== null) {
      entities.push({ text: resultStr, line: line.tool.resultSourceOrdinal ?? useLine });
    }
  }
  return entities;
}
var isHighSurrogate = (c) => c >= 55296 && c <= 56319;
var isLowSurrogate = (c) => c >= 56320 && c <= 57343;
function excerptAround(entity, hitStart, hitLength) {
  const hitEnd = hitStart + hitLength;
  const remaining = Math.max(0, HISTORY_EXCERPT_CHARS - hitLength);
  const before = Math.floor(remaining / 2);
  let start2 = hitStart - before;
  let end = hitEnd + (remaining - before);
  if (start2 < 0) {
    end -= start2;
    start2 = 0;
  }
  if (end > entity.length) {
    start2 -= end - entity.length;
    end = entity.length;
  }
  if (start2 < 0) start2 = 0;
  if (start2 < hitStart && isLowSurrogate(entity.charCodeAt(start2))) start2++;
  if (end > hitEnd && isHighSurrogate(entity.charCodeAt(end - 1))) end--;
  return (start2 > 0 ? "\u2026" : "") + entity.slice(start2, end) + (end < entity.length ? "\u2026" : "");
}
function firstHit(entities, needle) {
  for (const entity of entities) {
    const index = foldAscii(entity.text).indexOf(needle);
    if (index >= 0) return { text: entity.text, index, line: entity.line };
  }
  return null;
}
async function* sessionsToScan(sources, scope, readSource) {
  if (scope != null) {
    yield await scopedSession(sources, scope, readSource);
    return;
  }
  for (let index = sources.length - 1; index >= 0; index--) {
    const entry = sources[index];
    if (!entry.sourceLocator) continue;
    const read = await readSource(entry.sourceLocator);
    if (!read.readable) continue;
    yield { entry, folds: read.folds, turns: read.turns };
  }
}
async function scopedSession(sources, scope, readSource) {
  const parsed = parseTurnAddress(scope);
  if (!parsed) throw scopeNotFound();
  const entry = sources.find((e) => e.label === parsed.label);
  if (!entry || !entry.sourceLocator) throw scopeNotFound();
  const read = await readSource(entry.sourceLocator);
  if (!read.readable) throw scopeNotFound();
  const turns = read.turns.filter((turn) => turn.sourceOrdinal === parsed.sourceOrdinal);
  if (turns.length !== 1) throw scopeNotFound();
  const span = new Set(turns[0].lines.map((line) => line.foldOrdinal));
  return {
    entry,
    folds: read.folds.filter((fold) => span.has(fold.ordinal)),
    turns
  };
}
function turnByFold(turns) {
  const byFold = /* @__PURE__ */ new Map();
  turns.forEach((turn, turnIndex) => {
    for (const line of turn.lines) {
      byFold.set(line.foldOrdinal, { turnIndex, sourceEntryId: turn.sourceEntryId });
    }
  });
  return byFold;
}
var headFoldsOf = (turns) => new Set(turns.map((turn) => turn.lines[0].foldOrdinal));
async function recordByTurnHead(store, entry, turns) {
  const { records } = await projectSession(store, entry, () => ({ readable: true, turns }));
  return new Map(records.filter((r) => r.record.t !== null).map((r) => [r.anchorUuid, r.record]));
}
var foldSpan = (fold) => {
  const own = fold.sourceOrdinal;
  let min = own;
  let max = own;
  for (const pair of fold.toolPairs || []) {
    const at = pair.resultSourceOrdinal;
    if (at == null) continue;
    if (at < min) min = at;
    if (at > max) max = at;
  }
  return [min, max];
};
async function searchTranscripts({
  store,
  lineage,
  q,
  scope = null,
  dialogueSource,
  dialogueProjection,
  includeToolEvidence: includeToolEvidence2
}) {
  const sources = labelHistorySources(lineage);
  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const needle = foldAscii(String(q));
  const wire = (ranges, truncated2) => ({ found: true, ranges, truncated: truncated2 });
  const groupsOf = (matches) => {
    const out2 = [];
    let session = null;
    let byTurn = /* @__PURE__ */ new Map();
    for (const m of matches) {
      if (m.sessionId !== session) {
        session = m.sessionId;
        byTurn = /* @__PURE__ */ new Map();
      }
      const open = byTurn.get(m.turnKey);
      if (open) {
        open.matches.push(m.wire);
        continue;
      }
      const fresh = { label: m.label, record: m.record, sourceLabel: m.sourceLabel, matches: [m.wire] };
      byTurn.set(m.turnKey, fresh);
      out2.push(fresh);
    }
    return out2.map(({ label, record, sourceLabel, matches: inner }) => ({
      // The Source whose rows the matches' `line` numbers name, carried once for the turn. The session id
      // is not carried beside it: Claude Code names a Source for its session, so the identity travels
      // inside the label.
      transcript_path: sourceLabel,
      // The containing turn's own address and record, so a hit can be paged from and narrowed around
      // instead of being a navigational dead end — carried once for the turn rather than once per match.
      // All three arrive or none does: a turn with no usable record — one that earned no note, one past
      // the handoff's capture boundary, or one positioning nothing on the active path — leaves its
      // matches exactly as bare as they were rather than half-addressed. `scope` addresses the TURN,
      // while a match's own `line` addresses one row, so the two are not two spellings of one thing.
      ...record && {
        scope: turnAddress(label, record.t),
        u: record.u,
        ...record.note != null && { note: record.note }
      },
      matches: inner
    }));
  };
  const wireOf = (matches) => wire(groupsOf([...matches].reverse()), false);
  const retained = [];
  let truncated = false;
  scan:
    for await (const { entry, folds, turns } of sessionsToScan(sources, scope, readSource)) {
      let membership = null;
      let recordByHead = null;
      let headFolds = null;
      for (let i2 = folds.length - 1; i2 >= 0; i2--) {
        const fold = folds[i2];
        const hit = firstHit(canonicalEntities(fold, includeToolEvidence2), needle);
        if (!hit) continue;
        headFolds ??= headFoldsOf(turns);
        if (fold.message && fold.message.role === "human" && !headFolds.has(fold.ordinal)) continue;
        let turnKey = entry.sessionId;
        let record = null;
        if (scope == null) {
          membership ??= turnByFold(turns);
          recordByHead ??= await recordByTurnHead(store, entry, turns);
          const member = membership.get(fold.ordinal);
          turnKey = member ? member.turnIndex : `fold:${fold.ordinal}`;
          record = member && member.sourceEntryId ? recordByHead.get(member.sourceEntryId) ?? null : null;
        }
        const candidate = {
          sessionId: entry.sessionId,
          label: entry.label,
          turnKey,
          record,
          sourceLabel: entry.sourceLabel,
          wire: { line: hit.line, span: foldSpan(fold), excerpt: excerptAround(hit.text, hit.index, needle.length) }
        };
        if (!isWithinHistoryBudget(estimateWireTokens(wireOf([...retained, candidate]), DEFAULT_CTP))) {
          truncated = true;
          break scan;
        }
        retained.push(candidate);
      }
    }
  if (retained.length === 0 && !truncated) return { found: false };
  return wire(groupsOf([...retained].reverse()), truncated);
}
var locateUnavailable = (cause) => Object.assign(
  new Error("locate_unavailable", cause === void 0 ? void 0 : { cause }),
  { code: "locate_unavailable" }
);
var notePreview = (note) => {
  const cut = truncateToTokens(note, NOTE_PREVIEW_TOKENS, DEFAULT_CTP);
  return cut === note ? note : `${cut}${truncationMarker(note.length)}`;
};
var scopeOf = ({ label, record }) => turnAddress(label, record.t);
var locateEntry = (projected, isHit, sourceLabel) => {
  const { index, record } = projected;
  const wire = { scope: scopeOf(projected), u: record.u };
  if (record.note != null) wire.note = isHit ? record.note : notePreview(record.note);
  if (isHit) {
    wire.hit = true;
    wire.transcript_path = sourceLabel;
  }
  return { index, t: record.t, wire };
};
var locateWire = (accumulated) => ({
  found: true,
  ranges: [...accumulated.values()].sort((a, b) => a.index - b.index || a.t - b.t).map((e) => e.wire)
});
async function locateRanges({ store, lineage, q, dialogueSource, dialogueProjection }) {
  if (!store.turnFtsAvailable()) throw locateUnavailable();
  const readSource = (locator) => readHistorySource({ dialogueSource, dialogueProjection }, locator);
  const sessions = new Map(labelHistorySources(lineage).map((entry) => [entry.sessionId, entry]));
  let rows;
  try {
    rows = store.locateTurnNotes([...sessions.keys()], buildFtsMatch(q, "plain"));
  } catch (error) {
    throw locateUnavailable(error);
  }
  const projected = /* @__PURE__ */ new Map();
  let accumulated = /* @__PURE__ */ new Map();
  let hits = 0;
  for (const row of rows) {
    const entry = sessions.get(row.sourceSessionId);
    if (!entry) continue;
    if (!projected.has(entry.sessionId)) {
      const { readable, records } = await projectSession(store, entry, readSource);
      projected.set(entry.sessionId, readable ? { records, indexByAnchor: new Map(records.map((r, i2) => [r.anchorUuid, i2])) } : null);
    }
    const session = projected.get(entry.sessionId);
    if (!session) continue;
    const at = session.indexByAnchor.get(row.anchorUuid);
    if (at === void 0 || session.records[at].record.t === null) continue;
    const next = new Map(accumulated);
    const first = Math.max(0, at - LOCATE_WINDOW);
    const last = Math.min(session.records.length - 1, at + LOCATE_WINDOW);
    for (let i2 = first; i2 <= last; i2++) {
      const candidate = session.records[i2];
      const scope = scopeOf(candidate);
      if (i2 === at || !next.has(scope)) next.set(scope, locateEntry(candidate, i2 === at, entry.sourceLabel));
    }
    if (!isWithinHistoryBudget(estimateWireTokens(locateWire(next), DEFAULT_CTP))) break;
    accumulated = next;
    if (++hits === LOCATE_CANDIDATES) break;
  }
  if (hits === 0) return { found: false };
  return locateWire(accumulated);
}

// lib/turn-read-service.js
function createTurnReadService({
  store,
  sessionId,
  dialogueSource,
  dialogueProjection,
  includeToolEvidence: includeToolEvidence2,
  recovery,
  turnPageBuilder = buildTurnPage
}) {
  const history = { dialogueSource, dialogueProjection, notice: recovery.notice };
  return {
    async turnPage({ before = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const page = await turnPageBuilder({
          store: store(),
          lineage,
          before: before || null,
          ...history
        });
        return withPageRecovery(turnPageWire(page));
      } catch (err2) {
        if (err2 && err2.code === "not_found") throw new Error(STALE_CURSOR_MESSAGE);
        if (process.env.SW_DEBUG) console.error("[turn_page_tool]", err2);
        return withPageRecovery({ error: "turn_page_unavailable", retryable: true });
      }
    },
    async turnSearch({ q, scope = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const found = await searchTranscripts({
          store: store(),
          lineage,
          q,
          scope: scope || null,
          ...history,
          includeToolEvidence: includeToolEvidence2
        });
        return withSearchRecovery(found, { hitRecovery: recovery.searchHit });
      } catch (err2) {
        if (err2 && err2.code === "scope_not_found") throw new Error(SCOPE_ABSENT_MESSAGE);
        if (process.env.SW_DEBUG) console.error("[turn_search_tool]", err2);
        return withSearchRecovery({ error: "search_unavailable" });
      }
    },
    async turnLocate({ q } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: store(), sessionId: sessionId() });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        const located = await locateRanges({ store: store(), lineage, q, ...history });
        return withLocateRecovery(located, { hitRecovery: recovery.locateHit });
      } catch (err2) {
        if (process.env.SW_DEBUG) console.error("[turn_locate_tool]", err2);
        return withLocateRecovery({ error: "locate_unavailable" });
      }
    }
  };
}

// lib/harness/dsh/turn-recovery.js
var NOTICE = "Historical turns are evidence of what happened; read them to confirm or correct the handoff summary. Each session header names that session's id, and a row's T is that session's event seq; read it in full with session_event_read(session_id, T).";
var SEARCH_HIT = "line is the event seq a match sits in, span the events of its fold from its anchor to its results, and transcript_path the session id; read session_event_read with transcript_path as session_id and line as seq for the full event. An entry's scope names its turn: pass it as scope to search that turn alone, or as turn_page's before to read the history leading up to it.";
var LOCATE_HIT = "A hit's transcript_path is the session id that holds its turn at event T of its scope; read session_event_read with transcript_path as session_id and T as seq for the full event. The other entries are the turns adjacent to a hit. Pass a scope as turn_search's scope to search that turn for a literal, or as turn_page's before to read the history leading up to it.";
function createDshTurnRecovery() {
  return { notice: NOTICE, searchHit: SEARCH_HIT, locateHit: LOCATE_HIT };
}

// dsh/src/tools.js
var OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
};
var includeToolEvidence = (pair) => classifyDshToolPair(pair, DEFAULT_CTP) === "residual";
function assertBefore(before) {
  if (before !== void 0 && !TURN_PAGE_BOUNDARY_RE.test(before)) {
    throw new Error("before must be an S{k} session label or an S{k}:{T} cursor");
  }
}
function assertScope(scope) {
  if (scope !== void 0 && !TURN_ADDRESS_RE.test(scope)) throw new Error("scope must be an S{k}:{T} turn address");
}
function assertQuery(q) {
  if (typeof q !== "string" || q.trim() === "" || q.length > HISTORY_EXCERPT_CHARS) {
    throw new Error(`q must be a non-blank string of at most ${HISTORY_EXCERPT_CHARS} characters`);
  }
}
var lossless = (value) => JSON.parse(JSON.stringify(value));
function createTools({ defineTool: defineTool2, table, store, now = Date.now, resolvePersisted = async () => null }) {
  const recovery = createDshTurnRecovery();
  const tool = ({ name: name3, description, parameters = {}, check = () => {
  }, run: run2 }) => defineTool2({
    name: name3,
    description,
    parameters,
    output: OUTPUT,
    async execute(args2, exec) {
      check(args2);
      const sessionId = exec.agent.session.id;
      const entry = await table.waitLive(sessionId, exec.signal);
      return lossless(await run2(args2, { ...entry, sessionId }));
    }
  });
  const turnReads = ({ sessionId, dialogueSource, dialogueProjection }) => createTurnReadService({
    store: () => store,
    sessionId: () => sessionId,
    dialogueSource,
    dialogueProjection,
    includeToolEvidence,
    recovery
  });
  async function loadHandoff({ watcher, dialogueSource, dialogueProjection }, { load_token, query, query_mode }) {
    if (!load_token && query) return watcher.searchHandoffs({ query: String(query), queryMode: query_mode });
    const delivered = await watcher.deliverHandoff(load_token ? { loadToken: String(load_token) } : {});
    if (delivered.ok === false) return { error: delivered.error, retryable: delivered.retryable === true };
    if (!delivered.found) return delivered;
    return loadedHandoffPayload(delivered, {
      store,
      turnPageBuilder: buildTurnPage,
      dialogueSource,
      dialogueProjection,
      notice: recovery.notice
    });
  }
  return [
    defineTool2({
      name: "watcher_status",
      description: "Report whether the Session Watcher is running, the dashboard URL where the host serves one, and one session's current reading: lamp, phase (the wallet clock's), br, u, gEma (smoothed context growth, tokens per call), L, B, model and alert.",
      parameters: {
        sessionId: { type: "string", description: "Session to read. Defaults to the calling session; any session this host has run or persisted is readable, and one that has ended is reconstructed first." }
      },
      output: OUTPUT,
      async execute({ sessionId }, exec) {
        const target = sessionId ?? exec.agent.session.id;
        if (sessionId !== void 0 && table.get(sessionId).state === "unobserved" && await resolvePersisted(sessionId, exec.signal) === null) {
          throw new Error(`session ${sessionId} is neither running nor persisted on this host`);
        }
        const { watcher } = await table.waitLive(target, exec.signal);
        return lossless({
          running: true,
          sessionId: target,
          reading: statusDigest(statusWireWithLedger(watcher.getStatus(), getLiveLedger(target)))
        });
      }
    }),
    tool({
      name: "get_bucket_summary",
      description: "Return the current context bucket structure (files, skills) with each row's token size and the session's br, so the agent can decide what to carry over before the context reset the host offers.",
      run: (_args, { watcher, sessionId }) => bucketSummaryPayload(bucketsPayload({
        bucketData: watcher.getBucketData({ includeSymbols: true }),
        status: watcher.getStatus(),
        sessionId,
        now: now()
      }))
    }),
    tool({
      name: "prepare_handoff",
      description: "Persist a keep/discard decision + structured summary before the context reset the host offers; returns a human-readable token to restore context in the next segment.",
      parameters: {
        paths_to_keep: {
          type: "array",
          description: "Files to carry over with optional symbol hints; lines are auto-populated from B_rebuild data",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              path: { type: "string", required: true, description: "File path (project-relative)" },
              symbols: { type: "array", items: { type: "string" }, description: "Key symbols to focus on in this file (function/class names)" }
            }
          }
        },
        skills_to_keep: { type: "array", items: { type: "string" }, description: 'Skill names to carry over (e.g. "systematic-debugging", "brainstorming")' },
        load_token: { type: "string", description: 'Existing token to revise. An undelivered handoff keeps its token and changes only the parameters passed \u2014 the others keep their stored values, and `skills_to_keep: []` or `next_task: ""` clears its own. A delivered handoff is immutable, so passing its token creates a new handoff from the parameters given, under a new token. Omit to create new' },
        summary: { type: "string", description: "Structured summary of current work state" },
        next_task: { type: "string", description: "What comes next" },
        observed_segment: { type: "integer", description: "Segment index from get_bucket_summary, for a consistency check" }
      },
      run: ({
        paths_to_keep,
        skills_to_keep,
        summary,
        next_task,
        observed_segment,
        load_token
      }, { watcher }) => watcher.prepareHandoff({
        pathsToKeep: paths_to_keep,
        skillsToKeep: skills_to_keep,
        summary,
        nextTask: next_task,
        observedSegment: observed_segment,
        loadToken: load_token
      })
    }),
    tool({
      name: "load_handoff",
      description: "Retrieve a prepared handoff package by token, by free-text search, or \u2014 with neither given \u2014 by auto-match over undelivered handoffs of this project from other sessions. A retrieved package carries the lineage behind it as one headline per session, oldest to newest, beside the newest page of its turns.",
      parameters: {
        load_token: { type: "string", description: "Semantic token from prepare_handoff (exact match)" },
        query: { type: "string", description: "Free-text search when the token is unknown; returns top matches" },
        query_mode: { type: "string", enum: ["plain", "advanced"], description: "plain (default) escapes input; advanced passes raw FTS5 syntax" }
      },
      run: async (args2, entry) => withLoadRecovery(await loadHandoff(entry, args2))
    }),
    tool({
      name: "get_turn_skeleton",
      description: "Write the current context epoch to a turn skeleton file and a notes file whose `## NOTE[T]` headings are the slot set, and return both paths, the snapshot id to submit against, and the protocol for filling them.",
      run: (_args, { watcher }) => watcher.getTurnSkeleton()
    }),
    tool({
      name: "submit_turn_notes",
      description: "Commit the notes file the latest get_turn_skeleton wrote. Session Watcher locates that file itself, so no note text crosses the wire. All-or-nothing: every NOTE slot must be covered \u2014 by a section in the notes file or by a row the store already holds for that turn \u2014 and the snapshot must still be current.",
      parameters: {
        snapshot_id: { type: "string", required: true, description: "snapshot_id from get_turn_skeleton" }
      },
      run: ({ snapshot_id }, { watcher }) => watcher.submitTurnNotes({ snapshot_id })
    }),
    tool({
      name: "turn_page",
      description: "Read a page of the history turns carried by the handoff loaded into this session, newest first.",
      parameters: {
        before: { type: "string", description: "Where to read back from: an S{k}:{T} cursor from the next_before of the handoff load reply or of a previous page, which ends the page before that turn; or a bare S{k} session label from the load reply's lineage, which starts at that session's end. Omit for the newest page." }
      },
      check: ({ before }) => assertBefore(before),
      run: (args2, entry) => turnReads(entry).turnPage(args2)
    }),
    tool({
      name: "turn_search",
      description: "Find a known literal in the transcripts behind the handoff loaded into this session: behaves as grep -F -i -n over them, limited to the active path. Returns one entry per turn the literal landed in, oldest to newest.",
      parameters: {
        q: { type: "string", required: true, description: "An exact literal, matched as a case-folded ASCII substring with no tokenization: spacing, punctuation and CJK must match the transcript exactly. A shorter literal reaches more turns, a longer one fewer. Use turn_locate when the wording is uncertain." },
        scope: { type: "string", description: "An S{k}:{T} from turn_locate or from a search entry, narrowing the search to that one turn. Omit to cover the whole lineage." }
      },
      check: ({ q, scope }) => {
        assertQuery(q);
        assertScope(scope);
      },
      run: (args2, entry) => turnReads(entry).turnSearch(args2)
    }),
    tool({
      name: "turn_locate",
      description: "Find which turns of the loaded handoff mention a remembered term, when the source wording is unknown. Returns entries oldest to newest, each carrying its turn's S{k}:{T} scope.",
      parameters: {
        q: { type: "string", required: true, description: "One distinctive term, a file path, or a note. Resolved through FTS5 \u2014 words are ANDed and CJK is split into bigrams, so a longer phrase narrows toward zero matches." }
      },
      check: ({ q }) => assertQuery(q),
      run: (args2, entry) => turnReads(entry).turnLocate(args2)
    })
  ];
}

// dsh/src/skills.js
import { existsSync, readdirSync, readFileSync as readFileSync5 } from "node:fs";
import { join as join7 } from "node:path";
function parseFrontmatter(text) {
  const [, block = "", body2 = text] = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)/.exec(text) ?? [];
  const fields = {};
  for (const [, key, value] of block.matchAll(/^([\w-]+):[ \t]*(.*?)[ \t]*$/gm)) {
    fields[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return { fields, body: body2 };
}
function registerSkills(ctx, { skillsDir }) {
  for (const entry of readdirSync(skillsDir)) {
    const directory = join7(skillsDir, entry);
    const path3 = join7(directory, "SKILL.md");
    if (!existsSync(path3)) continue;
    const { fields: { name: name3, description }, body: body2 } = parseFrontmatter(readFileSync5(path3, "utf8"));
    ctx.skills.register({
      name: name3,
      description,
      content: body2.trim(),
      source: "bundled",
      resourceBase: { kind: "directory", path: directory },
      path: path3
    });
  }
}

// dsh/src/catalog.js
import { randomUUID } from "node:crypto";

// lib/handoff-discovery.js
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
function discoverHandoffs(dbPath, projectId, sessionId, { ttlDays, queryLimit }) {
  if (!projectId || !sessionId) return [];
  let db;
  try {
    db = new DatabaseSync2(dbPath, { readOnly: true });
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='handoff'"
    ).get();
    if (!tableCheck) return [];
    const cutoff = Date.now() - ttlDays * 24 * 3600 * 1e3;
    const stmt = db.prepare(`SELECT load_token, next_task, created_at, summary_tokens, kept_tokens
      FROM handoff
      WHERE project_id = ? AND delivered_at IS NULL AND session_id <> ? AND created_at > ?
      ORDER BY created_at DESC LIMIT ?`);
    return stmt.all(projectId, sessionId, cutoff, queryLimit);
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {
    }
  }
}
function formatHandoffContext(rows, maxDisplay, taskPreviewChars) {
  if (!rows || rows.length === 0) return null;
  const hasMore = rows.length > maxDisplay;
  const display = rows.slice(0, maxDisplay);
  const formatTokens = (summaryTok, keptTok) => {
    const total = (summaryTok || 0) + (keptTok || 0);
    if (total === 0) return null;
    if (total >= 1e3) return `~${Math.round(total / 1e3)}k tokens`;
    return `~${total} tokens`;
  };
  const formatAge = (createdAt) => {
    const diffMs = Math.max(0, Date.now() - createdAt);
    const mins = Math.floor(diffMs / 6e4);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };
  const truncTask = (task) => {
    if (!task) return "";
    if (task.length <= taskPreviewChars) return task;
    return task.slice(0, taskPreviewChars - 3) + "...";
  };
  if (display.length === 1) {
    const r = display[0];
    const age = formatAge(r.created_at);
    const tokens = formatTokens(r.summary_tokens, r.kept_tokens);
    const tokStr = tokens ? `, ${tokens} to restore` : "";
    const taskLine = r.next_task ? `
Task: ${truncTask(r.next_task)}` : "";
    return `[Session Watcher] Handoff available (token: ${r.load_token}, ${age}${tokStr}).${taskLine}`;
  }
  const header = hasMore ? `[Session Watcher] ${maxDisplay}+ pending handoffs (showing newest ${maxDisplay}):` : `[Session Watcher] ${display.length} pending handoffs for this project:`;
  const lines = display.map((r, i2) => {
    const age = formatAge(r.created_at);
    const tokens = formatTokens(r.summary_tokens, r.kept_tokens);
    const tokStr = tokens ? `, ${tokens}` : "";
    const task = truncTask(r.next_task);
    const taskStr = task ? ` \u2014 ${task}` : "";
    return `${i2 + 1}. ${r.load_token} (${age}${tokStr})${taskStr}`;
  });
  const footer = hasMore ? "(older handoffs available \u2014 use load_handoff with a query to search)" : "";
  return [header, ...lines, footer].join("\n");
}

// dsh/src/catalog.js
function catalogMessageFor({ dbPath, projectId, sessionId }) {
  const rows = discoverHandoffs(dbPath, projectId, sessionId, {
    ttlDays: HANDOFF_HOOK_TTL_DAYS,
    queryLimit: HANDOFF_HOOK_QUERY_LIMIT
  });
  const text = formatHandoffContext(rows, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS);
  if (text === null) return null;
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "session-watcher", form: "catalog" }
  };
}

// dsh/src/host.js
var HOST_INJECT = ["sessions", "sessionQuery", "tools", "skills", "llm"];
function applyHost(ctx, { storePath, turnNotesRoot, loadIsIgnored: loadIsIgnored2, defineTool: defineTool2, skillsDir }) {
  initStore(storePath);
  ctx.effect(() => () => {
    try {
      table.disposeAll();
    } catch (error) {
      writeDiagnostic(null, handlerFailed(error));
    }
    try {
      closeStoreGlobal();
    } catch (error) {
      writeDiagnostic(null, handlerFailed(error));
    }
  });
  let readCacheRetention = () => null;
  const readSession = (sessionId) => ctx.sessionQuery.readSession(sessionId);
  const modelNames = createModelNames({ resolve: async (provider, id) => ctx.llm.resolveModelInfo(provider, id) });
  const table = createWatcherTable({
    readSession,
    modelNames,
    cacheTtlFor: (route) => cacheTtlForRetention(readCacheRetention(route)),
    compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
      sessionId,
      cwd,
      cacheTtl,
      store: getStore(),
      turnNotesRoot,
      readSession,
      isIgnored: loadIsIgnored2(cwd)
    })
  });
  const resolvePersisted = async (sessionId, signal) => {
    const record = (await ctx.sessionQuery.listSessions(signal)).find((each) => each.header.id === sessionId) ?? null;
    if (record !== null) table.ensure({ id: record.header.id, header: record.header });
    return record;
  };
  const hub = createSignalHub();
  table.onChange((sessionId) => hub.publish(sessionId));
  const guarded = (sessionId, body2) => {
    try {
      body2();
    } catch (error) {
      writeDiagnostic(sessionId, handlerFailed(error));
    }
  };
  for (const session of ctx.sessions.list()) guarded(session.id, () => table.ensure(session));
  ctx.on("session/created", (session) => guarded(session.id, () => table.ensure(session)), { global: true });
  ctx.on("session/event", (session, event) => guarded(session.id, () => {
    table.ensure(session);
    table.feed(session.id, event);
  }));
  ctx.on("session/disposed", (session) => guarded(session.id, () => table.dispose(session.id)));
  ctx.on("agent/created", ({ agent, source }) => guarded(agent.session.id, () => {
    if (source !== "startup" && source !== "resume") return;
    if (agent.session.header.origin === "subagent") return;
    const message = catalogMessageFor({
      dbPath: storePath,
      projectId: resolveProjectKey({ cwd: agent.session.header.cwd }),
      sessionId: agent.session.id
    });
    if (message !== null) agent.inject(message);
  }));
  for (const definition of createTools({ defineTool: defineTool2, table, store: getStore(), resolvePersisted })) ctx.tools.register(definition);
  registerSkills(ctx, { skillsDir });
  ctx.inject(["connection"], (child) => {
    const remove = child.root.get("connection").rpc.handle("/session-watcher", createRpcHandler({
      table,
      store: getStore(),
      publish: hub.publish,
      resolvePersisted
    }));
    child.effect(() => remove);
    child.connection.fetch.register(hub.route());
    child.effect(() => () => hub.closeAll());
  });
  ctx.inject(["settings"], (child) => {
    child.effect(() => {
      readCacheRetention = (route) => {
        const provider = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === route);
        if (provider === void 0) return null;
        let profile = child.settings.describe().find((entry) => entry.ns === provider.settingsNs)?.value;
        for (const key of provider.settingsPath) profile = profile?.[key];
        return profile?.cacheRetention ?? null;
      };
      return () => {
        readCacheRetention = () => null;
      };
    });
  });
  return { table };
}

// dsh/src/index.js
var name2 = "session-watcher";
var inject = HOST_INJECT;
function apply(ctx) {
  applyHost(ctx, {
    defineTool,
    storePath: defaultDbPath(),
    turnNotesRoot: DSH_TURN_NOTES_ROOT,
    loadIsIgnored,
    // The build copies `skills/` beside the bundle.
    skillsDir: fileURLToPath2(new URL("./skills/", import.meta.url))
  });
}
export {
  apply,
  inject,
  name2 as name
};
