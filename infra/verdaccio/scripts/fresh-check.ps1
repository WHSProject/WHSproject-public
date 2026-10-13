# Windows PowerShell 에서 fresh-check.sh 를 실행한다.
#
#   .\infra\verdaccio\scripts\fresh-check.ps1
#
# 검사 내용은 fresh-check.sh 한 곳에만 둔다. 여기서는 Git for Windows 의 sh.exe 를
# 찾아 넘기기만 하고, 결과와 exit code 를 그대로 돌려준다.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# sh 는 \ 가 섞인 경로를 받으면 자기 위치를 찾지 못한다. / 로 바꿔 넘긴다.
$scriptPath = (Join-Path $PSScriptRoot "fresh-check.sh") -replace '\\', '/'

$candidates = @()

# git 이 PATH 에 있으면 그 설치 위치의 bin\sh.exe 를 먼저 쓴다.
# 예: C:\Program Files\Git\cmd\git.exe -> C:\Program Files\Git\bin\sh.exe
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
  Write-Host "Git for Windows 를 설치하거나, Git Bash 에서 다음 명령으로 실행하세요."
  Write-Host "  sh infra/verdaccio/scripts/fresh-check.sh"
  exit 2
}

& $sh $scriptPath
exit $LASTEXITCODE
