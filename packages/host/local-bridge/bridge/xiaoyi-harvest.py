#!/usr/bin/env python3
# 小艺（AI空间）凭证收割器 —— 纯标准库，不依赖任何 pip 包。
#
# 输出一行 JSON 到 stdout：
#   {"ok":true,"cookies":{"xy_token":"Bearer ...","xy_deviceId":"...",...},"pids":N}
#   {"ok":false,"error":"...","code":"no_app|no_cookies"}
#
# 为什么全部从内存拿：
#   `xy_token` 是会话 cookie（无过期时间），Chromium 不落盘 —— 磁盘 cookie 库里根本没有它。
#   而 AI空间 的渲染进程内存里留着服务器下发的**完整 Set-Cookie 头**：
#       xy_token=Bearer <810字符>; path=/; ... secure; httponly
#       xy_deviceId=<64hex>; path=/; max-age=31536000; expires=...
#   所以一次内存扫描就能把 5 个核心 cookie 全部拿到，**不需要**解 WebView2 的
#   DPAPI + AES-GCM 加密库（那条路只能在应用关闭时读，而没有应用就没有 token，白搭）。
#
# 只做 Node 做不到的事：跨进程读内存。其余（HTTP、WebSocket、差分、SSE）都在
# xiaoyi-bridge.mjs 里用 Node 标准库完成。详见 xiaoyi-protocol-notes.md。

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import re
import sys
import time

# 5 个核心 cookie 的提取规则。实测最小可用集合就是这 5 个（少任何一个都 400），
# WAF 会话、csrf、HW_id* 那几个反而不需要。
PATTERNS = [
    ('xy_token', re.compile(rb"xy_token=(Bearer[ ][0-9A-F]{600,900})")),
    ('xy_deviceId', re.compile(rb"xy_deviceId=([0-9a-fA-F]{16,80})")),
    ('xy_appName', re.compile(rb"xy_appName=([^;\x00-\x1f]{1,80})")),
    ('JSID', re.compile(rb"JSID=([^;\x00-\x1f]{1,120})")),
    ('xyxp', re.compile(rb"xyxp=([^;\x00-\x1f]{1,400})")),
]

# 备用：cookie 存储里的 CanonicalCookie 形态 —— 名字和值之间隔着几十字节。
TOKEN_LOOSE_RE = re.compile(rb"xy_token.{0,64}?Bearer[ ]([0-9A-F]{600,900})", re.S)

# 同一份数据在内存里会有多处副本，其中一些是被截断的（值中间夹着 \x00 或堆元数据）。
# 所以每个名字都收集所有候选，最后按形状校验挑**最长**的那个。
VALIDATORS = {
    'xy_token': re.compile(r'^Bearer [0-9A-F]{600,900}$'),
    'xy_deviceId': re.compile(r'^[0-9a-fA-F]{32,64}$'),
    'xy_appName': re.compile(r'^com\.[A-Za-z0-9._-]{3,60}$'),
    'JSID': re.compile(r'^[0-9a-fA-F]{32,80}$'),
    'xyxp': re.compile(r'^[A-Za-z0-9+/=_-]{50,400}$'),
}

MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
PAGE_READABLE = {0x02, 0x04, 0x20, 0x40, 0x80}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")


# ---------------------------------------------------------------- 输出

def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    raise SystemExit(code)


def fail(msg, code="error", exit_code=1):
    emit({"ok": False, "error": msg, "code": code}, exit_code)


# ---------------------------------------------------------------- 进程枚举

class MBI64(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", wt.DWORD), ("_a1", wt.DWORD),
                ("RegionSize", ctypes.c_ulonglong), ("State", wt.DWORD),
                ("Protect", wt.DWORD), ("Type", wt.DWORD), ("_a2", wt.DWORD)]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
                ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", wt.WCHAR * 260)]


k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_ulonglong, ctypes.POINTER(MBI64), ctypes.c_size_t]
k32.ReadProcessMemory.restype = wt.BOOL
k32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_ulonglong, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
ntdll.NtQueryInformationProcess.argtypes = [wt.HANDLE, wt.DWORD, ctypes.c_void_p,
                                            wt.DWORD, ctypes.POINTER(wt.DWORD)]


def pids_named(name):
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    if not snap or snap == wt.HANDLE(-1).value:
        return []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    out = []
    try:
        if k32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                if entry.szExeFile.lower() == name.lower():
                    out.append(int(entry.th32ProcessID))
                if not k32.Process32NextW(snap, ctypes.byref(entry)):
                    break
    finally:
        k32.CloseHandle(snap)
    return out


