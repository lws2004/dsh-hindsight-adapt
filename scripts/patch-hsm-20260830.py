#!/usr/bin/env python3
"""一次性修补 ~/.hindsight/harness-memory.sh:
1. recall 支持自定义类型(skill/procedure/l1_trace): 服务端 types 仅认三态, 其余结果侧过滤
2. 新增 skill-crystallize 子命令: procedure→LLM 结晶指令块→存回 type:skill
每处替换前断言唯一性; 全部断言通过才写盘。幂等: 已修补内容再次运行会因断言失败退出。"""
import sys

PATH = "/Users/lanws/.hindsight/harness-memory.sh"

repls = []

# A. 头部 usage 注释
repls.append(("usage-skill",
'''#   hs-memory consolidate [--scope project|global|self|--bank B]   # 触发库整合(去重/矛盾)
#   hs-memory session-end [transcript|--file P]     # 会话收尾: 兜底 curate + 整合 OWN/global
#   hs-memory list-banks
''',
'''#   hs-memory consolidate [--scope project|global|self|--bank B]   # 触发库整合(去重/矛盾)
#   hs-memory session-end [transcript|--file P]     # 会话收尾: 兜底 curate + 整合 OWN/global
#   hs-memory list-banks
#   hs-memory skill-crystallize [--bank B|--scope S] [--topic 主题] [--min N] [--dry-run]
#                                        # procedure→指令块结晶(库里同主题 procedure < N 条自动跳过; 产物 recall --types skill 精确召回)
'''))

# B. CUSTOM_TYPE_SET 常量
repls.append(("custom-types",
'''OWN_BANK="${HINDSIGHT_OWN_BANK:-}"     # 调用方声明的"我的独占库"(可选)
''',
'''OWN_BANK="${HINDSIGHT_OWN_BANK:-}"     # 调用方声明的"我的独占库"(可选)
# 自定义召回类型: 服务端 types 仅认 world/experience/observation;
# skill/procedure/l1_trace 等自定义类型按结果侧 context/tags 客户端过滤(recall 与 skill-crystallize 共用)
CUSTOM_TYPE_SET=" skill procedure l1_trace "
'''))

