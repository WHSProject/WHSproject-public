[CmdletBinding()]
param(
  [string]$ContainerName = "whs-verdaccio"
)

$ErrorActionPreference = "Stop"

function ConvertFrom-SecurePassword {
  param(
    [Parameter(Mandatory)]
    [Security.SecureString]$SecurePassword
  )

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-ConfirmedPassword {
  param(
    [Parameter(Mandatory)]
    [string]$AccountName
  )

  while ($true) {
    try {
      $firstSecure = Read-Host "$AccountName 비밀번호" -AsSecureString
      $secondSecure = Read-Host "$AccountName 비밀번호 확인" -AsSecureString
    }
    catch {
      throw "[취소] 비밀번호 입력이 완료되기 전에 입력이 종료되었습니다."
    }

    if ($null -eq $firstSecure -or $null -eq $secondSecure) {
      throw "[취소] 비밀번호 입력이 완료되기 전에 입력이 종료되었습니다."
    }

    $first = ConvertFrom-SecurePassword $firstSecure
    $second = ConvertFrom-SecurePassword $secondSecure

    if ([string]::IsNullOrEmpty($first)) {
      Write-Warning "비밀번호는 비워둘 수 없습니다. 다시 입력하세요."
    }
    elseif ($first -cne $second) {
      Write-Warning "입력한 비밀번호가 일치하지 않습니다. 다시 입력하세요."
    }
    else {
      return $first
    }

    $first = $null
    $second = $null
  }
}

function Invoke-Docker {
  param(
    [Parameter(Mandatory)]
    [string[]]$Arguments,

    [string]$FailureMessage = "Docker 명령 실행에 실패했습니다."
  )

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function ConvertTo-Base64Script {
  param(
    [Parameter(Mandatory)]
    [string]$Script
  )

  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
}

Write-Host ""
Write-Host "WHSProject Verdaccio 최초 계정 설정"
Write-Host "===================================="
Write-Host "이 작업은 Docker 저장 볼륨마다 한 번만 실행합니다."
Write-Host "입력한 평문 비밀번호는 화면이나 파일에 저장하지 않습니다."
Write-Host ""

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하고 다시 실행하세요."
}

& docker info --format "{{.ServerVersion}}" *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker에 연결할 수 없습니다. Docker Desktop을 실행하고 다시 시도하세요."
}

$inspectOutput = & docker inspect $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "'$ContainerName' 컨테이너가 없습니다. 먼저 docker compose up -d를 실행하세요."
}

$container = ($inspectOutput | ConvertFrom-Json)[0]
if (-not $container.State.Running) {
  throw "'$ContainerName' 컨테이너가 실행 중이 아닙니다. 먼저 docker compose up -d를 실행하세요."
}

$storageMount = $container.Mounts |
  Where-Object { $_.Destination -eq "/verdaccio/storage" } |
  Select-Object -First 1

if (-not $storageMount -or $storageMount.Type -ne "volume") {
  throw "'$ContainerName'의 /verdaccio/storage Docker 볼륨을 찾을 수 없습니다."
}

$listUsersScript = @'
const fs = require("fs");
const file = "/verdaccio/storage/htpasswd";
if (!fs.existsSync(file)) process.exit(0);
const users = fs.readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter(line => line.trim() !== "")
  .map(line => line.split(":")[0]);
process.stdout.write(users.join(","));
'@
$nodeScriptLoader = "eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())"
$listUsersScriptBase64 = ConvertTo-Base64Script $listUsersScript

$existingUsers = & docker exec $ContainerName node -e $nodeScriptLoader $listUsersScriptBase64
if ($LASTEXITCODE -ne 0) {
  throw "기존 Verdaccio 계정을 확인하지 못했습니다."
}

