---
description: Application Lifecycle Management for Dynamics 365 — export/import solutions between environments, publish customizations, manage environment variables, compare deployments. Use when asked "export solution", "import to UAT", "promote to prod", "manage env vars".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_solutions, mcp__dynamics365__get_solution_details, mcp__dynamics365__get_solution_components, mcp__dynamics365__get_solution_dependencies, mcp__dynamics365__export_solution, mcp__dynamics365__import_solution, mcp__dynamics365__publish_customizations, mcp__dynamics365__list_environment_variables, mcp__dynamics365__get_environment_variable, mcp__dynamics365__set_environment_variable
---

The user wants to perform ALM operations in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the task:**

### "Export solution X"
1. Check dependencies first: `get_solution_dependencies` to flag any missing components
2. `export_solution` with the unique name and managed flag
3. The response includes the base64-encoded zip file
4. Inform the user about file size and whether it's managed or unmanaged

### "Import solution"
1. `import_solution` with the base64-encoded zip
2. Options:
   - `overwrite_unmanaged`: true to overwrite existing unmanaged customizations
   - `publish_workflows`: true to activate workflows after import
3. After import, suggest running `publish_customizations`

### "Move solution from DEV to UAT"
This is a multi-step process across environments:
1. Select DEV environment → `export_solution` (unmanaged or managed)
2. Select UAT environment → `import_solution` with the exported base64
3. `publish_customizations` in UAT
4. Verify by `list_solutions` in UAT to check version

### "Compare solutions across environments"
1. Select first environment → `list_solutions` → note versions
2. Select second environment → `list_solutions` → note versions
3. Present a comparison table showing version differences
4. Highlight solutions that are out of sync

### "Publish all customizations"
- `publish_customizations` with `publish_all: true`
- This is needed after importing solutions, editing web resources, or modifying forms/views

### "Show environment variables" / "Change env var X"
- `list_environment_variables` to see all definitions and current values
- `get_environment_variable` for a specific one (shows current value, default, and source)
- `set_environment_variable` to update the value
  - If a value record exists, it updates it
  - If no value record exists, it creates one (overriding the default)

## Solution promotion workflow

For a typical DEV → INT → Test → UAT → Prod promotion:

1. In source env: Check dependencies → Export as **unmanaged** (for dev) or **managed** (for higher envs)
2. In target env: Import with `overwrite_unmanaged: true`
3. Publish all customizations
4. Update environment variables for the target environment
5. Verify solution version in target

## Important notes

- **Managed vs Unmanaged exports**: Managed solutions lock customizations in the target. Unmanaged allows further editing. Best practice: export as managed for INT/Test/UAT/Prod.
- Environment variables should be updated per-environment after import (different API keys, URLs, etc.)
- Large solution exports may take time — the API call is synchronous
- Always check dependencies before export to avoid import failures
