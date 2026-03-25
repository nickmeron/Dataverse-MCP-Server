---
description: Set up and manage Dataverse Managed Identities for plugin assemblies — create UAMIs, compute federated credentials, register managed identity records in Dataverse, associate assemblies, and configure CI/CD signing. Use when asked "set up managed identity", "configure plugin managed identity", "connect plugin to Key Vault", "federated credential", "sign plugin assembly".
allowed-tools: mcp__dynamics365__list_environments, mcp__dynamics365__select_environment, mcp__dynamics365__query_records, mcp__dynamics365__get_record, mcp__dynamics365__create_record, mcp__dynamics365__update_record, mcp__dynamics365__list_plugin_assemblies, mcp__dynamics365__get_plugin_assembly_details, mcp__dynamics365__get_org_settings, mcp__dynamics365__execute_batch, mcp__dynamics365__list_managed_identities, mcp__dynamics365__create_managed_identity, mcp__dynamics365__associate_assembly_managed_identity, mcp__dynamics365__compute_federated_credential_subject
---

The user wants to set up or manage Dataverse Managed Identities for plugin assemblies to securely access Azure resources (Key Vault, Storage, APIs, etc.) without storing credentials.

**Argument provided:** $ARGUMENTS

## Overview

Managed Identity allows Dataverse plugins to acquire Azure AD tokens for Azure resources (Key Vault, Azure SQL, Storage, custom APIs) without embedding secrets. It uses User-Assigned Managed Identities (UAMI) with Federated Identity Credentials.

**Architecture:**
```
Plugin Code → IManagedIdentityService.AcquireToken() → Azure AD → Federated Credential → UAMI → Azure Resource
```

## Full Setup Process

### Step 1: Gather Information

Collect from the user:
- **Tenant ID** — Azure AD tenant GUID
- **Environment details** — For each environment: name, URL, Dataverse environment ID
- **Target Azure resource** — What the plugin needs to access (Key Vault, Storage, etc.)
- **Plugin assembly name** — Which assembly gets the managed identity

To get the Dataverse environment ID, use:
```
get_org_settings → the organizationid value
```
Or the user can find it in Power Platform Admin Center → Environments → Environment Details.

### Step 2: Create User-Assigned Managed Identities (Azure)

One UAMI per environment (or shared if acceptable). Guide the user through Azure CLI or Portal:

```bash
# Create UAMI for each environment
az identity create --name "mi-dataverse-dev" --resource-group "rg-dataverse" --location "westeurope"
az identity create --name "mi-dataverse-int" --resource-group "rg-dataverse" --location "westeurope"
az identity create --name "mi-dataverse-test" --resource-group "rg-dataverse" --location "westeurope"
az identity create --name "mi-dataverse-uat" --resource-group "rg-dataverse" --location "westeurope"
az identity create --name "mi-dataverse-prod" --resource-group "rg-dataverse" --location "westeurope"
```

Save each UAMI's **Client ID** (Application ID) from the output.

### Step 3: Generate Certificate for Assembly Signing

**⚠️ CRITICAL**: The plugin assembly must be signed with a certificate. The certificate's SHA-256 hash is used in the federated credential subject.

```powershell
# PowerShell — Generate self-signed certificate
$cert = New-SelfSignedCertificate `
  -Subject "CN=DataversePluginSigning" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyExportPolicy Exportable `
  -KeySpec Signature `
  -KeyLength 2048 `
  -KeyAlgorithm RSA `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(5)

# Export as PFX (with private key)
$password = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath ".\plugin-signing.pfx" -Password $password

# Get the SHA-256 hash (hex format — CRITICAL: must be hex, not base64url)
$hash = $cert.GetCertHash("SHA256")
$hexHash = ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
Write-Host "Certificate SHA-256 Hex Hash: $hexHash"
```

### Step 4: Compute Federated Credential Subjects

Use the `compute_federated_credential_subject` MCP tool for each environment. The subject format is:

```
/eid1/c/pub/t/{encodedTenantId}/a/{encodedAppId}/n/plugin/e/{environmentId}/h/{certHashHex}
```

**Key encoding rules:**
- **encodedTenantId**: GUID bytes → Base64URL (no padding, `+`→`-`, `/`→`_`)
- **encodedAppId**: Same encoding as tenant
- **certHashHex**: SHA-256 hash in **hex format** (NOT base64url — this is the #1 gotcha)
- **environmentId**: Dataverse organization/environment GUID

The MCP tool handles all encoding automatically.

### Step 5: Create Federated Identity Credentials on each UAMI

For each environment:
```bash
az identity federated-credential create \
  --identity-name "mi-dataverse-dev" \
  --resource-group "rg-dataverse" \
  --name "dataverse-dev-credential" \
  --issuer "https://login.microsoftonline.com/{tenantId}/v2.0" \
  --subject "/eid1/c/pub/t/{encodedTenantId}/a/{encodedAppId}/n/plugin/e/{envId}/h/{certHashHex}" \
  --audiences "api://AzureADTokenExchange"
```

Repeat for each environment — only the `environmentId` changes in the subject.

### Step 6: Grant UAMI Access to Target Azure Resources

Example for Key Vault:
```bash
# Grant each UAMI access to read secrets
az keyvault set-policy --name "kv-myapp" \
  --object-id "$(az identity show -n mi-dataverse-dev -g rg-dataverse --query principalId -o tsv)" \
  --secret-permissions get list