if (-not [string]::IsNullOrWhiteSpace($existingUsers)) {
  $existingUserList = @($existingUsers -split "," | Where-Object { $_ -ne "" })
  $requiredUsers = @("admin")
  $missingUsers = @($requiredUsers | Where-Object { $existingUserList -notcontains $_ })

  if ($missingUsers.Count -gt 0) {
    Write-Warning "[확인 필요] 계정 파일은 있지만 필수 계정이 일부 누락되었습니다."
    Write-Host "현재 계정: $existingUsers"
    Write-Host "누락 계정: $($missingUsers -join ',')"
    Write-Host "기존 계정을 보호하기 위해 자동으로 덮어쓰지 않았습니다."
    Write-Host "infra/verdaccio/README.md의 '계정 관리' 절에 따라 누락 계정을 추가하세요."
    exit 1
  }

  Write-Host "[완료] 이 Docker 볼륨은 이미 초기화되어 있습니다."
  Write-Host "현재 계정: $existingUsers"
  Write-Host "기존 계정을 덮어쓰지 않았습니다."
  Write-Host ""
  Write-Host "로그인:"
  Write-Host "npm login --auth-type=legacy --registry=http://localhost:3000/npm/"
  Write-Host ""
  Write-Host "로그인 및 Metadata 조회 확인:"
  Write-Host "npm view is-odd version --registry=http://localhost:3000/npm/"
  exit 0
}

Write-Host "생성할 계정:"
Write-Host "  admin  - 내부 패키지 배포 및 삭제"
Write-Host ""
Write-Host "비밀번호를 두 번 입력하세요. 입력 내용은 화면에 표시되지 않습니다."

$adminPassword = Read-ConfirmedPassword "admin"

$hadAdminPassword = Test-Path Env:VERDACCIO_ADMIN_PASSWORD
$previousAdminPassword = $env:VERDACCIO_ADMIN_PASSWORD

$bootstrapScript = @'
const fs = require("fs");
const bcrypt = require("/usr/local/lib/node_modules/verdaccio/node_modules/bcryptjs");
const file = "/verdaccio/storage/htpasswd";
const rounds = 10;

const lines = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim() !== "")
  : [];

if (lines.some(line => line.split(":")[0] === "admin")) {
  console.error("admin 계정이 이미 있어 생성을 중단합니다.");
  process.exit(1);
}

lines.push("admin:" + bcrypt.hashSync(process.env.VERDACCIO_ADMIN_PASSWORD, rounds));

fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o644 });
console.log("admin 계정을 생성했습니다.");
'@
$bootstrapScriptBase64 = ConvertTo-Base64Script $bootstrapScript

try {
  $env:VERDACCIO_ADMIN_PASSWORD = $adminPassword

  Write-Host ""
  Write-Host "계정을 생성하는 중입니다..."
  Invoke-Docker -Arguments @(
    "run", "--rm",
    "-v", "$($storageMount.Name):/verdaccio/storage",
    "-e", "VERDACCIO_ADMIN_PASSWORD",
    "--entrypoint", "node",
    $container.Config.Image,
    "-e", $nodeScriptLoader, $bootstrapScriptBase64
  ) -FailureMessage "Verdaccio 초기 계정 생성에 실패했습니다."
}
finally {
  if ($hadAdminPassword) {
    $env:VERDACCIO_ADMIN_PASSWORD = $previousAdminPassword
  }
  else {
    Remove-Item Env:VERDACCIO_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  }

  $adminPassword = $null
  $previousAdminPassword = $null
}

Write-Host "Verdaccio를 재시작하는 중입니다..."
Invoke-Docker -Arguments @("restart", $ContainerName) `
  -FailureMessage "계정은 생성됐지만 Verdaccio 재시작에 실패했습니다."

Write-Host ""
Write-Host "[완료] admin 계정을 생성했습니다."
Write-Host "이 PC에서는 Docker 볼륨을 삭제하지 않는 한 다시 초기화할 필요가 없습니다."
Write-Host ""
Write-Host "다음 명령으로 로그인하세요:"
Write-Host "npm login --auth-type=legacy --registry=http://localhost:3000/npm/"
Write-Host ""
Write-Host "로그인 및 Metadata 조회 확인:"
Write-Host "npm view is-odd version --registry=http://localhost:3000/npm/"
