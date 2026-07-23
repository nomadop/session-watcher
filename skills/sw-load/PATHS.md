# Path Resolution & Read Strategy

Each entry in `paths_to_keep` is `{path, lines?, symbols?}`.

## Resolution

- Absolute path (starts with `/`) → use as-is.
- Relative path → resolve against CWD. If missing, try `project_dir` from the API response. If neither exists, flag to user: "path not found — repo may have moved."
- Resolve against CWD or project_dir only — never the plugin/skill directory.

## Read strategy (cheapest first)

| Entry has | Action |
|-----------|--------|
| `lines` | `Read(file, offset=start, limit=end-start+1)` per range. If content looks stale (file edited since handoff), widen or fall back to `symbols`. |
| `symbols` only | Grep for the symbol name in the file, then Read surrounding context. |
| Neither | Previous session read the whole file — `Read` it fully. |
| Doc/backlog | Quick `Read` of the relevant section only. |

## Batching

**Issue ALL Read calls for kept paths in a single response** (parallel tool use). Every extra turn incurs a full cache_read of the accumulated context.

- Gather all paths, determine each path's read strategy.
- Emit all Read tool calls in one message.
- If more than ~10 calls, split into at most 2 batches.

## Edge cases

- File no longer exists or diverged significantly → flag to user, skip.
- `paths_to_keep` empty → ask user what they're working on, locate context manually.
