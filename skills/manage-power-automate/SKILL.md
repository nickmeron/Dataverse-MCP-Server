---
description: Create, read, update, delete, turn on/off, and debug Power Automate cloud flows in Dynamics 365 / Dataverse — list and inspect flows, find which flows fire on a table or reference a field, read run history and failures, author or edit flow definitions safely, manage connection references, cancel runaway runs. Use when asked "list flows", "show me flow X", "why did flow X fail", "which flows trigger on incident", "create a flow that…", "edit / turn off / delete this flow", "fix the connection on flow X", "stop this flow".
allowed-tools: mcp__dynamics365__auth_status, mcp__dynamics365__authenticate, mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_cloud_flows, mcp__dynamics365__get_cloud_flow, mcp__dynamics365__validate_cloud_flow, mcp__dynamics365__create_cloud_flow, mcp__dynamics365__update_cloud_flow, mcp__dynamics365__set_cloud_flow_state, mcp__dynamics365__delete_cloud_flow, mcp__dynamics365__list_cloud_flow_runs, mcp__dynamics365__cancel_cloud_flow_runs, mcp__dynamics365__list_connection_references, mcp__dynamics365__create_connection_reference, mcp__dynamics365__update_connection_reference, mcp__dynamics365__list_solutions, mcp__dynamics365__get_entity_details, mcp__dynamics365__get_entity_attributes
---

The user wants to work with Power Automate cloud flows in Dynamics 365.

**Argument provided:** $ARGUMENTS

These tools need the `dynamics365` MCP server v6.1.0+. They act as you (delegated `az login`), so
every write is attributed to you and limited by your Dataverse security roles.

## How flows live in Dataverse

```
workflow  (category = 5 "Modern Flow")         ← the flow; definition in `clientdata` (JSON string)
  ├─ clientdata.properties.definition          ← Logic Apps template: one trigger + actions
  ├─ clientdata.properties.connectionReferences
  │     "<connectionName key>" ──▶ connectionreference (logical name) ──▶ connection (connectionid)
  ├─ callbackregistration (name = workflowid)  ← exists only while a Dataverse-triggered flow is live
  └─ flowrun                                   ← run history (≈5 min lag, kept 28 days)
```

`modernflowtype`: 0 = Power Automate, 1 = Copilot Studio agent flow, 2 = M365 Copilot agent flow.
State: **Off** (statecode 0, Draft) / **On** (1, Activated) / Suspended (2).

## Golden rules — each one is a mistake reproduced against a live org

1. **Author in a development environment, never directly in production.** Production should only
   receive managed solutions. `update_cloud_flow` refuses managed flows (an edit there becomes an
   unmanaged layer that masks every future solution upgrade). Fix the source in development and
   redeploy. Turning a production flow on/off is an operational action, not authoring — it is
   allowed, but **always confirm with the user first**.
2. **Always create inside a solution** (`solution: "<unique name>"`). Without it the flow lands in the
   Default solution and never travels with ALM. Ask which solution if the user didn't say
   (`list_solutions` with unmanaged only).
3. **Off flows are not validated.** Dataverse stores whatever definition you give a Draft flow. Only
   turning it **on** runs the Flow service's template validation. So: `validate_cloud_flow` →
   `create_cloud_flow` (Off) → approval (rule 4) → `set_cloud_flow_state on`. If the user keeps it Off,
   tell them it is unvalidated and may be broken.
4. **Turning a flow on is a live change — get an explicit yes first.** From that moment it runs on
   real data with its connections' identity. Before any activation (`set_cloud_flow_state on` or
   `restart`, `activate: true`, `restart_flows: true`) show the user: the trigger (table, change type,
   and scope — scope 4 fires for every row in the org), what the actions create, update or delete,
   and which connections it runs as and whose they are. Never turn a flow on as a side effect of
   another fix, and never turn on a flow the user left Off.
5. **"On" is not "will fire".** A Dataverse trigger with bad parameters (classic: `filteringattributes`
   on an *Added*-only trigger) activates successfully and then never registers. The tools check the
   registration after every activation — **read `trigger_registration` and report `registered: false`
   as a failure**, never as success.
