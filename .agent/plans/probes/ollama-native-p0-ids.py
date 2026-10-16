"""Phase 0 addendum: replay with invalid tool-call ids (synthetic)."""
import json, sys, urllib.request, urllib.error
BASE="http://127.0.0.1:11434"; MODEL="qwen3:4b"
def chat(body):
    b={"model":MODEL,"stream":False,"truncate":False,"shift":False,"options":{"num_ctx":8192,"num_predict":800}}; b.update(body)
    req=urllib.request.Request(BASE+"/api/chat",data=json.dumps(b).encode(),headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=600) as r: d=json.loads(r.read()); return r.status, d.get("done_reason"), (d.get("message") or {}).get("content","")[:120], d.get("error")
    except urllib.error.HTTPError as e: return e.code, None, None, e.read().decode(errors="replace")[:200]
USER={"role":"user","content":"How many rows are in orders? Call the tool."}
def asst(idval, include=True):
    tc={"function":{"index":0,"name":"get_row_count","arguments":{"table":"orders"}}}
    if include: tc["id"]=idval
    return {"role":"assistant","content":"","tool_calls":[tc]}
RES={"role":"tool","tool_name":"get_row_count","content":json.dumps({"rows":300})}
cases={"string ok":"call_abc","string with spaces":"bad id !","empty string":"","integer":123,"null":None,"object":{"x":1}}
out={k: chat({"messages":[USER,asst(v),RES]}) for k,v in cases.items()}
out["missing id"]=chat({"messages":[USER,asst(None,False),RES]})
out["result tool_call_id integer"]=chat({"messages":[USER,asst("call_abc"),dict(RES,tool_call_id=7)]})
for k,v in out.items(): print(f"{k:28} -> {v}")
