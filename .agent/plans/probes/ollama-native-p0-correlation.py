"""Phase 0: result correlation without ids, results carry only numbers (synthetic)."""
import json, sys, urllib.request
BASE="http://127.0.0.1:11434"; MODEL="qwen3:4b"
def chat(body):
    b={"model":MODEL,"stream":False,"truncate":False,"shift":False,"options":{"num_ctx":8192,"num_predict":1500}}; b.update(body)
    req=urllib.request.Request(BASE+"/api/chat",data=json.dumps(b).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=600) as r: return json.loads(r.read())
TOOLS=[{"type":"function","function":{"name":"get_row_count","description":"Rows in a table","parameters":{"type":"object","properties":{"table":{"type":"string"}},"required":["table"]}}}]
USER={"role":"user","content":"How many rows are in orders and in customers? Call the tool once for each table, then give both numbers."}
first=chat({"tools":TOOLS,"messages":[USER]}); asst=first["message"]; calls=asst.get("tool_calls") or []
order=[c["function"]["arguments"]["table"] for c in calls]
truth={"orders":300,"customers":50}
def strip(m):
    m=json.loads(json.dumps(m)); [tc.pop("id",None) for tc in m.get("tool_calls") or []]; return m
def run(label, asst_msg, values, ids):
    res=[]
    for i,(c,v) in enumerate(zip(calls,values)):
        r={"role":"tool","tool_name":"get_row_count","content":json.dumps({"rows":v})}
        if ids: r["tool_call_id"]=c.get("id")
        res.append(r)
    d=chat({"messages":[USER,asst_msg]+res})
    return {"case":label,"values_sent_in_call_order":values,"prompt_eval_count":d.get("prompt_eval_count"),"answer":d["message"].get("content","")[:200]}
correct=[truth[t] for t in order]
out={"call_order":order,"native_ids":[c.get("id") for c in calls],
 "cases":[run("no ids, correct order",strip(asst),correct,False),
          run("no ids, SWAPPED order",strip(asst),list(reversed(correct)),False),
          run("valid ids, correct order",asst,correct,True)]}
json.dump(out,sys.stdout,indent=1)
