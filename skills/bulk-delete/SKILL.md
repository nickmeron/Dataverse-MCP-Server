---
description: Create, monitor, and manage bulk deletion jobs in Dynamics 365. Use when asked "bulk delete", "delete all records of type X", "create a bulk delete job", "check bulk delete status", "cancel bulk delete", "why did bulk delete fail".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__create_bulk_delete_job, mcp__dynamics365__list_bulk_delete_jobs, mcp__dynamics365__get_bulk_delete_job, mcp__dynamics365__cancel_bulk_delete_job, mcp__dynamics365__get_bulk_delete_failures, mcp__dynamics365__list_entities, mcp__dynamics365__get_entity_attributes
---

The user wants to create or manage bulk deletion jobs in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

### "Delete all records of entity X" / "Create a bulk delete job"

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Confirm scope** — ask the user to confirm the target entity and any filter conditions before creating the job. Bulk deletion is irreversible.

3. **Resolve the entity logical name** — if the user provides a display name (e.g. "Knowledge Article"), use `list_entities` to find the logical name (e.g. `knowledgearticle`).

4. **Build filter conditions (optional)** — if the user wants to delete a subset of records, map their criteria to QueryExpression conditions:
   - Each condition has: `attribute` (logical name), `operator`, and optionally `values`
   - Common operators: `Equal`, `NotEqual`, `Null`, `NotNull`, `Like`, `In`, `GreaterThan`, `LessThan`, `OlderThanXDays`
   - Example — delete only inactive records: `{ attribute: "statecode", operator: "Equal", values: ["1"] }`
   - If no filter is provided, ALL records of the entity will be deleted.

5. **Create the job** — call `create_bulk_delete_job`:
   ```
   job_name: descriptive name (e.g. "Delete all Knowledge Articles – 2026-05-04")
   entity: logical name (e.g. "knowledgearticle")
   filter_conditions: [...] or omit for all records
   ```
   Returns a `JobId` (asyncoperationid) — save this for monitoring.

6. **Confirm to the user** — report the `JobId` and explain they can monitor it with `get_bulk_delete_job`.

---

### "Check status of bulk delete job" / "Is the bulk delete done?"

Call `get_bulk_delete_job` with the `job_id`.

**Status interpretation:**

| statecode | statuscode | Meaning |
|-----------|------------|---------|
| 0 | 0 | Waiting for resources |
| 1 | 10 | Waiting |
| 2 | 20 | In progress |
| 2 | 21 | Pausing |
| 2 | 22 | Canceling |
| 3 | 30 | Succeeded |
| 3 | 32 | Cancelled |
| 3 | 33 | Failed |

- If **in progress** — report current state; tell user to check again shortly.
- If **succeeded** — report completion time; offer to check for any failures with `get_bulk_delete_failures`.
- If **failed** — call `get_bulk_delete_failures` to show which records could not be deleted and why.

---

### "List all bulk delete jobs" / "Show recent bulk deletes"

Call `list_bulk_delete_jobs`. Optional `status` filter: `waiting`, `running`, `completed`, `failed`, `cancelled`.

Present results as a table: Job Name | Status | Created | Completed | JobId.

---

### "Cancel the bulk delete job"

1. Call `get_bulk_delete_job` to confirm the job is still active (statecode 0, 1, or 2).
2. Warn the user that cancellation stops the job — already-deleted records are NOT restored.
3. Call `cancel_bulk_delete_job` with the `job_id`.

---

### "Why did some records fail to delete?"

Call `get_bulk_delete_failures` with the `job_id`. The response includes:
- `objectid` — the GUID of the record that failed
- `errordescription` — the reason for failure (e.g. cascading relationships, active child records)

Common failure reasons:
- **Relationship constraints** — child records still exist and the relationship is set to Restrict
- **Locked records** — record in use by another process
- **Security** — the service principal lacks delete privilege on the record

---

## Tips

- **Irreversible** — bulk delete permanently removes records. Always confirm with the user before creating a job.
- **Recurrence** — set `recurrence_pattern` to run the job on a schedule (e.g. daily cleanup). Leave empty for a one-time run.
- **Large datasets** — jobs run asynchronously; large tables may take minutes to hours. Poll with `get_bulk_delete_job`.
- **Failures are normal** — a job can succeed overall even if some records failed. Check `get_bulk_delete_failures` after completion.