# C. recall_text 增加客户端类型过滤
repls.append(("recall-text-filter",
'''# ── 多库检索, 输出结果行(带 [库名] 来源标注) ────────────
recall_text() {  # targets(空格分隔) query top [types] [prefer-obs]
  local targets="$1" query="$2" top="$3" types="${4:-}" prefer_obs="${5:-true}"
  [ -n "$targets" ] || return 0
  python3 - "$targets" "$query" "$top" "$types" "$prefer_obs" <<'EOF'
import json,sys,urllib.request,urllib.parse
banks,query,top,types_raw,prefer_obs=sys.argv[1:6]
banks=banks.split()
types=[t.strip() for t in types_raw.split(",") if t.strip()] if types_raw else []
MAX_PER_BANK=max(1,int(top)//len(banks))
for bank in banks:
    if not bank: continue
    body={"query":query,"max_tokens":MAX_PER_BANK*400}
    if types:
        body["types"]=types
    # prefer_observations=True: observation 会替换其来源原始事实(world/experience),
    # 避免同一记忆同时召回 observation + world 两条重复记录。仅当同时召回两类时才有意义;
    # --prefer-obs false 可显式关闭(召回 both 原始事实+observation 原样并列时)。
    if str(prefer_obs).lower() != 'false':
        body["prefer_observations"]=True
    url=f"http://localhost:8888/v1/default/banks/{urllib.parse.quote(bank,safe='')}/memories/recall"
    try:
        req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"},method="POST")
        r=urllib.request.urlopen(req,timeout=60)
        j=json.load(r)
        for res in j.get("results",[])[:MAX_PER_BANK]:
            text=res.get("text","").replace("\\n"," ")
            print(f"[{bank}] ({res.get('type','?')}) {text[:240]}")
    except Exception as e:
        print(f"  ⚠️ 检索 [{bank}] 失败: {e}", file=sys.stderr)
EOF
}
''',
'''# ── 多库检索, 输出结果行(带 [库名] 来源标注) ────────────
# 参数: targets query top [types] [prefer-obs] [filter-types]
#   filter-types: 自定义类型(skill/procedure/...), 按结果侧 context/tags 客户端过滤
#   (服务端 types 仅认 world/experience/observation, 自定义类型需全量召回后过滤)
recall_text() {
  local targets="$1" query="$2" top="$3" types="${4:-}" prefer_obs="${5:-true}" filter="${6:-}"
  [ -n "$targets" ] || return 0
  python3 - "$targets" "$query" "$top" "$types" "$prefer_obs" "$filter" <<'EOF'
import json,sys,urllib.request,urllib.parse
banks,query,top,types_raw,prefer_obs,filter_raw=sys.argv[1:7]
banks=banks.split()
types=[t.strip() for t in types_raw.split(",") if t.strip()] if types_raw else []
filter_types=[t.strip() for t in filter_raw.split(",") if t.strip()] if filter_raw else []
MAX_PER_BANK=max(1,int(top)//len(banks))
def matches_filter(res):
    if not filter_types: return True
    ctx=res.get("context","") or ""
    tags=[str(x) for x in (res.get("tags") or [])]
    for ft in filter_types:
        if ("type:"+ft) in ctx or ft in tags: return True
    return False
for bank in banks:
    if not bank: continue
    body={"query":query,"max_tokens":MAX_PER_BANK*400}
    if types:
        body["types"]=types
    # prefer_observations=True: observation 会替换其来源原始事实(world/experience),
    # 避免同一记忆同时召回 observation + world 两条重复记录。仅当同时召回两类时才有意义;
    # --prefer-obs false 可显式关闭(召回 both 原始事实+observation 原样并列时)。
    if str(prefer_obs).lower() != 'false':
        body["prefer_observations"]=True
    url=f"http://localhost:8888/v1/default/banks/{urllib.parse.quote(bank,safe='')}/memories/recall"
    try:
        req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"},method="POST")
        r=urllib.request.urlopen(req,timeout=60)
        j=json.load(r)
        kept=0
        for res in j.get("results",[]):
            if not matches_filter(res): continue
            text=res.get("text","").replace("\\n"," ")
            print(f"[{bank}] ({res.get('type','?')}) {text[:240]}")
            kept+=1
            if kept>=MAX_PER_BANK: break
    except Exception as e:
        print(f"  ⚠️ 检索 [{bank}] 失败: {e}", file=sys.stderr)
EOF
}
'''))

# D. recall 命令: 拆分自定义类型
repls.append(("recall-types-split",
'''    [ -n "$targets" ] || { echo "无可查询的库(检查 scope/OWN_BANK)"; exit 2; }
    echo "⟳ 检索库: $(echo $targets | tr ' ' ',')"
    recall_text "$targets" "$query" "$top" "$types" "${prefer_obs:-true}"
''',
'''    [ -n "$targets" ] || { echo "无可查询的库(检查 scope/OWN_BANK)"; exit 2; }
    echo "⟳ 检索库: $(echo $targets | tr ' ' ',')"
    # 拆分自定义类型(skill/procedure/l1_trace): 服务端 types 仅认三态, 其余走客户端过滤
    svc_types=""; filt_types=""
    for t in $(echo "$types" | tr ',' ' '); do
      case "$CUSTOM_TYPE_SET" in
        *" $t "*) [ -n "$filt_types" ] && filt_types="$filt_types,$t" || filt_types="$t" ;;
        *) [ -n "$svc_types" ] && svc_types="$svc_types,$t" || svc_types="$t" ;;
      esac
    done
    recall_text "$targets" "$query" "$top" "$svc_types" "${prefer_obs:-true}" "$filt_types"
'''))