6. **Use connection references you own.** Activation with someone else's connection fails with
   *"Cannot find connection with name …"* — the connection exists, it just isn't shared with you.
   Pick one with `list_connection_references` (look for `owned_by_you: true`, `bound: true`).
7. **Table names differ by place.** The Dataverse **row trigger** takes the logical name (`incident`);
   every Dataverse **action** takes the entity set name (`incidents`). Activation checks neither;
   `validate_cloud_flow` does. Use `get_entity_details` for `EntitySetName`.
8. **Read before you write, and pass `expected_version`.** `get_cloud_flow` returns `version`; send it
   back on `update_cloud_flow` so a designer save in between is detected instead of overwritten.
9. **Updating an On flow is atomic and live.** A valid change deploys immediately (runs triggered after
   it use it); an invalid one is rejected and the old definition keeps running. Tell the user an
   edit to an On flow is a production change for that environment.
10. **A connection reference is shared — rebinding it changes every flow that uses it.** To fix one
    flow, re-point that flow (`update_cloud_flow connection_references`), not the reference. Rebind a
    reference only when the user asks for exactly that, after showing every dependent flow and the new
    connection (whose it is) and getting an explicit yes for the rebind **and** the restarts. Active
    flows keep their old connection until restarted, so an approved rebind still needs approved restarts.
11. **Deleting is permanent.** Prefer turning off. Delete only on explicit request, after showing the
    flow name/state. The tool refuses managed flows and flows other flows call as a child.
12. **Copilot Studio agent flows** (`modernflowtype` 1/2) belong to an agent — read them freely, but
    change them in Copilot Studio unless the user insists.

## Workflows

### "List flows" / "Find flow X"
`list_cloud_flows` with `name_contains`, `state`, `solution`, or `include_managed: false` (only the ones
authored here). Present: Name, State, Type, Managed, Owner, Modified.

### "Which flows run when an incident changes?" / "What touches field X?"
- Trigger-based: `list_cloud_flows` with `trigger_table: "incident"` — each result includes the change
  type, filtering attributes and filter expression.
- Reference-based (impact analysis): `list_cloud_flows` with `definition_contains: "<column / env var
  schema name / child-flow id / connector>"`.

### "Show me flow X" / "What does it do?"
`get_cloud_flow` (use `include_definition: false` first for big flows). Explain the trigger in plain
words, walk the action outline, flag any connection reference with `exists: false` / `bound: false`,
and any `trigger_registration.registered: false`. Give the `portal_url`.

### "Why did flow X fail?"
1. `list_cloud_flow_runs` with `flow_id`, `status: "Failed"`, and `since` — `counts_for_filter` shows the
   failure rate over the window.
2. Read `error.code` / `error.message`. `Terminated` with a custom code means the flow's own Terminate
   action fired (business logic), not a platform fault.
3. Per-action inputs/outputs aren't in Dataverse — give the run's `portal_url` for drill-down.
4. Runs appear ~5 minutes after they finish. "No runs" for something that just happened is not proof it
   didn't run — wait or check the portal.
5. A Dataverse-triggered flow that **never** runs: `get_cloud_flow` → `trigger_registration`.

### "Create a flow that …"
1. Confirm the environment (a development org) and the target **solution**.
2. Pick connection references: `list_connection_references connector: "commondataserviceforapps"` →
   one with `owned_by_you: true`. None suitable → `create_connection_reference` (in the solution; bind
   `connection_id` copied from a reference you own, or leave unbound and bind in the portal).
3. Draft the definition from the cookbook below. Use the exact `connectionName` keys you map.
4. `validate_cloud_flow` — fix every error. Treat warnings as questions for the user.
5. `create_cloud_flow` with `solution` and `connection_references` — **Off** (leave `activate` unset).
6. Show the user the rule-4 summary (trigger + scope, actions that write or delete, connections and
   whose they are, warnings) and the `portal_url`, and ask whether to turn it on.
