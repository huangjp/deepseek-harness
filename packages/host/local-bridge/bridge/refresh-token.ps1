# Copilot 令牌刷新脚本
#
# 为什么需要它：Copilot 的 access_token 无法离线获取（设备码流程被 AADSTS70002 拒绝、
# CDP 端口不开放、MSAL 缓存用不可导出密钥加密、内存里只是 V8 ConsString）。
# 唯一可行的是从它自己的 WebSocket 握手 URL 里收割 —— 这需要在代理链里插一层 MITM。
#
# 本脚本把这件事自动化：临时切代理 → 让 Copilot 建一次连接 → 等收割 →
# 立刻还原代理设置。正常情况下你只需要跑它，然后桥就能继续用约一小时。
#
# 用法（普通权限即可）：
#   powershell -ExecutionPolicy Bypass -File refresh-token.ps1
#
# 注意：本文件必须保存为「UTF-8 with BOM」。Windows PowerShell 5.1 读取无 BOM 的
# .ps1 时会按 ANSI(GBK) 解析，中文被拆坏后连引号都会被吞掉，整个脚本会解析失败。

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 环境自净化
# Windows 环境变量不区分大小写。如果进程环境块里同时存在 HTTP_PROXY 和 http_proxy，
# .NET 的 ProcessStartInfo 在复制环境块时会抛
#   「已添加项。字典中的关键字:"HTTP_PROXY"所添加的关键字:"http_proxy"」
# 于是 Start-Process 直接失败 —— mitmdump 根本起不来，收割必然失败，而且报错很容易被忽略。
# 这里把重复的大小写变体收敛成一套大写，彻底消除该崩溃。
$proxyKeep = @{}
foreach ($n in 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY') {
    $proxyKeep[$n] = [Environment]::GetEnvironmentVariable($n, 'Process')
}
foreach ($n in 'http_proxy','https_proxy','no_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','NO_PROXY') {
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
}
foreach ($n in 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY') {
    if ($proxyKeep[$n]) { [Environment]::SetEnvironmentVariable($n, $proxyKeep[$n], 'Process') }
}

$ProbeDir   = if ($env:COPILOT_HARVEST_DIR) { $env:COPILOT_HARVEST_DIR } else { Join-Path $env:USERPROFILE 'copilot-probe' }
$TokenFile  = Join-Path $ProbeDir 'token.json'
$MitmPort   = if ($env:COPILOT_MITM_PORT) { [int]$env:COPILOT_MITM_PORT } else { 8082 }
$Upstream   = if ($env:COPILOT_UPSTREAM_PROXY) { $env:COPILOT_UPSTREAM_PROXY } else { '127.0.0.1:7890' }

# mitmdump 位置不能写死：换台机器 Python 版本/安装方式都可能不同。
# 依次尝试：环境变量 → PATH → 各 Python 的 Scripts 目录 → 原默认值（仅用于报错提示）。
$Mitmdump = $env:DSH_MITMDUMP
if (-not $Mitmdump -or -not (Test-Path $Mitmdump)) {
    $cmd = Get-Command mitmdump.exe -ErrorAction SilentlyContinue
    if ($cmd) { $Mitmdump = $cmd.Source }
}
if (-not $Mitmdump -or -not (Test-Path $Mitmdump)) {
    $cands = @()
    foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), (Join-Path $env:APPDATA 'Python'), 'C:\')) {
        if (Test-Path $root) {
            $cands += Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
                      ForEach-Object { Join-Path $_.FullName 'Scripts\mitmdump.exe' }
        }
    }
    $hit = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($hit) { $Mitmdump = $hit }
}
if (-not $Mitmdump) { $Mitmdump = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\mitmdump.exe' }

# 收割插件优先用与本脚本同目录的副本（随安装包一起分发），回退到 copilot-probe。
# 注意：$PSScriptRoot 只在用 -File 直接执行时才有值；宿主（preflight.mjs）是以
# `[scriptblock]::Create()` 方式调用本脚本的，那时 $PSScriptRoot 为空，
# 由宿主通过 $DshBridgeDir 传入本脚本所在目录。
$SelfDir = $PSScriptRoot
if (-not $SelfDir -and $DshBridgeDir) { $SelfDir = $DshBridgeDir }
$Harvester = ''
if ($SelfDir) { $Harvester = Join-Path $SelfDir 'token-harvester.py' }
if (-not $Harvester -or -not (Test-Path $Harvester)) { $Harvester = Join-Path $ProbeDir 'token-harvester.py' }

function Get-ProxySnapshot {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    $p = Get-ItemProperty $k
    return @{ Enable = $p.ProxyEnable; Server = $p.ProxyServer; Override = $p.ProxyOverride }
}

function Set-SystemProxy($enable, $server) {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    Set-ItemProperty $k -Name ProxyEnable -Value $enable
    if ($server) { Set-ItemProperty $k -Name ProxyServer -Value $server }
}

# Get-NetTCPConnection 在某些环境下对刚监听的端口返回空（实测过），
# 所以用真正的 TCP 连接来判断端口是否可用。
function Test-MitmPort {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $MitmPort)
        $c.Close()
        return $true
    } catch { return $false }
}

