---
description: Create a new record in Dynamics 365. Uses metadata to validate fields, resolve option sets, and build correct lookup bindings.
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__get_entity_details, mcp__dynamics365__get_entity_attributes, mcp__dynamics365__get_entity_relationships, mcp__dynamics365__get_picklist_options, mcp__dynamics365__create_record, mcp__dynamics365__query_records, mcp__dynamics365__list_entities
---

The user wants to create a new record in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user which environment (this is especially important for creates — you must confirm the target). Call `select_environment`.

2. **Identify the entity** — use `list_entities` if needed to find the EntitySetName (plural name for the API).

3. **Discover the schema** — call `get_entity_attributes` to understand:
   - **Required fields** (RequiredLevel = ApplicationRequired or SystemRequired) — these MUST be provided
   - **Field types** — so you format values correctly
   - **Lookup fields** — these need `@odata.bind` syntax
   - **Option set fields** — need integer values, not labels

4. **Resolve lookups** — for any lookup field the user provides (e.g. "parent account = Contoso"):
   - Call `get_entity_relationships` (ManyToOne) to find what entity the lookup points to
   - Call `query_records` on that entity to find the GUID
   - Use format: `"fieldname@odata.bind": "/pluralentity(guid)"`

5. **Resolve option sets** — for any picklist field:
   - Call `get_picklist_options` to get the integer Value for the Label the user provided
   - Use the integer value in the record data

6. **Build and submit** — call `create_record` with the entity and data object.

7. **Confirm** — show the created record's ID and key details.

## Field value formats

| Type | Format | Example |
|---|---|---|
| String | plain string | `"name": "Contoso"` |
| Integer | number | `"numberofemployees": 500` |
| Decimal / Money | number | `"revenue": 1000000.00` |
| Boolean | true/false | `"donotphone": false` |
| DateTime | ISO 8601 | `"createdon": "2024-03-15T00:00:00Z"` |
| Lookup | @odata.bind | `"parentaccountid@odata.bind": "/accounts(guid)"` |
| Option Set | integer code | `"industrycode": 7` |

## Important

- **Always check required fields** against the actual metadata — missing a required field will cause a 400 error
- Custom entities may have custom required fields not in the standard D365 schema
- Exclude read-only system fields from the POST body: `createdon`, `modifiedon`, `createdby`, `modifiedby`, `versionnumber`, primary ID
- Virtual fields (`AttributeType = Virtual`) cannot be set directly
