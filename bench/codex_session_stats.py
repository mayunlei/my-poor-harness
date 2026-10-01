import json, os, sys, collections, re, glob
root = os.path.expanduser('~/.codex/sessions')
files = sorted(glob.glob(root + '/**/*.jsonl', recursive=True))
out = []
tool_bytes = collections.Counter(); tool_calls = collections.Counter()
cmd_kinds = collections.Counter(); cmd_kind_bytes = collections.Counter()
event_types = collections.Counter()
file_reread = collections.Counter()
outputs_over = collections.Counter()
first_cmd_token = re.compile(r'^\s*(?:cd\s+\S+\s*&&\s*)?([A-Za-z0-9_./-]+)')
def kind_of(cmd):
    m = first_cmd_token.match(cmd or '')
    k = m.group(1) if m else '?'
    k = os.path.basename(k)
    if k in ('sed','cat','head','tail','nl'): return 'read:'+k
    if k in ('rg','grep','find','ls','fd'): return 'search:'+k
    if k in ('python','python3','pytest','node','npm','pnpm','cargo','go','bash','sh','zsh'): return 'run:'+k
    if k == 'git': return 'git'
    if k in ('apply_patch',): return 'patch'
    return 'other:'+k
for fi, f in enumerate(files):
    s = dict(file=os.path.relpath(f, root), bytes=os.path.getsize(f), turns=0, user_msgs=0, asst_msgs=0, fcalls=0, reasoning_items=0, compactions=0,
             fc_out_bytes=0, fc_arg_bytes=0, asst_bytes=0, reasoning_bytes=0, user_bytes=0, dev_bytes=0, base_instr=0, agents_md=0,
             tools={}, max_ctx=0, peak_last_input=0, model=None, effort=None, originator=None, version=None, cwd=None,
             tok_in=0, tok_cached=0, tok_out=0, tok_reason=0, tok_total=0, n_tokcount=0, sum_last_input=0, sum_last_cached=0, sum_last_out=0,
             reads_same_file=0, big_outputs=0, truncated_outputs=0, images=0, web=0, first_ts=None, last_ts=None)
    seen_reads = collections.Counter()
    tools = collections.Counter(); tb = collections.Counter()
    try:
        with open(f, 'rb') as fh:
            for raw in fh:
                try: d = json.loads(raw)
                except Exception: continue
                t = d.get('type'); p = d.get('payload') or {}
                ts = d.get('timestamp')
                if ts:
                    s['first_ts'] = s['first_ts'] or ts; s['last_ts'] = ts
                pt = p.get('type') if isinstance(p, dict) else None
                event_types[(t, pt)] += 1
                if t == 'session_meta':
                    s['base_instr'] = len((p.get('base_instructions') or {}).get('text', ''))
                    s['originator'] = p.get('originator'); s['version'] = p.get('cli_version'); s['cwd'] = p.get('cwd')
                elif t == 'turn_context':
                    s['model'] = p.get('model') or s['model']
                    s['effort'] = (p.get('collaboration_mode') or {}).get('settings', {}).get('reasoning_effort') or p.get('effort') or s['effort']
                elif t == 'compacted' or pt in ('compacted', 'context_compacted'):
                    s['compactions'] += 1
                elif t == 'event_msg':
                    if pt == 'task_started':
                        s['turns'] += 1; s['max_ctx'] = p.get('model_context_window') or s['max_ctx']
                    elif pt == 'token_count':
                        info = p.get('info') or {}
                        tu = info.get('total_token_usage') or {}
                        lu = info.get('last_token_usage') or {}
                        s['n_tokcount'] += 1
                        s['tok_in'] = tu.get('input_tokens', s['tok_in']); s['tok_cached'] = tu.get('cached_input_tokens', s['tok_cached'])
                        s['tok_out'] = tu.get('output_tokens', s['tok_out']); s['tok_reason'] = tu.get('reasoning_output_tokens', s['tok_reason'])
                        s['tok_total'] = tu.get('total_tokens', s['tok_total'])
                        li = lu.get('input_tokens', 0) or 0
                        s['peak_last_input'] = max(s['peak_last_input'], li)
                        s['sum_last_input'] += li; s['sum_last_cached'] += lu.get('cached_input_tokens', 0) or 0; s['sum_last_out'] += lu.get('output_tokens', 0) or 0
                elif t == 'response_item':
                    if pt == 'message':
                        role = p.get('role')
                        txt = ''.join((c.get('text') or '') for c in (p.get('content') or []) if isinstance(c, dict))
                        if any(isinstance(c, dict) and c.get('type') == 'input_image' for c in (p.get('content') or [])): s['images'] += 1
                        if role == 'user':
                            if txt.startswith('# AGENTS.md') or txt.startswith('<INSTRUCTIONS>') or '<INSTRUCTIONS>' in txt[:200]:
                                s['agents_md'] += len(txt)
                            elif txt.startswith('<environment_context>') or txt.startswith('<user_instructions>') or txt.startswith('<turn_aborted>'):
                                s['dev_bytes'] += len(txt)
                            else:
                                s['user_msgs'] += 1; s['user_bytes'] += len(txt)
                        elif role == 'assistant':
                            s['asst_msgs'] += 1; s['asst_bytes'] += len(txt)
                        elif role == 'developer':
                            s['dev_bytes'] += len(txt)
                    elif pt == 'reasoning':
                        s['reasoning_items'] += 1
                        s['reasoning_bytes'] += sum(len(x.get('text','')) for x in (p.get('summary') or []) if isinstance(x, dict))
                        s['reasoning_bytes'] += sum(len(x.get('text','')) for x in (p.get('content') or []) if isinstance(x, dict))
                    elif pt in ('function_call', 'custom_tool_call'):
                        s['fcalls'] += 1
                        name = p.get('name'); tools[name] += 1
                        args = p.get('arguments') or p.get('input') or ''
                        s['fc_arg_bytes'] += len(args)
                        if name in ('exec_command', 'shell', 'shell_command', 'container.exec'):
                            try:
                                a = json.loads(args) if isinstance(args, str) else args
                                cmd = a.get('cmd') or a.get('command')
                                if isinstance(cmd, list): cmd = ' '.join(cmd)
                            except Exception: cmd = args if isinstance(args, str) else ''
                            k = kind_of(cmd); cmd_kinds[k] += 1
                            if k.startswith('read:'):
                                m = re.search(r"(\S+\.(?:py|ts|tsx|js|md|json|toml|yaml|yml|txt|rs|go|java|sql|html|css))\b", cmd or '')
                                if m:
                                    seen_reads[m.group(1)] += 1
                            s['_lastkind'] = k
                        elif name == 'web_search' or name == 'web.run': s['web'] += 1
                    elif pt in ('function_call_output', 'custom_tool_call_output'):
                        o = p.get('output')
                        if isinstance(o, list): o = ''.join(str(x.get('text','')) if isinstance(x, dict) else str(x) for x in o)
                        o = o or ''
                        s['fc_out_bytes'] += len(o)
                        if len(o) > 20000: s['big_outputs'] += 1
                        if 'truncated' in o[:300].lower() or 'Original token count' in o[:200] and 'truncated' in o.lower(): s['truncated_outputs'] += 1
                        k = s.get('_lastkind')
                        if k: cmd_kind_bytes[k] += len(o)
                    s_tools_last = None
    except Exception as e:
        s['err'] = str(e)
    s['reads_same_file'] = sum(v - 1 for v in seen_reads.values() if v > 1)
    s['tools'] = dict(tools)
    s.pop('_lastkind', None)
    for k, v in tools.items(): tool_calls[k] += v
    out.append(s)
    if fi % 200 == 0: print(fi, file=sys.stderr)
json.dump(dict(sessions=out, tool_calls=dict(tool_calls), cmd_kinds=dict(cmd_kinds), cmd_kind_bytes=dict(cmd_kind_bytes),
               event_types={str(k): v for k, v in event_types.items()}), open(sys.argv[1], 'w'))