# Start-Process 会把 -ArgumentList 的元素用空格拼成一条命令行，**不会自动加引号**。
# 而本工具安装后的路径几乎必然含空格（例如 "…\Programs\DeepSeek Harness\…"），
# 于是 mitmdump 收到的 --scripts 会在空格处被截断成 "…\Programs\DeepSeek"，
# 它直接报 `No such script` 退出 —— 外部只看到「8082 一直不监听」，看不出原因。
# 含空格的值必须自己带上引号（Windows 的 CRT 解析命令行时会把它们去掉）。
function Quote-Arg($value) {
    if ("$value" -match '\s') { return "`"$value`"" }
    return "$value"
}

try {
    Add-Type -ErrorAction Stop @"
using System;
using System.Runtime.InteropServices;
public class DshWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
} catch { }

# 关键修复：Copilot 窗口常常处于「最小化」状态。此时
#   - AppActivate 会返回 False（且返回值本身就不可信）
#   - 即使返回成功，SendKeys 也落不到输入框，聊天不会发起，WebSocket 握手永远不会出现
# 所以必须先 SW_RESTORE 还原，再绕过前台锁定（AttachThreadInput）把窗口拉到前台。
function Focus-Copilot {
    $p = Get-Process copilotapp -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { return $null }
    $h = $p.MainWindowHandle
    if ([DshWin]::IsIconic($h)) {
        [DshWin]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
        # WebView2 从最小化恢复后需要时间重新渲染，太早发键会全部落空（实测过）。
        Start-Sleep -Milliseconds 2500
    }
    $fg = [DshWin]::GetForegroundWindow()
    $fgTid = [DshWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $myTid = [DshWin]::GetCurrentThreadId()
    [DshWin]::AttachThreadInput($myTid, $fgTid, $true) | Out-Null
    [DshWin]::BringWindowToTop($h) | Out-Null
    [DshWin]::SetActiveWindow($h) | Out-Null
    [DshWin]::SetForegroundWindow($h) | Out-Null
    [DshWin]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null
    Start-Sleep -Milliseconds 900
    return $p
}

# 点一下窗口下部的输入区，把键盘焦点真正交给聊天输入框。
# 只 SetForegroundWindow 不够 —— 焦点可能还停在别处，SendKeys 就打不进输入框，
# 结果是「握手发生了、令牌拿到了，但没有 target=chat 帧」，请求模板抓不到。
function Click-CopilotInput($h) {
    try {
        $r = New-Object DshWin+RECT
        if (-not [DshWin]::GetWindowRect($h, [ref]$r)) { return }
        $x = [int](($r.Left + $r.Right) / 2)
        $y = [int]($r.Bottom - 90)
        [DshWin]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 250
        [DshWin]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
        Start-Sleep -Milliseconds 60
        [DshWin]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
        Start-Sleep -Milliseconds 500
    } catch { }
}

Write-Host ''
Write-Host '=== Copilot 令牌刷新 ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $Mitmdump))  { throw "找不到 mitmdump：$Mitmdump（请先 pip install mitmproxy）" }
if (-not (Test-Path $Harvester)) { throw "找不到收割插件：$Harvester" }

# 上一次刷新如果被强杀，finally 不会执行，系统代理会一直指向已经死掉的 mitmdump
# —— 现象就是「整台机器上不了网」。必须在**读取当前代理快照之前**把残留补还原，
# 否则快照会把残留值当成"原始设置"，于是本轮结束又"还原"成坏值，形成恶性循环。
$ProxyBackup = Join-Path $ProbeDir '.proxy-backup.json'
if (Test-Path $ProxyBackup) {
    try {
        $stale = Get-Content $ProxyBackup -Raw | ConvertFrom-Json
        if ($stale -and $null -ne $stale.Enable) {
            $desc = if ($stale.Enable -eq 0) { '禁用代理' } else { "$($stale.Server)" }
            Write-Host "检测到上次刷新未还原系统代理，先恢复 → $desc" -ForegroundColor Yellow
            Set-SystemProxy $stale.Enable $stale.Server
        }
    } catch { }
    Remove-Item $ProxyBackup -ErrorAction SilentlyContinue
}

$before = Get-ProxySnapshot
$beforeAge = -1
$beforeStamp = 0
if (Test-Path $TokenFile) {
    try {
        $t = Get-Content $TokenFile -Raw | ConvertFrom-Json
        $beforeStamp = [double]$t.harvestedAt
        $beforeAge = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $t.harvestedAt)
    } catch { }
}
Write-Host "当前令牌年龄：$(if ($beforeAge -ge 0) { "$beforeAge 秒" } else { '无令牌' })"

# ---- 1. 起 mitmdump（挂了就不再起）----
if (-not (Test-MitmPort)) {
    Write-Host "启动 mitmdump（$MitmPort → $Upstream）..."
    $allow = 'cr\.m365copilotapp\.svc\.cloud\.microsoft|substrate\.office\.com|copilot\.microsoft\.com|roaming\.svc\.cloud\.microsoft|m365\.cloud\.microsoft|login\.live\.com|ic3-consumers\.teams\.office\.com'

    # mitmdump 的失败原因必须落盘：Start-Process 默认吞掉子进程的输出，
    # 起不来时外部只能看到一句「未能在 8082 上监听」，无从判断是参数被截断、
    # 依赖缺失还是收割插件加载失败。
    $MitmOut = Join-Path $ProbeDir 'mitmdump.out.log'
    $MitmErr = Join-Path $ProbeDir 'mitmdump.err.log'
    $mitmProc = $null
    try {
        $mitmProc = Start-Process -FilePath $Mitmdump -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $MitmOut -RedirectStandardError $MitmErr `
            -ArgumentList @(
                '--listen-port', $MitmPort,
                '--mode', (Quote-Arg "upstream:http://$Upstream"),
                '--set', 'upstream_cert=false',
                '--allow-hosts', (Quote-Arg $allow),
                '--scripts', (Quote-Arg $Harvester)
            )
    } catch {
        Write-Host "启动 mitmdump 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 700
        if (Test-MitmPort) { break }
    }
    if (Test-MitmPort) {
        Write-Host "mitmdump 已监听 $MitmPort"
    } else {
        Write-Host "mitmdump 未能在 $MitmPort 上监听，收割很可能失败。" -ForegroundColor Yellow
        if ($mitmProc -and $mitmProc.HasExited) {
            Write-Host "  mitmdump 已退出（退出码 $($mitmProc.ExitCode)）" -ForegroundColor Yellow
        }
        foreach ($f in @($MitmErr, $MitmOut)) {
            if (Test-Path $f) {
                $lines = @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -and "$_".Trim() })
                if ($lines.Count -gt 0) {
                    Write-Host "  --- $(Split-Path $f -Leaf) ---"
                    $lines | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" }
                }
            }
        }
    }
} else {
    Write-Host "mitmdump 已在 $MitmPort 运行"
}

