# Rebuilds the llama.cpp Android engine from a patched SDK checkout and installs
# it into node_modules, on Windows, with no Mac and no WSL.
#
# Why: the published engine drops the app's requested context window (see
# docs/SDK-FINDINGS.md), so every model loads at 2048 tokens no matter what the
# app asks for. patches/engine/llamacpp-honour-context-length.patch fixes it,
# but the engine ships as a prebuilt .so, so the fix only takes effect once the
# .so is rebuilt.
#
# Run from PowerShell, NOT Git Bash: MSYS rewrites the CMake path arguments
# ("-ffile-prefix-map=C;C:\Program Files\Git\Users\...") and the compile fails.
#
# Re-run after any `npm ci` — node_modules is not the place a build artifact
# survives.
#
#   powershell -File tools\engine\build-android-engine.ps1 [-SdkRoot D:\path\to\runanywhere-sdks]

param(
  [string]$SdkRoot = "D:\RunAnywhere\runanywhere-sdks",
  [string]$Ndk = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.1.12297006",
  [string]$CMakeRoot = "$env:LOCALAPPDATA\Android\Sdk\cmake\3.30.5"
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cmake = Join-Path $CMakeRoot 'bin\cmake.exe'
$dest = Join-Path $repo 'node_modules\@runanywhere\llamacpp\android\src\main\jniLibs\arm64-v8a'

foreach ($p in @($SdkRoot, $Ndk, $cmake, $dest)) {
  if (-not (Test-Path $p)) { throw "not found: $p" }
}

# The rebuilt plugin loads into the PUBLISHED librac_commons.so, so the SDK
# checkout must be the same version as the installed npm package or the plugin
# ABI will not match.
$pkgVersion = (Get-Content (Join-Path $repo 'node_modules\@runanywhere\llamacpp\package.json') | ConvertFrom-Json).version
$sdkVersion = (Get-Content (Join-Path $SdkRoot 'sdk\runanywhere-react-native\packages\llamacpp\package.json') | ConvertFrom-Json).version
if ($pkgVersion -ne $sdkVersion) {
  throw "version mismatch: npm package is $pkgVersion, SDK checkout is $sdkVersion. Check out the matching SDK tag."
}

$env:ANDROID_NDK_HOME = $Ndk
$env:PATH = "$CMakeRoot\bin;$env:PATH"

Push-Location $SdkRoot
try {
  # ONNX, RAG and Sherpa need third-party archives this app does not rebuild —
  # only the llamacpp plugin is being replaced.
  Write-Host "configuring android-arm64..."
  & $cmake --preset android-arm64 -DRAC_BACKEND_ONNX=OFF -DRAC_BACKEND_RAG=OFF -DRAC_BACKEND_SHERPA=OFF
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }

  Write-Host "building (this takes a while)..."
  & $cmake --build build\android-arm64 --parallel 8
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
}
finally { Pop-Location }

$built = Get-ChildItem (Join-Path $SdkRoot 'build\android-arm64') -Recurse -Filter 'librac_backend_llamacpp.so' | Select-Object -First 1
if (-not $built) { throw "librac_backend_llamacpp.so was not produced" }

# Only the llamacpp backend is replaced. librac_commons.so from this build was
# compiled without ONNX and Sherpa, so installing it would break vision and
# voice.
$target = Join-Path $dest 'librac_backend_llamacpp.so'
if (-not (Test-Path "$target.published")) { Copy-Item $target "$target.published" }
Copy-Item $built.FullName $target -Force

Write-Host "installed $($built.FullName) -> $target"
Write-Host "rebuild the APK with: cd apps\mobile\android; .\gradlew.bat assembleRelease --rerun-tasks"
Write-Host "verify on device: adb logcat | Select-String 'Final context size'"