# E. skill-crystallize 命令(插在 session-end 前)
repls.append(("skill-crystallize-cmd",
'''  session-end)
    # 会话收尾(多 agent 复用): 兜底 curate(如有转录) + 整合 OWN 与 global
''',
'''  skill-crystallize)
    # procedure→指令块结晶(共享能力, 2026-08-30 下沉): 检索目标库 procedure 类记忆
    # → LLM 归纳为可执行指令块(按主题分组/单主题)→ 存回 type:skill
    # (同主题 doc_id 覆盖; recall --types skill 可精确召回)。任一 agent 可调用。
    bank=""; scope=""; topic=""; min="3"; dry=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --bank) bank="$2"; shift 2 ;;
        --scope) scope="$2"; shift 2 ;;
        --topic) topic="$2"; shift 2 ;;
        --min) min="$2"; shift 2 ;;
        --dry-run) dry="1"; shift ;;
        *) echo "未知参数: $1 (--bank|--scope|--topic|--min|--dry-run)"; exit 2 ;;
      esac
    done
    case "$scope" in
      project) bank="repo" ;;
      global) bank="global" ;;
      self) [ -n "$OWN_BANK" ] && bank="$OWN_BANK" || { echo "ERROR: --scope self 需要声明 HINDSIGHT_OWN_BANK"; exit 2; } ;;
      "") ;;
      *) echo "未知 scope: $scope (project|global|self)"; exit 2 ;;
    esac
    target=$(resolve_bank "$bank") || exit 2
    # 写权限校验: 结晶产物只落 项目库/global/OWN_BANK(感知到其他 agent 库只读, 拒绝结晶写入)
    resolve_bank "$target" write >/dev/null 2>&1 || { echo "ERROR: $target 不可写(结晶产物只允许 项目库/global/OWN_BANK)"; exit 2; }
    [ "$min" -ge 1 ] 2>/dev/null || min=3
    echo "⟳ 结晶中 [$target] (procedure→skill, 主题: ${topic:-自动分组}, 阈值: $min 条)..."
    python3 - "$target" "$CURATOR_BASE_URL" "$CURATOR_API_KEY" "$CURATOR_MODEL" "$topic" "$min" "$dry" <<'PYEOF'
import json,sys,urllib.request,urllib.parse,re
target,base,key,model,topic,min_s,dry=sys.argv[1:8]
api=urllib.parse.quote(target,safe='')
SECRET=re.compile(r"sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{20,}")
def post(path,body,timeout=90):
    url="http://localhost:8888"+path
    req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"},method="POST")
    return json.load(urllib.request.urlopen(req,timeout=timeout))
def raw_llm(prompt, timeout=120):
    body={"model":model,"messages":[{"role":"user","content":prompt}],"max_tokens":3000,"temperature":0,"chat_template_kwargs":{"enable_thinking":False}}
    if "deepseek" in base:
        body["thinking_level"]="low"
    req=urllib.request.Request(f"{base}/chat/completions",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":f"Bearer {key}"},method="POST")
    return json.load(urllib.request.urlopen(req,timeout=timeout))["choices"][0]["message"]["content"]
def store_mem(content,tags,doc):
    if SECRET.search(content):
        print("  ⚠️ 含疑似密钥, 拒绝存储", file=sys.stderr); return
    item={"content":content,"tags":[t for t in tags.split(",") if t]}
    if doc: item["document_id"]=doc
    body={"items":[item],"async":False}
    try:
        r=post(f"/v1/default/banks/{api}/memories",body)
        print(f"  ✅ 已存 skill [{target}] doc={doc} (items={r.get('items_count',1)})")
    except Exception as e:
        print(f"  ❌ 存回失败: {e}", file=sys.stderr)
# 1. 检索: 服务端 types 不支持 procedure, 全量召回后按 context/tags 客户端过滤
try:
    r=post(f"/v1/default/banks/{api}/memories/recall",{"query":(topic.strip() or "procedure 操作步骤 SOP 工作流"),"max_tokens":8000})
    results=r.get("results",[]) or []
except Exception as e:
    print(f"❌ 检索失败: {e}", file=sys.stderr); sys.exit(1)
procs=[]; seen=set()
for res in results[:80]:
    ctx=res.get("context","") or ""
    tags=[str(x) for x in (res.get("tags") or [])]
    if not (("type:procedure" in ctx) or ("procedure" in tags)): continue
    text=(res.get("text","") or "").replace("\n"," ").strip()
    if not text or text in seen: continue
    seen.add(text); procs.append(text[:400])
if len(procs) < int(min_s):
    print(f"(procedure 仅 {len(procs)} 条 < 阈值 {min_s}; 跳过结晶, 零散 procedure 由 curate 继续积累)")
    sys.exit(0)
# 2. LLM 结晶
if topic.strip():
    sys_prompt=("你是技能结晶器。把以下操作步骤(procedure)记忆归纳成一条可复用的技能指令块(SOP)。\n"
                "要求: 指令具体可执行(含适用场景/前置条件/步骤/注意事项), 不要泛泛而谈。\n"
                "严格只输出 JSON 对象, 无解释文字:\n{\"name\":\"技能名\",\"instructions\":\"完整指令文本\"}")
    raw=raw_llm(sys_prompt+"\n\n主题: "+topic+"\nprocedure 列表(JSON):\n"+json.dumps(procs,ensure_ascii=False))
    raw=raw.replace("```json","").replace("```","").strip()
    lo,hi=raw.find("{"),raw.rfind("}")
    skills=[]
    if lo>=0 and hi>lo:
        try:
            d=json.loads(raw[lo:hi+1]); d["topic"]=topic.strip(); skills=[d]
        except Exception: pass
else:
    sys_prompt=("你是技能结晶器。把以下操作步骤(procedure)记忆按主题分组归纳成可复用的技能指令块。\n"
                "相同主题的 procedure 合并为一个 skill; 不同主题分别结晶(最多 3 个)。\n"
                "要求: 指令具体可执行(含适用场景/前置条件/步骤/注意事项), 不要泛泛而谈。\n"
                "严格只输出 JSON 数组, 无解释文字:\n[{\"name\":\"技能名\",\"topic\":\"主题\",\"instructions\":\"完整指令文本\"}]")
    raw=raw_llm(sys_prompt+"\n\nprocedure 列表(JSON):\n"+json.dumps(procs,ensure_ascii=False))
    raw=raw.replace("```json","").replace("```","").strip()
    lo,hi=raw.find("["),raw.rfind("]")
    skills=[]
    if lo>=0 and hi>lo:
        try:
            skills=[d for d in json.loads(raw[lo:hi+1]) if isinstance(d,dict) and d.get("instructions")]
        except Exception: pass
if not skills:
    print("(LLM 结晶失败或无新技能产出)"); sys.exit(0)
# 3. 存回
if dry=="1":
    for s in skills[:3]:
        print(f"[dry-run] 技能: {s.get('name','?')} | 主题: {s.get('topic','')}\n  {s.get('instructions','')[:200]}...")
    sys.exit(0)
for s in skills[:3]:
    name=(s.get("name","") or "").strip() or "技能"
    instructions=(s.get("instructions","") or "").strip()
    tp=(s.get("topic","") or "").strip() or topic.strip() or name
    if not instructions: continue
    store_mem(f"技能: {name} | 适用场景: {tp}\n\n{instructions}", f"skill,{name}", f"skill:{tp}")
PYEOF
    ;;

  session-end)
    # 会话收尾(多 agent 复用): 兜底 curate(如有转录) + 整合 OWN 与 global
'''))