# ---- 2. 临时把系统代理指向 mitmdump ----
# 前提是 mitmdump 真的在监听。把系统代理指向一个**没人监听**的端口 = 整台机器断网，
# 而且什么都抓不到 —— 用户看到的现象就是「一打开 DSH，代理就断了」。
# 所以这里必须先确认端口可用；不可用就直接放弃本轮，**一个字节都不动系统代理**。
if (-not (Test-MitmPort)) {
    Write-Host ''
    Write-Host "mitmdump 未在 $MitmPort 监听 —— 跳过本轮收割，且不修改系统代理。" -ForegroundColor Yellow
    Write-Host '  （没有中间人就抓不到任何流量；此时切代理只会让本机彻底断网。）' -ForegroundColor DarkGray
    Write-Host '  请先按上面的 mitmdump 错误输出修好，再重跑本脚本。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '完成。' -ForegroundColor Cyan
    return
}

# 备份当前代理设置：万一本脚本被强杀（finally 不会执行），下次启动能补还原。
try { $before | ConvertTo-Json -Compress | Set-Content -Path $ProxyBackup -Encoding UTF8 } catch { }

Write-Host "临时切换系统代理 → 127.0.0.1:$MitmPort"
Set-SystemProxy 1 "127.0.0.1:$MitmPort"
Start-Sleep -Seconds 2

