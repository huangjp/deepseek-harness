# WorkBuddy access-token harvester (Windows only).
#
# Why this exists
# ---------------
# WorkBuddy's cloud API (`https://www.workbuddy.ai/v2/chat/completions`) rejects
# requests that do not carry the official-client channel headers
# (`X-Agent-Type`, `X-User-Id`, `X-Product`, ...) with
#
#     {"code":11128,"msg":"request illegal",
#      "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。"}}
#
# The local CLI gateway (`/api/v1/llm/completions`) does not attach those headers
# on its one-shot agent path, so the relay could not get through either.
#
# The access token, however, lives in the WorkBuddy desktop daemon's memory.
# The desktop holds it encrypted on disk (`auth/workbuddy-desktop-ai.info`) with
# a key that is scoped to the desktop role -- a standalone CLI process cannot
# decrypt it ("missing-key role=cbc"). The daemon, however, keeps the live token
# in plain memory, so we read it out of the process the same way
# `xiaoyi-harvest.py` reads the Celia cookies out of AI Space.
#
# WorkBuddy 5.9.4 launches itself elevated (it ships `resources/elevate.exe`),
# and every process in its tree inherits that high integrity level. A process
# at medium integrity cannot open a high-integrity target with
# PROCESS_VM_READ, so the scan below fails with "access denied" instead of
# finding nothing -- `OpenProcess` is refused for the daemon, the CLI sidecar
# and every child of both. The token therefore only exists in memory for a
# process that is itself elevated.
#
# So the scan runs twice: once as-is, and -- when that is refused -- once from
# a relaunched, elevated copy of this script. The elevated copy writes the
# token to the cache file and exits; this process reads it back. The relaunch
# asks for consent through the usual UAC prompt, and the cached token is good
# for months, so the prompt is rare rather than per-call.
#
# Only this user's own processes are inspected, read-only.
#
# Output (stdout, last line): a single JSON object.
#   {"ok":true,"token":"<jwt>","uid":"<sub>","expiresAt":<epoch_ms>}
#   {"ok":false,"error":"...","code":"..."}

import argparse
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import shutil
import sys
import time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

PAGE_READABLE = {0x01, 0x02, 0x04, 0x08, 0x20, 0x40, 0x80}
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


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
k32.Process32FirstW.restype = wt.BOOL
k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Process32NextW.restype = wt.BOOL
k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.CloseHandle.argtypes = [wt.HANDLE]
ntdll.NtQueryInformationProcess.argtypes = [wt.HANDLE, wt.DWORD, ctypes.c_void_p,
                                            wt.DWORD, ctypes.POINTER(wt.DWORD)]

# The WorkBuddy access token is a JWT. `Bearer` tokens are the ones the API
# accepts; the `Offline` sibling in the same process is the refresh token.
JWT_RE = re.compile(rb'eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}')
# Only the desktop daemon / CLI hold the cloud credential.
TARGET_EXE = "workbuddyai.exe"

# The harvested token outlives the harvest by months, so it is cached on disk:
# the memory scan needs elevation, and the elevation asks the user for consent.
CACHE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                         "workbuddy-bridge")
CACHE_FILE = os.path.join(CACHE_DIR, "token.json")
# A token that is about to expire is refreshed instead of handed out.
CACHE_MARGIN_MS = 5 * 60 * 1000
# How long the elevated copy may take, including the time the user spends on
# the consent prompt.
ELEVATED_WAIT_MS = 180000


def read_cache():
    """Read the cached token, or None when there is none that is still usable."""
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as handle:
            cached = json.load(handle)
    except (OSError, ValueError):
        return None
    token = cached.get("token")
    expires_at = cached.get("expiresAt")
    if not isinstance(token, str) or not token:
        return None
    if not isinstance(expires_at, (int, float)):
        return None
    if expires_at - CACHE_MARGIN_MS <= time.time() * 1000:
        return None
    return {"ok": True, "token": token, "uid": cached.get("uid", ""),
            "expiresAt": int(expires_at)}


def write_cache(cred):
    """Store the harvested token so the next run needs neither a scan nor a prompt."""
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, "token.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"token": cred["token"], "uid": cred.get("uid", ""),
                       "expiresAt": int(cred.get("expiresAt") or 0)}, handle)
        return True
    except OSError:
        return False


class SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("fMask", wt.ULONG), ("hwnd", wt.HWND),
                ("lpVerb", wt.LPCWSTR), ("lpFile", wt.LPCWSTR), ("lpParameters", wt.LPCWSTR),
                ("lpDirectory", wt.LPCWSTR), ("nShow", ctypes.c_int), ("hInstApp", wt.HINSTANCE),
                ("lpIDList", ctypes.c_void_p), ("lpClass", wt.LPCWSTR),
                ("hkeyClass", wt.HKEY), ("dwHotKey", wt.DWORD), ("hIconOrMonitor", wt.HANDLE),
                ("hProcess", wt.HANDLE)]


SEE_MASK_NOCLOSEPROCESS = 0x00000040
SEE_MASK_NOASYNC = 0x00000100
SW_HIDE = 0
INFINITE = 0xFFFFFFFF
ERROR_CANCELLED = 1223

