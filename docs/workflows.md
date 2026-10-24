# Workflow definitions

[README](../README.md) · [Commands](commands.md) · [JSON](json.md)

`rabi workflow list`, `show NAME`, and `check [NAME]` inspect definitions without running steps, check commands, or agent tools. They need no trust. Run commands are not public.

The built-in `default` is embedded from [default.yaml](../src/workflow/default.yaml). Repository definitions are `.rabi/workflows/<name>.yaml` in the invoking checkout, or the selected primary checkout with `-R/--repo`. Selection uses the filename stem; the embedded `name` need not match it. A repository `default.yaml` cannot shadow the built-in and is an invalid item in an all-definition check. Listing includes definitions even when their contents are invalid.

```sh
rabi workflow list
rabi workflow show default --json
rabi workflow check
rabi -R owner/repo workflow check default --json
```

A definition has `schema_version: 1`, `name`, numeric `version`, `workspace: new`, `start`, required `limits: {max_steps: N}`, optional `loops: {name: N}`, and a `steps` map. The optional top-level `agent` supplies a provider (`codex`, `claude`, or `cursor`) and optional model/effort. Agent steps can override those fields individually; omitted model/effort inherit the workflow defaults, including when the provider changes. An agent step must resolve a provider. Model and effort strings are passed through without tool-specific validation.

```yaml
schema_version: 1
name: verify
version: 1
workspace: new
start: check
limits: {max_steps: 1}
steps:
  check:
    type: check
    commands: ["cargo test --locked"]
    on: {pass: succeeded, fail: stopped}
```

Step types:

- `agent`: `mode: edit|read-only`, `output: report-v1|review-v1`, `instruction`, optional `agent` overrides, and optional `context`. Context defaults to `fresh`, or uses `{continue: STEP}`.
- `check`: `commands: cli` or a list of command strings. CLI command binding is deferred to execution.
- `system`: `action: prepare|push|draft-pr`.

Every step accepts `allow_dirty: true|false`, default false. Show includes it in `definition.steps[ID].allow_dirty`, a `steps[ID].allowDirty` summary, and the text step summary. A future runner will treat a step ending with uncommitted non-ignored Git changes as an error unless allow_dirty is true; this PR only parses and displays the field.

Every step has an `on` map. Its keys are `ok` for ordinary agent/system steps, `pass`/`revise` for review-v1, or `pass`/`fail` for checks. Each value names a step or the terminal `succeeded`/`stopped`, or is `{to: STEP, loop: NAME}`. Unspecified results are not inferred as success.

Validation checks YAML syntax/types, schema version, an existing start step, existing transition targets, valid result keys, positive max_steps/loop limits, defined loop references, and absence of cycles after loop edges are removed. Review-v1 requires fresh context. Continue targets must exist, be agent steps, and resolve to the same provider; their model and effort can differ. Read-only agent steps require a resolved provider with read-only enforcement capability: Codex is supported, Cursor is unsupported, and Claude is unverified and therefore unsupported. Step-level provider overrides are resolved before checking this capability. Validation imposes no reachability requirement, name regex, filename/name match, fixed step cap, or execution timeout.

`check` without NAME reports the built-in and every repository file. Invalid definitions exit 2 (`usage`), keeping all JSON items and diagnostics. `show` returns diagnostics for invalid definitions in `error.details.diagnostics`. Unknown names exit 3 (`not_found`). Diagnostics include a message, an available step path, and nullable one-based YAML line/column values.

`rabi trust add` displays repository workflow names and paths together with hooks. Workflow agent steps and check commands, including built-in workflows, use that same Git common-directory trust. No per-workflow approval or new trust store is added. Trust records do not validate definitions or enable execution through these inspection commands.

Internal run storage is shared through the Git common directory. A new run saves its manifest and copies of task.md/workflow.yaml, then stores attempts in distinct `steps/NNN-<step>/result.json` directories. Numbers are run-wide and monotonically increase; revisiting a step allocates a new number. Step IDs with path separators are encoded for directory names without restricting YAML names. Progress updates use the shared atomic writer; HEAD values are observations supplied by the future runner. Worklogs, PR body files, process logs, and execution are deferred.
