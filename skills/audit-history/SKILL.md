---
description: Query audit history in Dynamics 365 — find who changed what, when, and what the old/new values were. Check if auditing is enabled on entities and individual fields. Use when asked "who changed this record", "show audit log", "is auditing enabled", "what changed on account X".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__get_audit_history, mcp__dynamics365__get_entity_audit_status, mcp__dynamics365__get_field_audit_status, mcp__dynamics365__get_org_audit_status, mcp__dynamics365__query_records, mcp__dynamics365__find_users, mcp__dynamics365__list_entities, mcp__dynamics365__get_entity_attributes
---

The user wants to investigate audit history or audit configuration in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the task:**

### "Who changed this record?" / "Show audit history for record X"

1. First, find the record if the user gave a name instead of a GUID:
   - `query_records` to search for the record by name or other fields
2. Then get the audit history:
   - `get_audit_history` with `record_id` and `entity_logical_name`
   - Optionally filter by `hours_back`, `action`, `user_id`, `attribute_filter`
3. Present results as a timeline:
   - **When** (createdon)
   - **Who** (_userid_value — resolve to a name with `find_users` if needed)
   - **Action** (Create/Update/Delete)
   - **What changed** (from the audit detail: old values → new values)

### "What changed on field X of this record?"

Use `get_audit_history` with `attribute_filter` set to the specific field names:
```
get_audit_history(
  record_id: "guid",
  entity_logical_name: "account",
  attribute_filter: "telephone1,emailaddress1"
)
```
This returns only audit entries where those specific fields were modified.

### "Who made changes in the last 24 hours?"

Use `get_audit_history` with `hours_back`:
```
get_audit_history(
  entity_logical_name: "account",
  hours_back: 24
)
```
Can combine with `user_id` to see one person's changes, or `action: 3` to see only deletions.

### "Is auditing enabled on entity X?"

Three levels to check:

1. **Organization level** — `get_org_audit_status`
   - If org-level auditing is OFF, nothing is captured regardless of entity/field settings
   - Also shows audit retention period and user access audit status

2. **Entity level** — `get_entity_audit_status` with the entity logical name
   - Returns whether `IsAuditEnabled` is true/false on the entity

3. **Field level** — `get_field_audit_status` with the entity and optionally specific fields
   - Returns each field's `IsAuditEnabled` flag
   - Shows count of audited vs non-audited fields

**Present all three levels together** so the user gets the complete picture:
```
Organization auditing: ✅ Enabled (retention: 30 days)
Entity 'account' auditing: ✅ Enabled
Field auditing:
  - name: ✅ Audited
  - telephone1: ✅ Audited
  - emailaddress1: ❌ NOT Audited
  - revenue: ✅ Audited
```

### "Show me all deletions in the last week"

```
get_audit_history(
  action: 3,           # Delete
  hours_back: 168      # 7 days
)
```

### "What did user X change recently?"

1. Find the user: `find_users` with their name
2. `get_audit_history` with `user_id` and optional `hours_back`

## Action codes reference

| Code | Action |
|------|--------|
| 1 | Create |
| 2 | Update |
| 3 | Delete |
| 4 | Activate |
| 5 | Deactivate |
| 11 | Cascade |
| 12 | Upsert |
| 13 | Merge |

## Audit detail structure

When `get_audit_history` retrieves details for a specific record, each entry includes:
- `audit_detail.NewValue.Attributes` — the new values after the change
- `audit_detail.OldValue.Attributes` — the old values before the change
- The attribute key names in these objects are the logical field names

## Important notes

- Audit records are **read-only** — they cannot be modified or deleted through the API
- Audit must be enabled at **three levels**: Organization → Entity → Field
- The `audits` entity has a **retention policy** — old records are purged after the configured period
- Large queries can be slow — always use `top` and `hours_back` to limit scope
- The `RetrieveAuditDetails` function is called per-record for the full change detail, so fetching many records with details can be slow. The tool automatically limits detail enrichment to the first 20 records.
- To resolve `_userid_value` GUIDs to human names, use `find_users` or `query_records` on `systemusers`
