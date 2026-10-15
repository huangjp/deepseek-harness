"""
mitmproxy 插件：为 Microsoft Copilot 反代收割 (token + 请求模板)。

用法：
    mitmdump --listen-port 8082 \
             --mode upstream:http://127.0.0.1:7890 \
             --set upstream_cert=false \
             --allow-hosts 'cr\\.m365copilotapp\\.svc\\.cloud\\.microsoft|substrate\\.office\\.com|...' \
             --scripts token-harvester.py \
             -w copilot.flow

收割两样东西：
  1. Chathub WebSocket 的握手 URL —— 里面有 access_token、ConversationId、
     chatsessionid、X-SessionId、variants 等全部建连参数
  2. 客户端发出的第一条 target=chat 帧 —— 这是完整请求模板，含数百项
     optionsSets，直接复用可避免猜参数

输出：<out>/token.json（原子写，供 copilot-bridge 读取）
"""

import json
import os
import time
import tempfile
from urllib.parse import urlparse, parse_qs

OUT_DIR = os.path.expanduser(os.environ.get("COPILOT_HARVEST_DIR", "~/copilot-probe"))
OUT_FILE = os.path.join(OUT_DIR, "token.json")
LOG_FILE = os.path.join(OUT_DIR, "harvester.log")

state = {"token": None, "wsUrl": None, "template": None, "updatedAt": 0}


def log(msg):
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


def _load_existing():
    """把上一次收割到的 template 先读进内存。

    没有这一步会有一个隐蔽的破坏性 bug：token 刷新成功、但模板没抓到（例如
    帧解析失败）时，flush() 会把 state 整体写回文件，template 就变成 null，
    把上一次的好模板覆盖掉。模板变化很慢，保留旧的完全够用。
    """
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for key in ("template", "templateAt"):
                if data.get(key):
                    state[key] = data[key]
    except Exception:
        pass


def flush():
    """原子写，避免桥读到半截文件。"""
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=OUT_DIR, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, OUT_FILE)
    except Exception as e:
        log(f"flush failed: {e!r}")


def _iter_json_objects(text):
    """把一段文本里的连续 JSON 对象逐个解出来。

    Copilot 有时会把多个 JSON 对象拼在同一帧里发出来（实测出现过），
    直接 json.loads 会抛 `Extra data: line 1 column N`，模板就丢了。
    """
    dec = json.JSONDecoder()
    idx, n = 0, len(text)
    while idx < n:
        while idx < n and text[idx] in " \t\r\n":
            idx += 1
        if idx >= n:
            return
        try:
            obj, end = dec.raw_decode(text, idx)
        except ValueError:
            return
        yield obj
        idx = end


def request(flow):
    """握手请求是普通 HTTP GET(Upgrade)，在这里能拿到完整 URL。"""
    try:
        url = flow.request.pretty_url
    except Exception:
        return
    if "Chathub" not in url or "access_token=" not in url:
        return

    u = urlparse(url)
    q = parse_qs(u.query)

    def g(k):
        return (q.get(k) or [""])[0]

    token = g("access_token")
    if not token:
        return

    state["access_token"] = token
    state["wsUrl"] = url
    state["harvestedAt"] = time.time()
    state["params"] = {
        "host": u.netloc,
        "path": u.path,
        "chatsessionid": g("chatsessionid"),
        "XRoutingParameterSessionKey": g("XRoutingParameterSessionKey"),
        "clientrequestid": g("clientrequestid"),
        "X-SessionId": g("X-SessionId"),
        "ConversationId": g("ConversationId"),
        "variants": g("variants"),
        "source": g("source"),
        "product": g("product"),
        "agentHost": g("agentHost"),
        "licenseType": g("licenseType"),
        "isEdu": g("isEdu"),
        "agent": g("agent"),
        "scenario": g("scenario"),
    }
    log(f"token harvested len={len(token)} conversation={g('ConversationId')}")
    flush()


def websocket_message(flow):
    """抓客户端发出的 target=chat 帧，作为请求模板。"""
    try:
        msgs = flow.websocket.messages
        if not msgs:
            return
        m = msgs[-1]
        if not m.from_client:
            return
        body = m.content
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", "replace")

        # 一帧里可能拼了多个 JSON 对象，逐个找 target=chat
        found = None
        for obj in _iter_json_objects(body):
            if isinstance(obj, dict) and obj.get("target") == "chat":
                found = obj
                break
        if found is None:
            return

        state["template"] = found
        state["templateAt"] = time.time()
        n = 0
        try:
            n = len(found["arguments"][0].get("optionsSets") or [])
        except Exception:
            pass
        log(f"chat template captured optionsSets={n} len={len(body)}")
        flush()
    except Exception as e:
        log(f"ws hook error: {e!r}")


def done():
    flush()


_load_existing()
