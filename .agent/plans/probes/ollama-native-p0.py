"""Ollama Phase 0 probes (plan ollama-native-context). Synthetic prompts only; local server."""
import json, sys, urllib.request, urllib.error
BASE = "http://127.0.0.1:11434"; MODEL = "qwen3:4b"
def call(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method or ("POST" if body else "GET"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode(errors="replace")[:300]
def ps():
    return [(m["name"], m.get("context_length")) for m in call("/api/ps")[1]["models"]]
def chat(**kw):
    body = {"model": MODEL, "stream": False}; body.update(kw); return call("/api/chat", body)
def brief(status, d):
    if not isinstance(d, dict): return {"status": status, "body": d}
    m = d.get("message") or {}
    return {"status": status, "error": d.get("error"), "done": d.get("done"), "done_reason": d.get("done_reason"),
            "prompt_eval_count": d.get("prompt_eval_count"), "eval_count": d.get("eval_count"),
            "tool_calls": m.get("tool_calls"), "thinking_len": len(m.get("thinking") or ""),
            "content": (m.get("content") or "")[:160]}
words = lambda n: "word " * n
TOOLS = [{"type": "function", "function": {"name": "get_row_count", "description": "Rows in a table",
          "parameters": {"type": "object", "properties": {"table": {"type": "string"}}, "required": ["table"]}}}]
USER = {"role": "user", "content": "How many rows are in orders and in customers? Call the tool once for each table, then give both numbers."}
out = {}
out["version"] = call("/api/version")
show = call("/api/show", {"model": MODEL})[1]
out["show_context_keys"] = {k: v for k, v in show.get("model_info", {}).items() if k.endswith(".context_length")}
out["4_prompt_overflow_truncate_false"] = brief(*chat(truncate=False, shift=False, think=False, options={"num_ctx": 4096, "num_predict": 5}, messages=[{"role": "user", "content": words(6000) + "count"}]))
out["5_prompt_overflow_default"] = brief(*chat(think=False, options={"num_ctx": 4096, "num_predict": 5}, messages=[{"role": "user", "content": words(6000) + "count"}]))
long_task = words(3400) + "\nWrite a very long story about databases, at least 2000 words."
out["6_output_overflow_shift_true"] = brief(*chat(truncate=False, shift=True, think=False, options={"num_ctx": 4096, "num_predict": 1500}, messages=[{"role": "user", "content": long_task}]))
out["7_output_overflow_shift_false"] = brief(*chat(truncate=False, shift=False, think=False, options={"num_ctx": 4096, "num_predict": 1500}, messages=[{"role": "user", "content": long_task}]))
out["ps_after_7"] = ps()
st, first = chat(truncate=False, shift=False, tools=TOOLS, options={"num_ctx": 8192, "num_predict": 1500}, messages=[USER])
out["8_tool_calls_default_think"] = brief(st, first)
asst = first["message"]; calls = asst.get("tool_calls") or []
counts = {"orders": 300, "customers": 50}
def results(with_ids, id_override=None):
    res = []
    for i, tc in enumerate(calls):
        table = tc["function"]["arguments"].get("table")
        msg = {"role": "tool", "tool_name": tc["function"]["name"], "content": json.dumps({"table": table, "rows": counts.get(table, 0)})}
        if with_ids: msg["tool_call_id"] = (id_override[i] if id_override else tc.get("id"))
        res.append(msg)
    return res
def strip_ids(m):
    m = json.loads(json.dumps(m))
    for tc in m.get("tool_calls") or []: tc.pop("id", None)
    return m
final = lambda asst_msg, res: brief(*chat(truncate=False, shift=False, options={"num_ctx": 8192, "num_predict": 800}, messages=[USER, asst_msg] + res))
out["9a_final_valid_ids_no_tools"] = final(asst, results(True))
out["9b_final_no_ids_anywhere_order_name"] = final(strip_ids(asst), results(False))
dup = json.loads(json.dumps(asst))
for tc in dup.get("tool_calls") or []: tc["id"] = "call_dup"
out["9c_final_duplicate_ids_results_without_ids"] = final(dup, results(False))
out["9d_final_valid_calls_results_without_ids"] = final(asst, results(False))
out["10_missing_model"] = brief(*chat(model="politedb-no-such-model:1b", messages=[{"role": "user", "content": "hi"}]))
json.dump(out, sys.stdout, indent=1)