# F. help 文本
repls.append(("help-text",
'''    echo "  inject  <prompt> [--mode intent|light] [--max N]  注入块(自动模式: 意图词→intent, 短消息不注入)"
    echo "  session-end [transcript]     会话收尾: 兜底 curate + 整合 OWN/global"
''',
'''    echo "  inject  <prompt> [--mode intent|light] [--max N]  注入块(自动模式: 意图词→intent, 短消息不注入)"
    echo "  session-end [transcript]     会话收尾: 兜底 curate + 整合 OWN/global"
    echo "  skill-crystallize [--bank B|--scope S] [--topic 主题] [--min N] [--dry-run]  procedure→指令块结晶(recall --types skill 精确召回)"
'''))

def main():
    with open(PATH, encoding="utf-8") as f:
        text = f.read()
    # 第一遍: 断言全部唯一
    for label, old, _new in repls:
        n = text.count(old)
        if n != 1:
            print(f"断言失败 [{label}]: 目标文本出现 {n} 次(期望 1), 中止, 未写盘", file=sys.stderr)
            sys.exit(1)
    # 第二遍: 按出现顺序替换
    for label, old, new in repls:
        text = text.replace(old, new, 1)
        print(f"✓ [{label}] 已替换")
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(text)
    print("完成: 全部替换已写入")

if __name__ == "__main__":
    main()