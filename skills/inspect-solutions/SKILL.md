---
description: Explore and inspect Dynamics 365 solutions — what's deployed, solution components, publishers, versions, and dependencies. Use when asked "what solutions are installed?", "what's in solution X?", "show me customizations".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_solutions, mcp__dynamics365__get_solution_details, mcp__dynamics365__get_solution_components, mcp__dynamics365__get_solution_dependencies, mcp__dynamics365__list_entities, mcp__dynamics365__export_solution, mcp__dynamics365__import_solution, mcp__dynamics365__publish_customizations
---

The user wants to understand what's deployed in their Dynamics 365 environment at the solution level.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the question type:**

### "What solutions are installed?"
- Call `list_solutions` (optionally with `unmanaged_only: true` to see only custom solutions)
- Present a table with: Display Name, Unique Name, Version, Publisher, Managed/Unmanaged, Install Date
- Group by publisher if there are many solutions
- Highlight unmanaged solutions — these are the customization layer

### "What's in solution X?"
- Call `get_solution_details` to get the solution GUID and publisher info
- Call `get_solution_components` to list all components
- Translate component type codes to readable names and group by type:

| Code | Type |
|---|---|
| 1 | Entity |
| 2 | Attribute (Field) |
| 3 | Relationship |
| 9 | Option Set |
| 10 | Entity Relationship |
| 20 | Security Role |
| 24 | Form |
| 25 | Organization Settings |
| 26 | View (SavedQuery) |
| 29 | Workflow / Action |
| 59 | Chart |
| 60 | System Form |
| 61 | Web Resource |
| 62 | Sitemap |
| 63 | Connection Role |
| 65 | Plugin Assembly (SDK Message Processing Step Registration) |
| 70 | Field Security Profile |
| 91 | Plugin Assembly |
| 92 | Plugin Type (Step) |
| 150 | Routing Rule |
| 154 | SLA |
| 300 | Canvas App |
| 371 | Connector |

- For entity components (type 1), cross-reference with `list_entities` to show the entity display names

### "What does solution X depend on?"
- Call `get_solution_dependencies` to see missing or required dependencies
- Flag any missing dependencies — these could block solution import/export

### "Compare what's deployed across environments"
- Guide the user to select each environment in turn
- List the solutions in each and compare versions

## Presentation tips

- Always show publisher prefix — it tells you who created the customization
- Flag version differences if the user is comparing environments
- Group components logically: Entities first, then Fields, then Views, Forms, Workflows, Web Resources
- Highlight any unmanaged customizations on top of managed solutions — these are "active layer" changes
