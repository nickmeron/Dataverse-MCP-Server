---
description: Manage Power Platform CLI (pac) authentication profiles — create, list, switch, and delete auth connections to Dynamics 365 environments. Use when asked "connect pac to environment", "switch pac environment", "authenticate pac CLI".
---

The user wants to manage PAC CLI authentication.

**Argument provided:** $ARGUMENTS

## Prerequisites — Install PAC CLI

**Step 1 — Check if pac is already installed:**
```bash
pac help || ~/.dotnet/tools/pac help
```
If either prints the command list, skip to the Workflows section. If only the second worked, pac is installed but `~/.dotnet/tools` is missing from PATH — add `export PATH="$HOME/.dotnet/tools:$PATH"` to `~/.zshrc` (or `~/.bashrc`) so future sessions resolve `pac` directly.

**Step 2 — Install pac (if not found):**

**macOS / Linux:**
```bash
# Requires .NET 9+
dotnet --version
# If dotnet is not installed: brew install dotnet

# PAC CLI 2.x has a broken NuGet package on macOS — use 1.52.1
dotnet tool install --global Microsoft.PowerApps.CLI.Tool --version 1.52.1
```

**Windows:**
```bash
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```
Or use the standalone MSI installer: https://aka.ms/PowerAppsCLI

## Workflows

### "Authenticate to an environment"

**Preferred — reuse MCP credentials:** If the user already authenticated via the MCP `authenticate` tool, reuse those same credentials so they don't have to enter them again:
```bash
pac auth create \
  --name MCP \
  --url ACTIVE_ENVIRONMENT_URL \
  --applicationId MCP_CLIENT_ID \
  --clientSecret "MCP_CLIENT_SECRET" \
  --tenant MCP_TENANT_ID
```
Replace the values with the credentials from the MCP `authenticate` call. To get the active environment URL, use the MCP `auth_status` tool.

**Interactive (browser-based):**
```bash
pac auth create --url https://yourorg.crm.dynamics.com
```
Opens a browser for Azure AD login. Best for human users.

**Service principal (non-interactive, for CI/CD and automation):**
```bash
pac auth create \
  --url https://yourorg.crm.dynamics.com \
  --applicationId YOUR_CLIENT_ID \
  --clientSecret "YOUR_SECRET" \
  --tenant YOUR_TENANT_ID
```

**With certificate:**
```bash
pac auth create \
  --url https://yourorg.crm.dynamics.com \
  --applicationId YOUR_CLIENT_ID \
  --certificateThumbprint ABC123DEF456 \
  --tenant YOUR_TENANT_ID
```

### "Set up multiple environments"

Create an auth profile for each environment. Use environment variables to avoid exposing secrets:
```bash
# Set credentials once
export CLIENT_ID="your-client-id"
export SECRET="your-client-secret"
export TENANT_ID="your-tenant-id"

# Create profiles for each environment
pac auth create --name DEV  --url https://yourorg-dev.crm.dynamics.com  --applicationId $CLIENT_ID --clientSecret $SECRET --tenant $TENANT_ID
pac auth create --name TEST --url https://yourorg-test.crm.dynamics.com --applicationId $CLIENT_ID --clientSecret $SECRET --tenant $TENANT_ID
pac auth create --name UAT  --url https://yourorg-uat.crm.dynamics.com  --applicationId $CLIENT_ID --clientSecret $SECRET --tenant $TENANT_ID
pac auth create --name PROD --url https://yourorg-prod.crm.dynamics.com --applicationId $CLIENT_ID --clientSecret $SECRET --tenant $TENANT_ID
```

### "List auth profiles"
```bash
pac auth list
```
Shows all profiles with index, name, environment URL, and active status.

### "Switch environment"
```bash
pac auth select --index 2
# or
pac auth select --name TEST
```

### "Delete an auth profile"
```bash
pac auth delete --index 3
```

### "Clear all auth profiles"
```bash
pac auth clear
```

### "Check who I'm connected as"
```bash
pac auth who
```

## CI/CD authentication

In GitHub Actions or Azure DevOps, always use service principal auth with secrets:
```yaml
- name: PAC Auth
  run: |
    pac auth create \
      --url ${{ secrets.D365_URL }} \
      --applicationId ${{ secrets.CLIENT_ID }} \
      --clientSecret ${{ secrets.CLIENT_SECRET }} \
      --tenant ${{ secrets.TENANT_ID }}
```

## Troubleshooting

- **"pac: command not found"** → First try `~/.dotnet/tools/pac help`. If that works, pac is installed but `~/.dotnet/tools` is missing from PATH — add `export PATH="$HOME/.dotnet/tools:$PATH"` to `~/.zshrc` (or `~/.bashrc`). Otherwise see install steps; macOS requires `--version 1.52.1`.
- **"DotnetToolSettings.xml not found"** → You're installing PAC 2.x on macOS. Use `--version 1.52.1` instead.
- **"Login failed"** → Check that the app registration has Dynamics CRM permissions and admin consent
- **"Unauthorized"** → Verify the service principal has a security role in the target environment
- **Multiple profiles conflict** → Use `pac auth select` to explicitly choose before running commands
- **Token expired** → Delete and recreate the profile: `pac auth delete --index N && pac auth create ...`
