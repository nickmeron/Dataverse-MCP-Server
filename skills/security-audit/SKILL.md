---
description: Investigate users, security roles, teams, and permissions in Dynamics 365. Use when asked "who has access to...", "what roles does X have?", "compare roles", or "show me users".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__get_current_user, mcp__dynamics365__find_users, mcp__dynamics365__get_user_roles, mcp__dynamics365__get_user_teams, mcp__dynamics365__get_user_queues, mcp__dynamics365__list_security_roles, mcp__dynamics365__get_role_privileges, mcp__dynamics365__compare_role_privileges, mcp__dynamics365__assign_security_role, mcp__dynamics365__remove_security_role
---

The user has a question about users, security, or permissions in Dynamics 365.

**Argument provided:** $ARGUMENTS

## Process

1. **Select environment** — call `list_environments`, ask the user, call `select_environment`.

2. **Determine the investigation type:**

### "Who is this user?" / "Show me user X"
- Call `find_users` with the name/email
- For each user found, fetch their roles, teams, and queues in parallel:
  - `get_user_roles` → what security roles they have
  - `get_user_teams` → what teams they belong to
  - `get_user_queues` → what queues they own
- Present a clear profile of the user

### "What roles exist?" / "Find role X"
- Call `list_security_roles` (with optional filter)
- Present as a list with role name, managed/unmanaged status

### "What can role X do?" / "Show privileges for role X"
- First `list_security_roles` to find the role GUID
- Then `get_role_privileges` for that role
- Group privileges by entity name and operation (Create, Read, Write, Delete, Append, etc.)
- Present as a readable permission matrix

### "Compare role X vs role Y"
- Find both role GUIDs via `list_security_roles`
- Call `compare_role_privileges` with both IDs
- Present clearly:
  - Privileges only in Role 1
  - Privileges only in Role 2
  - How many shared
  - Highlight the most significant differences

### "Who am I?" / "Test the connection"
- Call `get_current_user` (WhoAmI)
- Show the service principal details and business unit

## Presentation tips

- Security roles: group by the entity they apply to (strip the `prv` prefix)
- Privilege names follow the pattern: `prvCreate{Entity}`, `prvRead{Entity}`, `prvWrite{Entity}`, `prvDelete{Entity}`, `prvAppend{Entity}`, `prvAppendTo{Entity}`, `prvAssign{Entity}`, `prvShare{Entity}`
- When comparing roles, highlight differences in a table format
- Always note whether a role is managed (from a solution) or unmanaged (custom)
