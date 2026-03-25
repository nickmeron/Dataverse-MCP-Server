---
description: Manage plugin registrations in Dynamics 365 — browse assemblies, register/update/delete processing steps, manage pre/post images, enable/disable steps. Use when asked "register a step", "show me plugin steps", "disable step X", "add a pre-image".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__list_plugin_assemblies, mcp__dynamics365__get_plugin_assembly_details, mcp__dynamics365__list_plugin_types, mcp__dynamics365__list_sdk_messages, mcp__dynamics365__list_sdk_message_filters, mcp__dynamics365__list_processing_steps, mcp__dynamics365__get_processing_step_details, mcp__dynamics365__register_processing_step, mcp__dynamics365__update_processing_step, mcp__dynamics365__toggle_processing_step, mcp__dynamics365__delete_processing_step, mcp__dynamics365__list_step_images, mcp__dynamics365__register_step_image, mcp__dynamics365__update_step_image, mcp__dynamics365__delete_step_image, mcp__dynamics365__get_org_settings, mcp__dynamics365__set_plugin_trace_setting
---

The user wants to manage plugin registrations in their Dynamics 365 environment.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the task:**

### "What plugins are deployed?" / "Show assemblies"
- Call `list_plugin_assemblies` (custom_only defaults to true — excludes Microsoft/System assemblies)
- For each assembly, show: name, version, isolation mode, source type
- To drill into an assembly: `get_plugin_assembly_details` returns all plugin types (classes) inside it

### "Show steps for plugin X" / "What's registered?"
- Call `list_processing_steps` filtered by assembly name or plugin type ID
- Present a table with: Step Name, Message, Entity, Stage, Mode, Rank, Status (Enabled/Disabled)
- Translate stage codes: 10=PreValidation, 20=PreOperation, 40=PostOperation
- Translate mode: 0=Synchronous, 1=Asynchronous

### "Register a new step"
This is a multi-step process. Gather all required IDs first:

1. **Find the plugin type** — `list_plugin_types` to get the `plugintypeid`
2. **Find the SDK message** — `list_sdk_messages` with filter (e.g. "Create") to get the `sdkmessageid`
3. **Find the message filter** — `list_sdk_message_filters` with the message name + entity to get `sdkmessagefilterid`
4. **Register the step** — `register_processing_step` with:
   - `name`: descriptive name (e.g. "MyPlugin: PreOperation Create of account")
   - `plugin_type_id`: from step 1
   - `sdk_message_id`: from step 2
   - `sdk_message_filter_id`: from step 3
   - `stage`: 10 (PreValidation), 20 (PreOperation), or 40 (PostOperation)
   - `mode`: 0 (Sync) or 1 (Async)
   - Optional: `filtering_attributes` (comma-separated, for Update triggers)
   - Optional: `configuration` (unsecure config string)
   - Optional: `impersonating_user_id` (for running as a specific user)

### "Update step X"
- `update_processing_step` — supply only the fields to change

### "Enable/disable step X"
- `toggle_processing_step` with `enable: true` or `enable: false`

### "Delete step X"
- ⚠️ Confirm with the user before deleting — this is irreversible
- `delete_processing_step`

### "Add a pre/post image to step X"
1. Get the step ID (from `list_processing_steps` or ask user)
2. `register_step_image` with:
   - `step_id`: the processing step GUID
   - `name`: e.g. "PreImage" or "PostImage"
   - `entity_alias`: how the plugin accesses it in code (e.g. "PreImage")
   - `image_type`: 0=PreImage, 1=PostImage, 2=Both
   - `attributes`: comma-separated field names to capture (empty = all)
   - `message_property_name`: "Target" for Create/Update, "Id" for Delete

#### Image availability rules:
| Message | PreImage | PostImage |
|---------|----------|-----------|
| Create  | ❌ No    | ✅ Yes (Post-Op only) |
| Update  | ✅ Yes   | ✅ Yes (Post-Op only) |
| Delete  | ✅ Yes   | ❌ No    |

### "Show images on step X"
- `list_step_images` with the step ID

### "Turn on/off plugin trace logs"
- `get_org_settings` to see current trace level
- `set_plugin_trace_setting` with level: 0=Off, 1=Exception, 2=All
- ⚠️ Level 2 (All) generates a lot of data — suggest turning it off after debugging

## Presentation tips

- Always show the full pipeline path: Assembly → Plugin Type → Step → Images
- Group steps by assembly when showing all registrations
- Highlight disabled steps so the user knows what's inactive
- When registering steps, confirm all the parameters before calling the API
- For async steps, mention that `asyncautodelete: true` can be set to auto-clean completed jobs