try {
    # ---- 3. 让 Copilot 建一次连接（UI 自动化发一条消息）----
    $proc = Get-Process copilotapp -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) {
        Write-Host '未找到 Copilot 窗口 —— 请先启动 Copilot 桌面端并登录，然后重跑本脚本。' -ForegroundColor Yellow
        $fresh = $false
        $t = $null
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $deadline = (Get-Date).AddSeconds(100)
        $fresh = $false
        $round = 0
        $t = $null

        while ((Get-Date) -lt $deadline) {
            $round++
            $p = Focus-Copilot
            if (-not $p) {
                Write-Host 'Copilot 窗口消失了，放弃本轮。' -ForegroundColor Yellow
                break
            }
            Write-Host "第 $($round) 轮：激活 Copilot 窗口 (PID $($p.Id)) 并发送一条消息以触发建连..."
            try {
                Click-CopilotInput $p.MainWindowHandle
                $shell.SendKeys('hi')
                Start-Sleep -Milliseconds 500
                $shell.SendKeys('{ENTER}')
            } catch { }

            Write-Host '等待收割（最多 25 秒）...'
            $roundDeadline = (Get-Date).AddSeconds(25)
            while ((Get-Date) -lt $roundDeadline) {
                Start-Sleep -Seconds 2
                if (Test-Path $TokenFile) {
                    try {
                        $cand = Get-Content $TokenFile -Raw | ConvertFrom-Json
                        # 判据必须是「时间戳比开始前更新」，不能只看「年龄小」——
                        # 否则令牌本来就新的时候，什么都没抓到也会报成功。
                        if ([double]$cand.harvestedAt -gt $beforeStamp) {
                            $age = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $cand.harvestedAt)
                            $fresh = $true
                            $t = $cand
                            break
                        }
                    } catch { }
                }
            }
            if ($fresh) { break }
            Write-Host '本轮未收到新令牌，重试...' -ForegroundColor DarkGray
        }
    }

    if ($fresh) {
        # 令牌在 WS 握手时就到手了，而请求模板（target=chat 帧）要晚一点才发出去，
        # 所以这里再等一小会儿，否则会误报「模板缺失」。
        $tplDeadline = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $tplDeadline) {
            try {
                $cur = Get-Content $TokenFile -Raw | ConvertFrom-Json
                if ($cur.template) { $t = $cur; break }
            } catch { }
            Start-Sleep -Milliseconds 800
        }
        $hasTpl = $false
        try { $hasTpl = [bool]$t.template } catch { }
        Write-Host "收割成功：令牌年龄 $age 秒，长度 $($t.access_token.Length)，请求模板$(if ($hasTpl) { '已就绪' } else { '未抓到（将沿用 chat_template.json）' })" -ForegroundColor Green
    } else {
        Write-Host '未在时限内收到新令牌。' -ForegroundColor Yellow
        Write-Host '可再试一次，或手动在 Copilot 里发一条消息。'
    }
}
finally {
    # ---- 4. 无论如何都还原代理 ----
    Write-Host "还原系统代理 → $($before.Server)"
    Set-SystemProxy $before.Enable $before.Server
    # 还原成功才清掉备份；中途被强杀时它会留到下次启动补还原。
    Remove-Item $ProxyBackup -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Cyan
