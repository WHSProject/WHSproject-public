# Windows PowerShell 에서 cache-admin.sh 를 실행한다.
#
#   .\infra\verdaccio\scripts\cache-admin.ps1 list
#   .\infra\verdaccio\scripts\cache-admin.ps1 show is-odd
#   .\infra\verdaccio\scripts\cache-admin.ps1 delete is-odd
#   .\infra\verdaccio\scripts\cache-admin.ps1 delete is-odd --yes
#
# Cache 처리 로직은 cache-admin.sh 한 곳에만 둔다. 여기서는 Git for Windows 의
# sh.exe 를 찾아 인자를 전달하고, 실제 삭제 시 PowerShell 에서 비밀번호를 안전하게
# 입력받아 자식 Process의 환경변수로만 전달한다.

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

$allowedCommands = @("list", "usage", "show", "delete")
if ($Command -notin $allowedCommands) {
  Write-Host "알 수 없는 명령입니다: $Command" -ForegroundColor Red
  Write-Host "사용 가능한 명령: list, usage, show, delete"
  exit 2
}

# sh 는 \ 가 섞인 경로를 받으면 자기 위치를 찾지 못한다. / 로 바꿔 넘긴다.
$scriptPath = (Join-Path $PSScriptRoot "cache-admin.sh") -replace '\\', '/'

$candidates = @()

# git 이 PATH 에 있으면 그 설치 위치의 bin\sh.exe 를 먼저 쓴다.
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
  $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
  $candidates += Join-Path $gitRoot "bin\sh.exe"
}

$candidates += Join-Path $env:ProgramFiles "Git\bin\sh.exe"

$shCommand = Get-Command sh.exe -ErrorAction SilentlyContinue
if ($shCommand) {
  $candidates += $shCommand.Source
}

$sh = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $sh) {
  Write-Host "Git for Windows 의 sh.exe 를 찾을 수 없습니다." -ForegroundColor Red
  Write-Host "Git for Windows 를 설치하거나, Git Bash 에서 다음 형식으로 실행하세요."
  Write-Host "  sh infra/verdaccio/scripts/cache-admin.sh list"
  exit 2
}

$forwardArgs = @($Command) + @($Arguments)
$needsPassword = $Command -eq "delete" -and $Arguments -contains "--yes"
$adminUser = if ([string]::IsNullOrEmpty($env:VERDACCIO_ADMIN_USER)) {
  "admin"
} else {
  $env:VERDACCIO_ADMIN_USER
}
$previousPassword = $env:VERDACCIO_ADMIN_PASSWORD
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

try {
  # PowerShell 에서 시작한 Git sh.exe 는 표준 입력을 TTY 로 보지 않는다. 따라서 실제
  # 삭제일 때는 여기서 비밀번호를 받고, 기존 환경변수가 있으면 그대로 사용한다.
  if ($needsPassword -and [string]::IsNullOrEmpty($previousPassword)) {
    $securePassword = Read-Host "$adminUser 비밀번호" -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) {
      Write-Host "비밀번호는 비워둘 수 없습니다." -ForegroundColor Red
      exit 2
    }
    $env:VERDACCIO_ADMIN_PASSWORD = $plainPassword
  }

  & $sh $scriptPath @forwardArgs
  $exitCode = $LASTEXITCODE
} finally {
  # 사용자가 원래 지정한 값은 복원하고, 여기서 받은 평문은 가능한 빨리 지운다.
  if ($null -eq $previousPassword) {
    Remove-Item Env:VERDACCIO_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  } else {
    $env:VERDACCIO_ADMIN_PASSWORD = $previousPassword
  }
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $plainPassword = $null
}

exit $exitCode
