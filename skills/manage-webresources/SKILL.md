---
description: Manage web resources in Dynamics 365 — view, create, edit, and publish JavaScript, HTML, CSS, and other web resources. Use when asked "show me web resources", "edit this JS file", "create a new script", "download webresource".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_web_resources, mcp__dynamics365__get_web_resource, mcp__dynamics365__update_web_resource, mcp__dynamics365__create_web_resource, mcp__dynamics365__publish_customizations
---

The user wants to work with web resources in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the task:**

### "What web resources exist?" / "Find script X"
- Call `list_web_resources` with optional filter and type
- Type codes: 1=HTML, 2=CSS, 3=JS, 4=XML, 5=PNG, 6=JPG, 7=GIF, 9=XSL, 10=ICO, 11=SVG, 12=RESX
- Present as a table with: Name, Type, Managed/Unmanaged, Last Modified

### "Show me the code in web resource X"
- Call `get_web_resource` — for text types (JS/HTML/CSS/XML), the content is automatically decoded from base64
- Present the decoded content with syntax highlighting
- Note whether it's managed (read-only) or unmanaged (editable)

### "Edit/refactor this web resource"
1. `get_web_resource` to retrieve current content
2. Apply the requested changes to the decoded content
3. `update_web_resource` with the modified content (auto-encoded to base64)
4. `publish_customizations` to make changes live
- ⚠️ Always show the diff or summary of changes before publishing

### "Create a new web resource"
1. `create_web_resource` with:
   - `name`: must include publisher prefix (e.g. "new_/scripts/utility.js")
   - `type`: the web resource type code
   - `content`: the actual content
   - `display_name`: human-readable name
   - `solution_unique_name`: optionally add to a solution
2. `publish_customizations` to make it available

### "Publish customizations"
- `publish_customizations` with `publish_all: true` for all, or provide specific component XML

## Important notes

- Managed web resources cannot be edited — the API will reject updates
- Always publish after creating or updating web resources
- For binary types (PNG, JPG, etc.), content stays as base64
- Web resource names must follow the format: `prefix_/path/filename.ext`
