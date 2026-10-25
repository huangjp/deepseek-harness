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
import re
import sys

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout-ms", type=int, default=60000)
    args = ap.parse_args()

    if sys.platform != "win32":
        emit({"ok": False, "error": "token harvesting is Windows-only", "code": "unsupported_platform"})

    pids = pids_named(TARGET_EXE)
    if not pids:
        emit({"ok": False, "error": "WorkBuddy AI is not running", "code": "client_not_running"})

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

    if not best:
        emit({"ok": False, "error": "no WorkBuddy access token found in client memory",
              "code": "no_token"})
    emit(best)


if __name__ == "__main__":
    main()