7. Only on an explicit yes: `set_cloud_flow_state on`. Report `activation.ok` and
   `trigger_registration.registered`.

### "Change flow X"
1. `get_cloud_flow` → keep `version` and the `definition`.
2. Edit the definition JSON (the whole definition goes back — it is a replacement, not a patch).
3. `validate_cloud_flow`, then `update_cloud_flow` with `definition` and `expected_version`.
4. If it was On, the change is live; confirm `trigger_registration`. If Off, it stays Off — you may
   offer to turn it on to validate it (rule 4 applies). A `412`/version mismatch → re-read, re-apply, retry.

### "Turn flow X off / on / restart"
`set_cloud_flow_state`. The user asking to turn a flow on or restart it is their yes — still show the
rule-4 summary before doing it, and in production confirm any state change first. On failure, the result
carries `cause` + `fix` — relay those, not the raw Flow-service text.

### "Stop this flow now" (runaway / spamming)
1. `set_cloud_flow_state off` — stops new runs.
2. `cancel_cloud_flow_runs` — cancels in-flight ones.
Order matters: cancelling first leaves it free to start new runs.

### "Delete flow X"
Confirm with the user (name, state, solution). `delete_cloud_flow`. If it returns `FLOW_IN_USE`, show
the calling flows — don't pass `force` without the user's go-ahead.

### "Fix the connection on flow X"
1. `get_cloud_flow` → note its current **state**, and `connection_references` (which key, which
   reference, bound?, owner).
2. **Default — change only this flow:** `update_cloud_flow` with
   `connection_references: { "<key>": "<reference you own>" }`. That preserves its state: if it was
   On, the new binding deploys immediately; if it was Off, it stays Off. Turn it on only if the user
   asks (rule 4).
3. **Only if the user explicitly wants the shared reference rebound** (rule 10):
   `list_connection_references include_flows: true` → show every dependent flow (name, state) and the
   replacement connection → on an explicit yes, `update_connection_reference connection_id: …` →
   restart only the active flows the user approved: all of them with `restart_flows: true`, or each
   one with `set_cloud_flow_state restart`.

## Writing a definition

Read [`references/definition-cookbook.md`](references/definition-cookbook.md) before drafting or editing
one — trigger shapes (manual, recurrence, Dataverse row with the message/scope codes), Dataverse action
parameters per `operationId`, expression paths for trigger and action outputs, Try/Catch scopes and
child-flow calls. Pass only the `definition`; the tools add the boilerplate.

## Errors → real cause

| You see | Actually means |
|---|---|
| `Cannot find connection with name shared-…` | That connection isn't shared with you (or was deleted) |
| `…related connection references need connections created…` | A non-Dataverse reference is unbound |
| `…should not have the property 'authentication'` / `host.connectionReferenceName is missing` | An action's `connectionName` isn't a key in `connectionReferences` |
| `500 NullReferenceException` | `$authentication` parameter undeclared, or a malformed reference entry |
| `TemplateValidationError` | Template bug — the message names the action (runAfter target, expression) |
| `Failed to find connection references with logical name(s)` | The reference doesn't exist in this environment |
| `The version of the existing record doesn't match` | Someone saved the flow since your read — re-read |
| On, but `trigger_registration.registered: false` | Bad trigger params (see rule 5), wrong table name, or the connection's user lacks table privileges |

Unbound **Dataverse** references are the one exception to rule 6's corollary: they still activate and
run (as the flow owner, through `$authentication`). Bind them anyway before promoting.

## What these tools can't do (say so, and point to the portal)

- **Run a flow on demand** (manual/instant trigger) or **resubmit** a run — needs the Flow service API,
  which this MCP's sign-in has no consent for. For a Dataverse-triggered flow, make the qualifying row
  change instead.
- **Action-level run details** (inputs/outputs per step) — use the run's `portal_url`.
- **Share / add co-owners**, **desktop flows** (category 6), **classic workflows** (category 0) and
  **business process flows** — out of scope here.
- Validate **expression semantics** — `notAFunction()` saves fine and fails at run time. Static checks
  catch syntax and wiring, not logic.
