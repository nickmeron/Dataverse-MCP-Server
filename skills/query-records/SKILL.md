---
description: Query Dynamics 365 records using natural language. Translates questions into OData queries with metadata-aware field selection.
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__query_records, mcp__dynamics365__get_entity_details, mcp__dynamics365__get_entity_attributes, mcp__dynamics365__get_entity_relationships, mcp__dynamics365__list_entities, mcp__dynamics365__get_picklist_options
---

The user wants to query data from Dynamics 365. Your job is to translate their natural language request into an effective OData query — using actual metadata from their environment to get the field names right.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Identify the entity** — if the name is ambiguous, call `list_entities` to find the correct one. Remember: `query_records` needs the **EntitySetName** (plural, e.g. `accounts`), not the LogicalName.

3. **Discover the schema** — call `get_entity_attributes` on the entity to see the actual field names, types, and which are required. This is critical — don't guess field names.

4. **For picklist filters** — if the user says something like "active accounts" or "open opportunities", call `get_picklist_options` for the relevant status field (e.g. `statecode`, `statuscode`) to get the correct integer values for filtering.

5. **Build the OData query** using the real field names:
   - `$select` — only the fields you need (use LogicalName from metadata)
   - `$filter` — conditions using correct field names and types
   - `$orderby` — sorting
   - `$top` — limit (default 20 unless user specifies)
   - `$expand` — for lookups, use the navigation property name from relationships

6. **Call `query_records`** and present results in a clean, readable table — NOT raw JSON.

## Common entities

| User says | EntitySetName | LogicalName |
|---|---|---|
| accounts / companies | `accounts` | `account` |
| contacts / people | `contacts` | `contact` |
| leads | `leads` | `lead` |
| opportunities / deals | `opportunities` | `opportunity` |
| cases / tickets | `incidents` | `incident` |
| orders | `salesorders` | `salesorder` |
| invoices | `invoices` | `invoice` |
| products | `products` | `product` |
| activities / tasks | `activitypointers` | `activitypointer` |
| emails | `emails` | `email` |

## OData filter patterns

- Active records: `statecode eq 0`
- By name: `contains(name,'Contoso')` or `name eq 'Contoso'`
- Date range: `createdon ge 2024-01-01T00:00:00Z`
- Null check: `emailaddress1 ne null`
- Lookup: `_parentaccountid_value eq {guid}`
- Option set: look up the integer value first via `get_picklist_options`

## Important

- **Always check metadata first** — don't assume field names. Custom fields differ per environment.
- String values in filters use single quotes: `name eq 'Contoso'`
- Lookup fields in `$filter` use the `_fieldname_value` format
- Lookup fields in `$expand` use the navigation property name (from relationships)
