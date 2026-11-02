[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$CloudflaredPath,
    [ValidateRange(1024, 65535)][int]$Port = 3001
)

# Temporary, email-protected development access. Never fall back to a public tunnel.
$ErrorActionPreference = 'Stop'
$ioyaPreviewEmail = [System.Net.Mail.MailAddress]::new($Email.Trim())
if ($ioyaPreviewEmail.Address -cne $Email.Trim() -or $Email -match '[*,;\s]') {
    throw 'Supply one exact email address, without wildcards or domain rules.'
}
$ioyaTunnelBinary = Get-Item -LiteralPath (Resolve-Path -LiteralPath $CloudflaredPath).Path
if ($ioyaTunnelBinary.PSIsContainer) { throw 'CloudflaredPath must point to the official cloudflared executable.' }
$ioyaClientHelp = (& $ioyaTunnelBinary.FullName tunnel --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or -not $ioyaClientHelp.Contains('--allowed-mail')) {
    throw 'This cloudflared version does not support protected Quick Tunnels. Update it; a public tunnel will not be started.'
}
$ioyaLocalOrigin = 'http://127.0.0.1:' + $Port
try { Invoke-WebRequest -Uri $ioyaLocalOrigin -Method Head -TimeoutSec 5 | Out-Null }
catch { throw 'Start IOYA locally before starting its HTTPS preview.' }

Write-Host ('Starting a temporary HTTPS preview restricted to ' + $ioyaPreviewEmail.Address)
Write-Host 'Sign in on your phone with the email PIN. Stop with Ctrl+C when testing is finished.'
$ioyaEmptyConfig = Join-Path $PSScriptRoot 'https-preview.yml'
& $ioyaTunnelBinary.FullName tunnel --config $ioyaEmptyConfig --no-autoupdate --url $ioyaLocalOrigin --allowed-mail $ioyaPreviewEmail.Address
exit $LASTEXITCODE