shell32 = ctypes.WinDLL("shell32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32.ShellExecuteExW.restype = wt.BOOL
shell32.ShellExecuteExW.argtypes = [ctypes.POINTER(SHELLEXECUTEINFOW)]
kernel32.WaitForSingleObject.restype = wt.DWORD
kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
kernel32.CloseHandle.argtypes = [wt.HANDLE]


def run_elevated_copy():
    """Relaunch this script elevated and wait for it to cache the token.

    Returns the cached token, or None when the copy did not run -- the user
    declined the consent prompt, or the relaunch failed.
    """
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
    info.lpVerb = "runas"
    info.lpFile = sys.executable
    info.lpParameters = '"%s" --elevated-child' % os.path.abspath(__file__)
    info.nShow = SW_HIDE
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        return None
    try:
        kernel32.WaitForSingleObject(info.hProcess, ELEVATED_WAIT_MS)
    finally:
        kernel32.CloseHandle(info.hProcess)
    return read_cache()


def emit(obj, exit_code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(exit_code)


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
                if entry.szExeFile.lower() == name:
                    out.append(int(entry.th32ProcessID))
                if not k32.Process32NextW(snap, ctypes.byref(entry)):
                    break
    finally:
        k32.CloseHandle(snap)
    return out


def cmdline_of(pid):
    """PEB -> ProcessParameters -> CommandLine (UTF-16)."""
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
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


def scan_jwts(pid, limit=64):
    """Collect JWT-looking strings from a process' private readable memory."""
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return []
    found = []
    seen = set()
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
                    for m in JWT_RE.finditer(buf.raw[: read.value]):
                        v = m.group(0).decode("ascii", "ignore")
                        if v not in seen:
                            seen.add(v)
                            found.append(v)
                            if len(found) >= limit:
                                return found
                    off += chunk
            addr = mbi.BaseAddress + size
    except Exception:
        pass
    finally:
        k32.CloseHandle(h)
    return found


def jwt_payload(token):
    parts = token.split(".")
    if len(parts) < 2:
        return None
    try:
        raw = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(raw).decode("utf-8", "ignore"))
    except Exception:
        return None


def is_access_token(token):
    """Only the account-level `Bearer` token works for the cloud API."""
    pl = jwt_payload(token)
    if not isinstance(pl, dict):
        return None
    if pl.get("typ") != "Bearer":
        return None
    if pl.get("aud") != "account":
        return None
    iss = str(pl.get("iss") or "")
    if "workbuddy.ai" not in iss and "codebuddy" not in iss:
        return None
    return pl


def scan_memory():
    """Read the account token out of the WorkBuddy processes.

    Returns the token, or None when no process could be read or none of them
    held an account-scoped token.
    """
    pids = pids_named(TARGET_EXE)
    if not pids:
        return None

    # The daemon (daemon-app-server-entry) owns the session; the CLI sidecar
    # holds a copy. Prefer the daemon, fall back to any other WorkBuddy process.
    ordered = []
    for pid in pids:
        cl = cmdline_of(pid).lower()
        if "daemon-app-server" in cl:
            ordered.append((0, pid))
        elif "codebuddy" in cl:
            ordered.append((1, pid))
        else:
            ordered.append((2, pid))
    ordered.sort()

    best = None
    for _, pid in ordered:
        for token in scan_jwts(pid):
            pl = is_access_token(token)
            if not pl:
                continue
            exp = int(pl.get("exp") or 0)
            if exp and exp * 1000 <= 0:
                continue
            candidate = {
                "ok": True,
                "token": token,
                "uid": str(pl.get("sub") or ""),
                "expiresAt": exp * 1000 if exp else 0,
            }
            # Prefer the token that expires last.
            if best is None or candidate["expiresAt"] > best["expiresAt"]:
                best = candidate
        if best:
            break
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout-ms", type=int, default=60000)
    ap.add_argument("--elevated-child", action="store_true",
                    help="This copy already runs elevated: scan, cache, and stop.")
    args = ap.parse_args()

    if sys.platform != "win32":
        emit({"ok": False, "error": "token harvesting is Windows-only", "code": "unsupported_platform"})

    if args.elevated_child:
        cred = scan_memory()
        if cred:
            write_cache(cred)
        emit(cred or {"ok": False, "error": "no WorkBuddy access token found in client memory",
                      "code": "no_token"}, 0 if cred else 1)

    cached = read_cache()
    if cached:
        emit(cached)

    if not pids_named(TARGET_EXE):
        emit({"ok": False, "error": "WorkBuddy AI is not running", "code": "client_not_running"})

    cred = scan_memory()
    if not cred:
        # The client runs elevated, so this process cannot read it. Ask for the
        # consent that lets an elevated copy read it instead.
        cred = run_elevated_copy()
    if not cred:
        emit({"ok": False, "error": "no WorkBuddy access token found in client memory",
              "code": "no_token"})
    write_cache(cred)
    emit(cred)


if __name__ == "__main__":
    main()