def cmdline_of(pid):
    """PEB → ProcessParameters → CommandLine。只挑 AI空间 自己的 WebView2。

    `msedgewebview2.exe` 往往有二十几个（Office、QQ、小组件都用它），挨个扫太慢，
    所以先按命令行里的 user-data-dir 过滤。
    """
    h = k32.OpenProcess(0x1000 | 0x0010, False, pid)
    if not h:
        return ""
    try:
        pbi = ctypes.create_string_buffer(48)
        retq = wt.DWORD(0)
        ret = ctypes.c_size_t(0)
        if ntdll.NtQueryInformationProcess(h, 0, pbi, 48, ctypes.byref(retq)) != 0:
            return ""
        peb = ctypes.c_ulonglong.from_buffer(pbi, 8).value
        params = ctypes.c_ulonglong()
        if not k32.ReadProcessMemory(h, peb + 0x20, ctypes.byref(params), 8, ctypes.byref(ret)):
            return ""
        us = ctypes.create_string_buffer(16)
        if not k32.ReadProcessMemory(h, params.value + 0x70, us, 16, ctypes.byref(ret)):
            return ""
        length = ctypes.c_ushort.from_buffer(us, 0).value
        buf = ctypes.c_ulonglong.from_buffer(us, 8).value
        if not length or length > 8192:
            return ""
        raw = ctypes.create_string_buffer(length)
        if not k32.ReadProcessMemory(h, buf, raw, length, ctypes.byref(ret)):
            return ""
        return raw.raw.decode("utf-16-le", "ignore")
    except Exception:
        return ""
    finally:
        k32.CloseHandle(h)


def webview_pids():
    return [pid for pid in pids_named("msedgewebview2.exe")
            if "personalcenter" in cmdline_of(pid).lower()]


# ---------------------------------------------------------------- 内存扫描

def scan_pid(pid, want):
    """扫一个进程，收集 want 里各 cookie 的**全部**候选值（可能含被截断的副本）。"""
    h = k32.OpenProcess(0x0400 | 0x0010, False, pid)
    if not h:
        return {}
    got = {name: [] for name in want}
    addr = 0
    mbi = MBI64()
    buf = ctypes.create_string_buffer(1 << 20)
    read = ctypes.c_size_t(0)
    try:
        while addr < 0x7FFFFFFEFFFF:
            if not k32.VirtualQueryEx(h, addr, ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            size = mbi.RegionSize
            if (mbi.State == MEM_COMMIT and mbi.Protect in PAGE_READABLE
                    and mbi.Type == MEM_PRIVATE and size <= (64 << 20)):
                off = 0
                while off < size:
                    chunk = min(1 << 20, size - off)
                    if not k32.ReadProcessMemory(h, addr + off, buf, chunk, ctypes.byref(read)):
                        break
                    data = buf.raw[: read.value]
                    for name, rx in PATTERNS:
                        if name not in want or len(got[name]) >= 40:
                            continue
                        for m in rx.finditer(data):
                            got[name].append(m.group(1).decode("ascii", "ignore"))
                            if len(got[name]) >= 40:
                                break
                    if 'xy_token' in want and len(got['xy_token']) < 40:
                        for m in TOKEN_LOOSE_RE.finditer(data):
                            got['xy_token'].append("Bearer " + m.group(1).decode())
                            if len(got['xy_token']) >= 40:
                                break
                    off += chunk
            addr = mbi.BaseAddress + size
    finally:
        k32.CloseHandle(h)
    return got


def pick(name, candidates):
    """按形状校验挑最长的一个。截断的副本会被校验规则直接筛掉。"""
    rx = VALIDATORS[name]
    best = None
    for v in candidates:
        if rx.match(v) and (best is None or len(v) > len(best)):
            best = v
    return best


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=90, help="整体超时（秒）")
    args = ap.parse_args()

    pids = webview_pids()
    if not pids:
        fail("AI空间 的 WebView2 没在跑。请在「AI空间」里打开对话页（小艺）后重试。",
             "no_app")

    want = {name for name, _ in PATTERNS}
    candidates = {name: [] for name in want}
    deadline = time.time() + args.timeout
    for pid in pids:
        if time.time() > deadline:
            break
        # 已经能挑出全部 5 个就不用再扫别的进程了
        if all(pick(n, candidates[n]) for n in want):
            break
        for name, vals in scan_pid(pid, want).items():
            candidates[name].extend(vals)

    cookies = {name: pick(name, vals) for name, vals in candidates.items()}
    cookies = {k: v for k, v in cookies.items() if v}

    if not cookies.get('xy_token'):
        fail("扫了 %d 个 WebView2 进程也没找到 xy_token。"
             "请在 AI空间 里打开对话页并随便发一条消息，然后重试。" % len(pids),
             "no_cookies")

    emit({"ok": True, "cookies": cookies, "pids": len(pids)})


if __name__ == "__main__":
    main()
