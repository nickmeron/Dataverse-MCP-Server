---
description: Deep-dive into the metadata of a Dynamics 365 entity — fields, types, option sets, relationships, keys. Use this when the user wants to understand an entity's structure or says "show me the fields on...", "what does the X entity look like?", "explore the metadata".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_entities, mcp__dynamics365__get_entity_details, mcp__dynamics365__get_entity_attributes, mcp__dynamics365__get_entity_relationships, mcp__dynamics365__get_entity_keys, mcp__dynamics365__get_picklist_options, mcp__dynamics365__get_global_option_sets, mcp__dynamics365__get_global_option_set_details
---

The user wants to explore or understand the metadata structure of their Dynamics 365 environment.

**Argument provided:** $ARGUMENTS

## Process

### 1. Select environment
Call `list_environments` and ask the user which environment to explore. Call `select_environment`.

### 2. Identify what to explore

- If the user names a specific entity → proceed to deep-dive
- If the user is unsure → use `list_entities` (optionally with `custom_only: true`) to show what's available
- If searching by keyword → use `list_entities` with a filter

### 3. Deep-dive: Entity overview

For the target entity, gather all metadata in parallel where possible:

1. **`get_entity_details`** → basic info (display name, logical name, primary ID/name, system vs custom)
2. **`get_entity_attributes`** (with `include_option_sets: true`) → all fields with their types and option set values
3. **`get_entity_relationships`** → all One-to-Many, Many-to-One, Many-to-Many relationships
4. **`get_entity_keys`** → alternate keys

### 4. Present the metadata

Format the output clearly — think of it like the tabs in the metadata viewer app:

#### Entity Summary
- Display Name, Logical Name, Entity Set Name (plural for API), Object Type Code
- System vs Custom
- Primary ID field, Primary Name field

#### Fields
Present as a table:
| Logical Name | Display Name | Type | Required | Custom |
|---|---|---|---|---|
Sort by logical name. Highlight:
- **Required fields** (RequiredLevel = ApplicationRequired or SystemRequired)
- **Custom fields** (IsCustomAttribute = true)
- **Lookup fields** — note what entity they point to (from relationships)

#### Option Sets
For every Picklist / Status / State field, show the values:
| Value | Label |
|---|---|
Group by field name.

#### Relationships
Show separately:
- **One-to-Many**: This entity → related entity (field)
- **Many-to-One**: Related entity → this entity (field)
- **Many-to-Many**: Entity1 ↔ Entity2 (schema name)

#### Alternate Keys
If any exist, list the key name and which fields compose it.

### 5. Offer next steps

After presenting, ask if the user wants to:
- Explore a specific field's option set values in more detail
- See the relationships for a related entity
- Build a query against this entity
- Check official docs about this entity type

## Tips

- Custom entities typically have a publisher prefix (e.g. `new_`, `contoso_`)
- The `EntitySetName` is the plural name used in API URLs — this is what `query_records` needs
- Look for `_value` suffix fields — these are the raw GUID values of lookup fields
- `statecode` (State) and `statuscode` (Status Reason) exist on every entity — always show their option values