```

Or for RBAC-based Key Vault:
```bash
az role assignment create \
  --assignee-object-id "$(az identity show -n mi-dataverse-dev -g rg-dataverse --query principalId -o tsv)" \
  --role "Key Vault Secrets User" \
  --scope "/subscriptions/{subId}/resourceGroups/rg-dataverse/providers/Microsoft.KeyVault/vaults/kv-myapp"
```

### Step 7: Register Managed Identity in Dataverse

Use the `create_managed_identity` MCP tool for each environment:

```
Select environment → DEV
create_managed_identity:
  application_id: "{UAMI_CLIENT_ID_FOR_DEV}"
  managed_identity_id: "{CONSISTENT_GUID}"  ← use same GUID across all envs!
  tenant_id: "{TENANT_ID}"
```

**⚠️ IMPORTANT**: Use the **same managedidentityid GUID** across all environments. This allows the solution to be promoted without changing the ID.

The API call:
```json
POST /api/data/v9.2/managedidentities
{
  "applicationid": "{UAMI_CLIENT_ID}",
  "managedidentityid": "{CONSISTENT_GUID}",
  "credentialsource": 2,
  "subjectscope": 1,
  "tenantid": "{TENANT_ID}",
  "version": 1
}
```

### Step 8: Associate Assembly with Managed Identity

Use the `associate_assembly_managed_identity` MCP tool:

```
list_plugin_assemblies → find your assembly ID
associate_assembly_managed_identity:
  assembly_id: "{PLUGIN_ASSEMBLY_ID}"
  managed_identity_id: "{MANAGED_IDENTITY_ID}"
```

The API call:
```json
PATCH /api/data/v9.2/pluginassemblies({assemblyId})
{
  "managedidentityid@odata.bind": "/managedidentities({managedIdentityId})"
}
```

### Step 9: Sign and Deploy the Assembly

```bash
# Sign the DLL
signtool sign /f plugin-signing.pfx /p "YourPassword" /fd SHA256 MyPlugin.dll

# Verify
signtool verify /pa MyPlugin.dll
```

Deploy via Plugin Registration Tool, `pac plugin push`, or solution import.

### Step 10: Verify — Test AcquireToken in Plugin Code

```csharp
public void Execute(IServiceProvider serviceProvider)
{
    var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
    var tracingService = (ITracingService)serviceProvider.GetService(typeof(ITracingService));

    // Get Managed Identity Service
    var miService = (IManagedIdentityService)serviceProvider.GetService(typeof(IManagedIdentityService));

    // Acquire token for Key Vault (MUST use .default suffix)
    string token = miService.AcquireToken(new[] { "https://vault.azure.net/.default" });

    tracingService.Trace("Token acquired: {0}...", token.Substring(0, 20));

    // Use token
    using (var client = new HttpClient())
    {
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = client.GetAsync("https://kv-myapp.vault.azure.net/secrets/my-secret?api-version=7.4").Result;
        tracingService.Trace("Key Vault response: {0}", response.StatusCode);
    }
}
```

**⚠️ AcquireToken gotchas:**
- Scope must end with `/.default` suffix: `"https://vault.azure.net/.default"`, NOT `"https://vault.azure.net"`
- The parameter is `IEnumerable<string>`, so pass: `new[] { scope }` (not a plain string)

## CI/CD Integration (GitHub Actions)

```yaml
- name: Sign Plugin Assembly
  run: |
    # Decode PFX from secret
    echo "${{ secrets.PLUGIN_CERT_PFX_BASE64 }}" | base64 -d > cert.pfx

    # Sign both DLLs
    signtool sign /f cert.pfx /p "${{ secrets.CERT_PASSWORD }}" /fd SHA256 MyPlugin/bin/Release/net462/MyPlugin.dll

    # Clean up
    rm cert.pfx

- name: Post-Import — Associate Assembly with Managed Identity
  run: |
    # Dynamic lookup — find the assembly GUID in the target environment
    ASSEMBLY_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
      "$ENV_URL/api/data/v9.2/pluginassemblies?\$filter=name eq 'MyPlugin'&\$select=pluginassemblyid" \
      | jq -r '.value[0].pluginassemblyid')

    # Associate with managed identity
    curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      "$ENV_URL/api/data/v9.2/pluginassemblies($ASSEMBLY_ID)" \
      -d '{"managedidentityid@odata.bind": "/managedidentities(YOUR_MI_GUID)"}'
```

## Environment Promotion Flow

```
GitHub master → CI/CD (sign DLL) → INT → Dataverse pipeline → Test → UAT → Prod
```

- **Same certificate** signs the DLL for all environments
- **Same managed identity GUID** is pre-created in all environments
- **Different UAMI Client IDs** per environment (each env has its own Azure identity)
- **Different federated credential subjects** per environment (different environmentId in subject)
- CI/CD handles signing + post-import association automatically
- Dataverse pipelines carry signed assemblies between environments

## Developer Workflow (DEV only, no CI/CD)

1. Get the PFX file + password
2. `signtool sign /f cert.pfx /p "password" /fd SHA256 MyPlugin.dll`
3. Upload signed DLL via Plugin Registration Tool
4. One-time: use `associate_assembly_managed_identity` to link assembly → managed identity

## Troubleshooting

- **"Federated credential validation failed"** → #1 cause: cert hash in wrong format. Must be **hex**, not base64url
- **"AcquireToken returns empty/error"** → Check scope format: must end with `/.default`
- **"Unauthorized" from Azure resource** → UAMI doesn't have permissions on the target resource
- **"Assembly not signed"** → signtool must be run BEFORE uploading to Dataverse
- **"Managed identity not found"** → Verify the managedidentityid record exists in the target environment
- **"Token audience mismatch"** → Federated credential audience must be `api://AzureADTokenExchange`
