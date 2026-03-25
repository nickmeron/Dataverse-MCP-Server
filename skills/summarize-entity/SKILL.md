---
description: Produce a business-readable summary of a Dynamics 365 record or set of records. Uses metadata to understand the schema before querying.
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__get_entity_details, mcp__dynamics365__get_entity_attributes, mcp__dynamics365__get_entity_relationships, mcp__dynamics365__get_picklist_options, mcp__dynamics365__get_record, mcp__dynamics365__query_records, mcp__dynamics365__execute_fetchxml
context: fork
---

The user wants a summary or report from Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Understand the schema** — before querying data, call `get_entity_attributes` and `get_entity_relationships` to know:
   - What fields exist and their types
   - Which fields are lookups (so you can `$expand` them for readable names)
   - What option sets mean (so you can translate integer values to labels)

3. **Determine the summary type**:
   - **Single record** → `get_record` with `$select` and `$expand` for related data
   - **Set of records / pipeline view** → `query_records` or `execute_fetchxml` for aggregates

4. **For account summaries**, fetch:
   - Account details (name, industry, revenue, owner) via `get_record`
   - Open opportunities via `query_records` on `opportunities` filtered by `_parentaccountid_value`
   - Open cases via `query_records` on `incidents` filtered by `_customerid_value`
   - Resolve `statecode` and `statuscode` labels via `get_picklist_options`

5. **For pipeline summaries**, use FetchXML:
```xml
<fetch aggregate="true">
  <entity name="opportunity">
    <attribute name="stepname" alias="stage" groupby="true"/>
    <attribute name="estimatedvalue" alias="total_value" aggregate="sum"/>
    <attribute name="opportunityid" alias="count" aggregate="count"/>
    <filter>
      <condition attribute="statecode" operator="eq" value="0"/>
    </filter>
  </entity>
</fetch>
```

6. **Present** as a clean business summary with tables and clear formatting — never raw JSON. Translate all integer option set values to their labels.
