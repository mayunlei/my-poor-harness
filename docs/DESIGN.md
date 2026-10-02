# Token Harness 设计稿 v0.3

> 多轮会话、记忆、Skill 与 CLI 的下一阶段设计见 [MEMORY_DESIGN.md](MEMORY_DESIGN.md)。

> 目标：做一个给编码 agent 用的 harness，把完成同样任务所需的 token 降一个数量级。
> 先服务 Codex（Desktop / CLI），再做成自有循环，兼容 Claude Code 等客户端。
> 日期：2026-10-01。数据来源：本机 2128 个 Codex 会话（2026-03 至 2026-10），`~/.codex/sessions`。

---

## 0. 结论先行

1. Codex 贵，不是因为模型输出多（7200 万输出 token），而是因为每一步都把 10 万到 24 万 token 的历史重新发一遍（169 亿输入 token）。
2. 一个 turn 的输入成本 ≈ `n × C0 + n² / 2 × (o + a)`。`C0` 是 turn 开始时携带的历史（均值 9.4 万），`n` 是步数（均值 29），`o + a` 是每步新增（约 1.4K）。**第一项占大头**，所以最有效的手段是：每个 turn 重建上下文，不携带原始历史；其次是减少步数（砍空轮询、重复读、重复命令）；再次是限制每步新增。
3. 代入本机数据，三类手段叠加后，普通 turn 从 330 万 token 降到约 30 万，重 turn 从 1040 万降到约 85 万，批量任务用 map-reduce 可以降 30 倍以上。
4. 实现路线分三层：`ctx-core`（纯函数库，可用 2128 条历史会话离线回放验证）→ `ctx-proxy`（挂在现有 `codex_api` 的 `/v1/responses` 上，Codex Desktop 立刻受益）→ `harness`（自有执行循环，解决轮询、fork/merge、map-reduce）。不建议一上来就 fork Rust 版 codex。
5. 必须守住 4 月 SWE-bench 消融的教训：截断和压缩会掉准确率（F4、F6、P3 都被拒绝）。压缩只能动"确定无用"的部分，并保留失败关键字段（失败命令、异常类型、断言 diff、traceback 尾部），且任何压缩都要给模型一个 `recall(id)` 的找回路径。

---

## 1. 诉求整理

| # | 诉求 | 来源 | 优先级 |
|---|---|---|---|
| R1 | 上下文压缩：把大块内容外置成文件，内部只留引用或摘要 | 用户；agentic_agent 的 ID-first external memory | P0 |
| R2 | 轮询控制：Codex 等后台任务时一秒一轮询，每轮带全量上下文 | 用户；数据：空轮询占输入 8%，轮询类合计约 20% | P0 |
| R3 | 会话 fork 之后能 merge 回主线 | 用户；Codex 只有 `forked_from_id`，无 merge | P1 |
| R4 | 多客户端：Codex Desktop / CLI / Claude Code 等都能用 | 用户 | P1 |
| R5 | 可量化：先用公式推导能省多少，再用真实轨迹验证 | 用户；4 月复盘"score 是 loss，trajectory 是 gradient" | P0 |
| R6 | 不掉任务成功率 | 4 月消融结论 | P0 约束 |
| R7 | 可以基于开源 Codex 开发 | 用户 | 可选路线 |

非目标（v0.1 不做）：沙箱安全（见 `../cc/DESIGN.md`）、多 agent 搜索、记忆治理系统（v2 context kernel 那套，复盘已否决）。

---

## 2. 数据证据（摘要）

| 指标 | 数值 |
|---|---|
| 会话数 / 输入 token / 输出 token | 2128 / 169 亿 / 7200 万 |
| 缓存命中率 | 95%（但周限额仍被打满，说明限额不按缓存打折，或打折不够） |
| 工具调用总数 / 模型响应数 | 16.9 万 / 14.6 万（基本一次响应一个调用，很少并行） |
| 上下文 >10 万时发送的输入占比 | 84% |
| 每 turn 步数 mean / p50 / p90 | 29 / 12 / 72 |
| turn 开始时上下文 mean / p50 / p90 | 9.4 万 / 8.0 万 / 19.8 万 |
| 每步模型输出 mean / p50 | 570 / 241 |
| 工具输出 bytes mean / p50 / p90 | 3.4KB / 474B / 9.9KB |
| 输出 >10KB 的调用占比 / 占总输出字节 | 10% / 61% |
| write_stdin 轮询 / 其中返回空 | 3.3 万 / 1.6 万 |
| 文件读取 / 其中是重复读同一文件 | 2.9 万 / 1.45 万 |
| 同会话内原样重跑的命令 | 1.1 万（12%） |
| 固定提示（系统 + Desktop 开发者块 + 权限） | 约 60KB ≈ 1.5 万 token，每次请求都带 |
| 压缩触发点 / 压缩后 / 再涨回的步数 | 22.5 万 / 3.1 万 / 139 步 |
| 一晚三个 SP500 批量会话 | 各 1100 步、3.3 亿 token；对比 `codex exec` 单条目会话 823 个合计 2900 万 |

---

## 3. Token 算术模型

### 3.1 符号

- `F`：固定前缀（系统提示 + 工具定义 + 开发者指令）。Codex 现状 ≈ 15K。
- `S`：turn 开始时的状态摘要（目标、已做决定、改过的文件、证据索引）。目标 ≤ 3K。
- `H`：turn 开始时携带的原始历史。Codex 现状 `C0 = F + H` 均值 94K。
- `n`：一个 turn 内的模型响应次数（≈ 工具调用次数 + 1）。
- `o_i`：第 i 步工具输出进入上下文的 token；`a_i`：第 i 步模型输出（reasoning 摘要 + 调用参数 + 评论）回灌到上下文的 token。
- `c_i`：第 i 步的输入上下文 = `C0 + Σ_{j<i} (o_j + a_j)`。

### 3.2 一个 turn 的总输入

```
T_in(turn) = Σ_{i=1..n} c_i
           = n·C0 + Σ_{i=1..n} Σ_{j<i} (o_j + a_j)
           ≈ n·C0 + n(n-1)/2 · (ō + ā)        （均匀近似）
```

代入本机均值：`n=29, C0=94K, ō=850, ā=570`：

```
T_in ≈ 29 × 94K + 406 × 1.42K ≈ 2.73M + 0.58M ≈ 3.3M
```

与实测 "每 turn 输入均值 290 万" 吻合。重 turn（p90，`n=72`）：`72×94K + 2556×1.42K ≈ 6.8M + 3.6M ≈ 10.4M`。

**读法**：第一项 `n·C0` 是"拖着历史走"的代价，占 70% 到 85%。第二项是本 turn 内部的二次增长，`n` 大时才明显。

### 3.3 四个杠杆

| 杠杆 | 作用于 | 手段 | 预期 |
|---|---|---|---|
| L1 降 `C0` | `n·C0` | 每 turn 从 `F' + S` 重建，不带原始历史；`F` 从 15K 砍到 4K | `C0`: 94K → 8K |
| L2 降 `n` | 两项都受益 | 阻塞等待取代轮询（-20%）；读缓存去重（-9%）；幂等命令缓存（-5%）；允许一次响应多个调用 | `n`: 29 → 18 |
| L3 限 `o_i` | 二次项 | 单次输出上限 2K；超过的落盘给 id；窗口 `W` 之外的输出折叠成 ≈ 30 token 的存根 | 二次项变线性 |
| L4 降 `a_i` | 二次项 | 旧的 reasoning item 不回灌；评论不单独成一次响应；effort 按步骤设置 | `ā`: 570 → 400 |

带窗口 `W` 的 turn 内增长：

```
Σ_{j<i} (o_j + a_j)  →  min(i, W)·(ō' + ā') + max(0, i−W)·(stub + call)
```

### 3.4 代入后的估算

参数：`C0' = 8K, n' = 18, W = 10, ō' = 600, ā' = 400, stub+call = 80`。

```
普通 turn:  18×8K + Σ_{i≤10} i×1.0K + Σ_{i=11..18} [10×1.0K + (i−10)×80]
          ≈ 144K + 55K + (80K + 2.9K) ≈ 282K        vs 3.3M   → 约 11×
重 turn:    n'=45: 45×8K + 55K + (35×10K + 630×80) ≈ 360K + 55K + 400K ≈ 815K   vs 10.4M → 约 12×
批量任务:   每个条目独立上下文（map-reduce），父上下文只收 ≤ 500 token 摘要。
            SP500 一晚 10 亿 → 每条目约 30 万 × 503 ≈ 1.5 亿，再加父级 ≈ 1.6 亿 → 约 6×；
            条目内再做 L1-L4 → 再除 3 到 5。
```

这些是上界估计。实际会被两件事侵蚀：模型因为看不到原文而多做 `recall`（每次 ≈ 一步），以及压缩后准确率下降导致重试。所以 R6 的基准测试不是可选项。

### 3.5 缓存经济学（调研 + 实测 + 回放模拟）

**官方规则（2026-10 查证）**

| 项目 | 规则 | 来源 |
|---|---|---|
| 缓存读价格 | uncached 的 0.1×（GPT-6.1 Sol 为 0.05×） | OpenAI prompt caching 文档 |
| 缓存写价格 | GPT-5.6 及之后：1.25× uncached；Codex 订阅积分"无单独缓存写费用" | 同上；ChatGPT pricing 页 |
| 命中条件 | 整个前缀完全一致：model、tools（名称、描述、schema、顺序）、`reasoning.effort`、`text.verbosity`、`parallel_tool_calls`、`context_management`；只能追加，不能改写 | 同上 |
| 失效 | 改写历史、compaction、改任何上述设置、过期 | 同上 |
| 生命周期 | GPT-5.6+：最近一次使用后 30 分钟；旧模型 in_memory 5-10 分钟或 24h 保留 | 同上 |
| 显式断点 | GPT-5.6+ 支持 `prompt_cache_breakpoint`，explicit-only 模式可避免对易变后缀做缓存写 | 同上 |
| 限额口径 | API 的 TPM 把 cached 全额计入；ChatGPT 订阅自 2026-04 改为按 token 计积分，cached 按约 0.1× 计（GPT-5.3-Codex：43.75 vs 4.375 积分/百万） | Codex rate card；GitHub #2251 无官方公式 |
| 官方提示 | "extended sessions that require the agent to hold more context will use significantly more per message" | ChatGPT pricing 页 |

**本机实测（14.4 万次响应）**

| 位置 / 间隔 | 未缓存占比 | 说明 |
|---|---|---|
| turn 内连续步（间隔 <1 分钟） | 4.2% | 追加式工作正常，每步未缓存中位数 995，其中新增内容 691，额外损耗 219 |
| 间隔 1-5 / 10-30 / 30-60 分钟 | 10% / 22% / 32% | 缓存随空闲衰减，和 30 分钟 TTL 吻合 |
| 间隔 1-24 小时 / >24 小时 | 59% / 77% | 跨天基本全丢，但固定前缀仍有约 2 成命中（系统提示全局共享） |
| 每个 user turn 的第一步 | 33.5%（均值 3.2 万未缓存） | 5278 次 turn 起始占了全部未缓存 token 的 52.5%；间隔 <1 分钟时中位数仍有 4.4K 未缓存，是 Codex 每 turn 的结构性损耗 |
| Codex 压缩后的第一步 | 52%（4.2 万里 2.2 万未缓存） | 一次压缩的代价约 2.2 万未缓存，换来后续 139 步每步少发 18 万 cached |

**成本当量口径**：cached×0.1、uncached×1、output×8。本机基线分解：cached 52%、uncached 28%、output 20%。即使按 0.1 折算，被反复重发的缓存上下文依然是最大一项。

**盈亏平衡公式**

设当前上下文 `C`，固定前缀 `F`，压缩后 `C' = F + S + 窗口`，省掉 `X = C − C'`；预计后续还有 `k` 步；每步新增 `δ`；生成摘要的代价 `L`（用小模型约 3K 当量，用主模型约 30K 当量）；信息缺失导致的额外 recall 代价 `R`。

```
不压缩 k 步：  k · (C·0.1 + δ)
压缩后 k 步：  (C' − F)·p_w + L + R + k · (C'·0.1 + δ)
节省：         k · X · 0.1 − (C' − F)·p_w − L − R
盈亏平衡：     k* = [(C' − F)·p_w + L + R] / (X · 0.1)
```

代入 `C=150K, F=15K, C'=30K, X=120K, p_w=1.25, L=3K（小模型）, R=10K`：`k* = (19K+3K+10K)/12K ≈ 2.7 步`；若用主模型做摘要 `L=30K`，`k* ≈ 5 步`。本机数据：每个 turn 后续步数 P(≥5)=0.59、P(≥10)=0.50；任务型消息 P(≥5)=0.66，提问型 0.40。所以"预计还要跑 10 步以上就压缩"在期望上稳赚，结论和直觉一致；真正的敏感项是 `L` 和 `R`，摘要要用便宜模型，且必须留 `recall`。

**回放模拟（5382 个真实 turn，逐步代入实测 token）**

| 策略（逐级叠加） | 原始输入 token | 倍数 | 成本当量 | 倍数 |
|---|---|---|---|---|
| 基线：只追加不压缩 | 250 亿 | 1.0 | 34.7 亿 | 1.0 |
| A 每 turn 起始重建（C0>20K） | 140 亿 | 1.8 | 22.6 亿 | 1.5 |
| B A + turn 内预算 60K 触发批量折叠 | 48 亿 | 5.2 | 14.0 亿 | 2.5 |
| C B + 输出整形（δ×0.5） | 45 亿 | 5.5 | 12.1 亿 | 2.9 |
| D C + 去掉轮询类步骤（δ<300） | 32 亿 | 7.8 | 9.8 亿 | 3.5 |
| E D + 固定前缀 15K→4K | 25 亿 | 10.0 | 9.0 亿 | 3.8 |
| F E + 预算降到 40K | 20 亿 | 12.7 | 8.7 亿 | 4.0 |
| G F + reasoning 降档（输出×0.8） | 20 亿 | 12.7 | 7.7 亿 | 4.5 |

读法：
- 只在 turn 起始压缩只能拿到 1.5 到 1.8 倍，因为 67% 的 token 来自 ≥50 步的长 turn，上下文在 turn 内就涨回去了。turn 内预算折叠是第二大杠杆。
- 按原始 token 看能到 12 倍，按成本当量只有 4.5 倍，差距就是缓存折扣。限额若按积分口径（cached 0.1×）计，真实收益按右列看；若限额对 cached 打折不足，收益向左列靠。两种口径都值得做。
- 长 turn（≥50 步）单独看：原始 17.8 倍，成本当量 7.2 倍。
- 输出 token 占成本 20%，上下文手段动不了它，只能靠减少步数和降 reasoning 档位。

**策略结论**

1. turn 内追加式，不滑动改写（官方明确要求 append，不要 rewrite）。
2. 零缓存风险的手段优先：新工具输出进上下文前整形、阻塞等待替代轮询、读去重、幂等命令缓存。这些减少 `δ` 和 `n`，不碰已缓存前缀。
3. 折叠只发生在两类事件：turn 起始（由 3.6 的判定器决定）和 turn 内超预算 `B`（默认 60K，长任务 40K）。每次折叠一次性付 `(C'−F)·p_w + L`。
4. 固定前缀 `F` 放最前且绝对稳定；GPT-5.6+ 上在 `F` 之后和状态块 `S` 之后放显式断点。
5. 摘要用小模型或由 harness 确定性生成（文件改动、测试状态来自 diff 和 shaper），主模型只在 turn 结束时补 300 token 的 `state_update`。

### 3.6 动态压缩判定（每个 user turn 起始的旁路判断）

每次人类消息进来，先跑一个不经过主模型的判定器，输出 `compact | keep | fork`：

| 特征 | 来源 | 作用 |
|---|---|---|
| 当前上下文 `C` 与 `C'` 的差 `X` | 账本 | `X` 小则不压 |
| 预计后续步数 `k̂` | 消息类型（任务型 vs 提问型）、上一 turn 步数、消息长度、是否含测试或验收命令 | 本机数据：上一 turn ≥50 步则本 turn P(≥5)=0.87；提问型且短消息 P(≥5)=0.40 |
| 主题相关性 | 新消息与 `S` 及最近窗口的相似度（embedding 或小模型打分） | 不相关 → `fork`（临时问答走分支，默认用完即弃）；相关但历史很长 → `compact` |
| 距上次响应的空闲时间 | 时间戳 | >30 分钟缓存已丢，重建几乎免费，直接 `compact` |
| 距上次折叠的步数 | 账本 | 刚折叠过则 `keep` |

判定规则：`k̂ ≥ k*(C, C', L, R)` 且主题相关 → `compact`；主题不相关 → `fork`；否则 `keep`。回放里一个只用"上下文 >50K 且（任务型消息或上一 turn ≥10 步）"的朴素判定器已经拿到 18.7%，和 oracle（17.9%）持平，说明判定器不需要很准，重点是别在提问型短消息上白付重建费。

判定器本身要便宜：规则 + embedding，不调主模型。它的输入输出都进账本，后续可以用真实步数做监督，持续校准 `k̂`。

### 3.7 缓存状态感知：失效了就放心压

缓存只在"最近 30 分钟内被用过"时存在（GPT-5.6+ 官方 TTL）。空闲超过 TTL 后，下一步无论压不压都要全额重读，此时压缩的一次性代价 `(C'−F)·p_w` 从"额外支出"变成"本来就要付的钱的一小部分"，盈亏平衡 `k*` 趋近于 0。

```
缓存存活（idle < TTL）：  k* = [(C'−F)·p_w + L + R] / (X·0.1)
缓存已失效（idle ≥ TTL）： k* = (L + R) / (X·0.1)   ← 重写代价为 0，几乎总是压
```

本机数据：续轮里 39% 的 turn 空闲超过 5 分钟，22% 超过 30 分钟，18% 超过 1 小时，它们的上下文中位数都在 12.5 万上下。也就是说每五个续轮里有一个可以零代价重建成 2 到 3 万。

harness 维护一个 `cache_state` 估计：`last_request_at`、`model`、`settings_hash`、`prefix_hash`，任何一项变了或空闲超过 TTL 就判定为 `cold`。`cold` 时判定器跳过盈亏计算直接 `compact`；`warm` 时才算 `k*`。TTL 是知识而不是事实，所以同时用实测校准：每次响应记录 `cached_tokens / input_tokens`，按空闲时长分桶拟合衰减曲线（现在的数据是 1 分钟内 4%、10 到 30 分钟 22%、30 到 60 分钟 32% 未命中），曲线变了说明服务端策略变了，自动更新 TTL 估计。

---

## 4. 架构

```
┌────────────────────────────────────────────────────────────────┐
│ 客户端                                                          │
│   Codex Desktop / Codex CLI ──(Responses API)──┐                │
│   Claude Code ──(Messages API, 后续)────────────┤                │
│   harness CLI（自有循环）───────────────────────┤                │
└────────────────────────────────────────────────┼───────────────┘
                                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ ctx-proxy  （挂在 ~/Program/codex_api 的 /v1/responses 上）       │
│   · 请求重写：历史折叠、存根、header 剥离、轮询链合并、读去重       │
│   · 代理自有工具：recall(id, grep, range) 在代理内闭环，不回客户端  │
│   · 账本：每请求 cached/uncached/output、按工具类型归因            │
└────────────────────────────────────────────────┼───────────────┘
                                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ ctx-core（纯函数库，TS）                                         │
│   Ledger（输入数组 → 结构化事件流）                                │
│   ArtifactStore（原文落盘，content-hash id）                      │
│   Shapers（pytest / rg / git / 日志 / 通用 head+tail，保失败字段）  │
│   Policy（窗口 W、预算 B、折叠时机、存根格式）                       │
│   TokenMeter（估算 + 真实账单对账）                                │
└────────────────────────────────────────────────────────────────┘
                                                 ▲
┌────────────────────────────────────────────────┼───────────────┐
│ harness（自有循环，第二阶段）                                      │
│   · 每 turn 重建：F' + S + 最近窗口                                │
│   · 工具：run(阻塞/后台) · wait(until) · read(缓存) · edit · recall │
│   · 会话 DAG：fork / merge / discard                              │
│   · 子任务：map-reduce，子上下文独立，父只收摘要                     │
│   · 多模型：OpenAI Responses（经 codex_api OAuth）/ Anthropic / Qwen│
└────────────────────────────────────────────────────────────────┘
```

### 4.1 为什么先做 proxy 而不是 fork codex-rs

- 本机 98.8% 的 token 来自 Codex Desktop，fork 的 CLI 救不了 Desktop；proxy 只要改 `config.toml` 的 `chatgpt_base_url` / `model_providers` 就能接上（需验证 Desktop + Pro 登录是否尊重该项，qwen 批量脚本已验证 CLI 可行）。
- Codex 每次请求都发全量 `input`（无服务端状态），proxy 看得到完整历史，重写空间足够。
- proxy 做不到的三件事（轮询、fork/merge、map-reduce）留给 harness；fork codex-rs 只在 harness 阶段想复用它的 apply_patch 与沙箱时再考虑。

### 4.2 ctx-core 的核心数据结构

```ts
type Item =
  | { kind: 'system' | 'developer', text, stable: boolean }
  | { kind: 'user', text, turn }
  | { kind: 'assistant', text, turn }
  | { kind: 'reasoning', id, turn }                 // 可丢弃
  | { kind: 'call', id, tool, args, turn }
  | { kind: 'output', callId, raw: ArtifactRef, shaped: string, tokens, turn,
      tags: Set<'error'|'traceback'|'test'|'poll-empty'|'read'|'dup'> }
  | { kind: 'stub', callId, summary, artifact: ArtifactRef }   // 折叠后的替身

type Policy = {
  window: number            // 最近 W 条 output 保留原文（默认 10）
  perOutputCap: number      // 单条 output 上限 token（默认 2000）
  turnBudget: number        // 超过则批量折叠（默认 60K）
  compaction: 'turn_boundary' | 'budget' | 'sliding'
  keepTags: Set<string>     // 带这些 tag 的 output 不折叠（error、traceback、test）
  dropReasoning: boolean
  collapsePollChains: boolean
  dedupeReads: boolean
}
```

`rewrite(input: Item[], policy, store): Item[]` 必须是**纯函数 + 幂等**：同一历史重写两次结果一致，否则缓存前缀不稳定。

### 4.3 存根格式

```
[output #a1f3 · exec `pytest tests/test_x.py` · 2,340 tokens · exit 1 · 失败 2 用例: test_parse, test_round · recall("a1f3") 可取回全文/grep]
```

存根必须回答三件事：这是什么、关键结论是什么、怎么找回。30 到 60 token。

### 4.4 Shapers（输出整形规则）

| 命令类 | 规则 | 保留 |
|---|---|---|
| pytest / unittest | 只留 summary 行 + 失败用例的 traceback 尾部 20 行 | 失败命令、异常类型、断言 diff |
| rg / grep | 最多 50 条 `file:line`，按文件分组计数 | 命中总数 |
| git status/diff | `--short`；diff 超 2K 落盘，留 stat | 文件列表 |
| 日志 tail | 最后 40 行 + 匹配 ERROR/Traceback 的行 | 时间戳范围 |
| 通用 | head 60% + tail 40% 到 `perOutputCap`，中间 `…N 行已落盘…` | 落盘 id |
| exec header | 去掉 `Chunk ID / Wall time / Original token count` | exit code |

4 月 F4 失败的原因是"强截断删掉了 traceback 和断言"。这里的区别：整形器识别失败字段并原样保留，而且全文永远可 recall。

### 4.5 轮询：harness 侧的等待

```
run(cmd, {timeout: 600s})                 // 默认阻塞到结束，模型只看最终输出
run(cmd, {background: true}) → job        // 立即返回 job id
wait(job, {until: 'exit' | /regex/ | 'silence:30s', max: 1800s})
```

`wait` 在 harness 进程内执行，不产生模型响应。唤醒模型的条件只有三种：退出、输出匹配、超时。空结果不回传。对 proxy 层则只能事后补救：把历史里连续的空 `write_stdin` 链折叠成一条存根。

### 4.6 读缓存

- `read(path, range?)` 按 `(path, range, mtime, hash)` 建会话级缓存。
- 命中且原文仍在窗口内 → 返回 `[unchanged, see #id]`（≈ 20 token）。
- 命中但原文已折叠 → 重新返回原文（不要让模型为了省 token 而看不到代码，这是 P3 的教训）。
- 不强制小切片；默认允许整文件读到 `perOutputCap`，显式参数可放宽到 8K。

### 4.7 每 turn 重建与状态摘要 S

每个 user turn 开始时，模型看到的是：

```
F'   固定前缀（≤ 4K，前缀稳定，可缓存）
S    状态摘要（≤ 3K）：goal / constraints / decisions / files_touched(含改动要点) /
     evidence(事实 + artifact id) / attempt_ledger(试过且失败的) / test_status / next
R    最近窗口（上一 turn 最后 W 条 output 的存根 + 本 turn 新增原文）
U    本轮用户输入
```

`S` 由模型在 turn 结束时随最终回答一起输出一个 `state_update`（≈ 300 token 输出），harness 负责确定性的部分（files_touched 来自 diff，test_status 来自最近一次测试 shaper）。保持 `S` 小是硬约束，复盘里 blackboard 越养越大的教训不能重犯。

### 4.8 会话 fork / merge

会话是一个 DAG，节点 = turn 边界的 `(S_t, files_changed_t, transcript_ref_t)`。

- `fork(t)`：新分支从 `S_t` 起步，共享工作区（默认）或独立 worktree（可选）。
- `discard`：临时问答用完即弃，默认行为。
- `merge(branch → main)`：不合并 token 历史，合并的是**状态**：
  1. 取分支最终的 `S_b`，diff 出相对 `S_t` 的增量（新事实、新决定、新改动）；
  2. 作为一个 `merged_block` 追加进主线的 `S`，带分支 transcript 的 artifact id，主线模型可 `recall`；
  3. 工作区：共享模式下文件已是最新；worktree 模式走 `git merge`，冲突交给主线下一 turn 处理。

因为每 turn 都从 `S` 重建，merge 的成本只有几百 token，这是"重建式上下文"相对"追加式"的额外红利。Codex 的 `forked_from_id` 只能复制历史，无法回合，根因就是它是追加式的。

### 4.9 map-reduce 子任务

`spawn(task, {context: 'fresh' | 'inherit_S'}) → summary(≤ 500 token)`。批量条目一律 `fresh`；父上下文只收摘要和 artifact id。这是 SP500 那类任务从 10 亿降到 1 亿级的唯一办法，proxy 层做不到，harness 必须有。

### 4.10 策略即配置：可组合、可按会话覆盖

所有"多少触发什么"都不写死在代码里，而是一组带默认值的旋钮，分层覆盖：`全局默认 → 用户画像 → 项目 → 会话 → 单 turn`。

```ts
type Knobs = {
  // 折叠时机
  compact_on_turn_start: 'never' | 'judge' | 'always_if_over'   // 默认 judge
  turn_start_threshold: number          // C0 超过多少才考虑（默认 50K）
  turn_budget: number                   // turn 内超过则批量折叠（默认 60K；长任务画像 40K）
  cold_cache_compact: boolean           // 缓存失效时直接压（默认 true）
  cache_ttl_estimate_s: number          // 默认 1800，由监控校准
  kstar_margin: number                  // k̂ ≥ k* × margin 才压（默认 1.2）
  // 窗口与整形
  window: number                        // 保留原文的最近输出条数（默认 10）
  per_output_cap: number                // 默认 2000
  keep_tags: string[]                   // ['error','traceback','test'] 不折叠
  shapers: Record<string, ShaperConfig> // pytest / rg / git / log / generic
  // 步数
  blocking_exec_timeout_s: number       // 默认 600
  wait_silence_s: number                // 默认 30
  dedupe_reads: boolean
  idempotent_cmd_cache: boolean
  // 模型
  routing: RoutingTable                 // 见 4.12
  reasoning_effort_by_phase: { plan, execute, verify, summarize }
}
```

设计约束：

1. 每个旋钮都有 `default`、`min`、`max`、`step`，调优器只能在范围内动，防止把 `per_output_cap` 调到 0 这类自毁。
2. 旋钮变更本身是事件，写进账本，带 `who`（人、调优器、画像）和 `why`，可回滚。
3. 有几个旋钮一变就让缓存前缀失效（`routing` 的主模型、`reasoning_effort`、tools 列表），这类标记为 `cache_breaking: true`，只允许在 turn 边界或 `cold` 状态下生效。
4. 预置画像：`default`、`long_task`（预算 40K、窗口 8）、`qa_only`（不压、不整形，适合纯问答）、`batch`（map-reduce，子上下文 fresh）。画像是旋钮集合的命名快照，用户可以手动切，也可以由判定器按消息类型切。

### 4.11 旁路监控与持续调优

harness 只负责执行策略；一个独立的 sidecar 进程读账本、算收益、改旋钮。两者只通过账本和旋钮文件通信，sidecar 挂了不影响 harness。

**账本（每次模型响应一行）**

```
ts, session, turn, step, model, policy_version,
input, cached, uncached, output, reasoning,
ctx_before, ctx_after, delta_new, event(compact|keep|fork|shape|dedupe|wait),
tool_kind, idle_s, cache_state, knobs_hash,
recall_count, retries, task_outcome(success|fail|unknown)
```

**三类指标**

| 层 | 指标 | 用途 |
|---|---|---|
| 成本 | 每 turn 的原始 token、成本当量（cached×0.1 + uncached + output×8）、每成功任务的成本 | 主目标 |
| 策略效果 | 每次折叠的实际节省（之后 k 步的 Σ X×0.1 减去一次性代价）、折叠后 recall 次数、折叠后重试次数、`k̂` 与实际 k 的误差 | 判断每个策略是否在赚 |
| 质量 | 任务成功率（有验收命令的任务按命令结果，其余按用户是否追加纠正）、每 turn 的用户纠正次数 | 护栏：成本降了但质量掉了就回滚 |

**调优方式**

- 单旋钮扫描：对连续型旋钮（`turn_budget`、`per_output_cap`、`window`）做小步爬山，每次改一档，观察至少 N 个 turn，收益为负就退回。
- 多臂老虎机：对离散型（`compact_on_turn_start` 三选一、画像选择）用 Thompson sampling，奖励 = 负成本当量 + 质量惩罚。
- 预测器校准：`k̂` 用账本里的真实步数做监督，特征就是 3.6 那几项，模型可以是逻辑回归，也可以是小模型打分；每周重训。
- 安全阀：任何调整导致质量指标跌破基线的 95% 区间，立即回滚并冻结该旋钮一周。

**按人、按项目、按会话**

每个人的习惯不同：有人一个会话跑一整天，有人每轮都是新问题。账本按 `user × project × session` 三级聚合，旋钮覆盖也是三级。sidecar 先在全局层调，有足够样本（比如 ≥200 turn）的项目再单独调。这正是把"每个会话不同策略"做成可运维的方式，而不是靠人手动切。

### 4.12 多模型分级：按任务复杂度路由

本机数据：71.5% 的模型响应 reasoning 不到 128 token，17.5% 完全没有 reasoning。大量步骤是"看一眼输出、再发一个命令"的例行动作，用最强模型加 xhigh 去做是浪费。但有一个硬约束决定了路由的粒度：

> 换模型就换缓存。KV cache 不跨模型，Responses API 的 reasoning item 也不能跨模型回灌。同一个对话里在步与步之间切模型，等于每次切换都全额重读上下文。

所以路由不能发生在主循环的步级，只能发生在**有独立小上下文的任务边界**。主循环始终一个模型、一套设置，保住前缀缓存。

**分级表**

| 层级 | 典型任务 | 上下文 | 模型 | 失败后 |
|---|---|---|---|---|
| T0 确定性 | 输出整形、读去重、header 剥离、文件改动清单、测试结果解析 | 无 | 不用模型 | 无 |
| T1 轻量判断 | 压缩判定器、主题相关性、`k̂` 预测、日志分类、工具输出打标签（error / test / noise） | 几百到 2K | mini 级（gpt-5.4-mini、haiku 级、本地 Qwen） | 回退到规则 |
| T2 受限生成 | 状态摘要 S 的生成、折叠存根文案、长输出的摘要、commit message、文档样板 | 2K 到 30K，自包含 | mini 到中档 | 升级到 T3 重做 |
| T3 执行子任务 | map-reduce 的单个条目、"找到 X 的定义并列出调用点"、跑测试并报告失败、单文件机械重构 | fresh 子上下文 ≤ 40K | 中档（gpt-5.5 medium）或主模型 low | 升级到 T4 |
| T4 主循环 | 需要跨文件理解、设计决策、调试推理的工作 | 主上下文 | 主模型（gpt-5.6-sol high / xhigh） | 人 |

**路由规则**

1. T0 到 T2 是 harness 的内部作业，用户无感，默认全开。它们的输入必须自包含（不依赖主上下文的隐含知识），这是能用小模型的前提。
2. T3 由主模型主动委派：主模型发一个 `delegate(task, inputs, acceptance)`，harness 起一个 fresh 子上下文交给路由表指定的模型，回收 ≤ 500 token 的结果和 artifact id。主模型不需要知道子任务用的是谁。
3. 升级而不是降级：子任务先用便宜模型，`acceptance` 不过再升一级重做。反过来（先贵后便宜）没有意义。
4. 路由表是旋钮的一部分，sidecar 按"子任务一次通过率 × 成本"调整每类任务的默认层级。某类任务在便宜模型上通过率低于阈值（比如 70%），自动上调一级。
5. 主循环的 reasoning effort 按阶段设置（plan 高、execute 中、verify 中、summarize 低），但这个切换会破坏缓存，所以只在 turn 边界切。

**预期收益**

路由对输入 token 的影响不大（主上下文还是主模型），主要省三块：输出 token（T2 摘要和 T3 子任务的输出不再由 xhigh 模型生成）、map-reduce 条目的全部成本、以及判定器和摘要这类新增作业本身不增加主模型负担。粗估输出成本降 30% 到 50%，批量场景整体降一个数量级。更重要的是它让"每轮做一次压缩判定、每次折叠生成一次摘要"这些额外动作变得几乎免费，否则 3.5 节里的 `L` 会吃掉大半收益。

**风险**

- 小模型摘要漏掉关键事实 → `R` 上升。对策：摘要只做"索引"（事实 + artifact id），不做"结论"；保留 recall。
- 多模型多供应商的账单和限额分散。对策：账本按模型分列，sidecar 统一折算成本当量。
- 本地或第三方小模型的工具调用格式不一致。对策：T1、T2 只要求文本输出，不要求 tool call；T3 才需要完整工具协议。

---

## 5. 验证方法

### 5.1 离线回放基准（零模型成本）

把 2128 条 Codex 会话的 `response_item` 序列喂给 `ctx-core.rewrite`，对每一步算重写后的上下文 token（tiktoken 估算），和 `token_count.last_token_usage` 实测对比：

```
saving = 1 − Σ rewritten_c_i / Σ measured_c_i
```

按会话、按工具类型、按策略参数（W、B、cap）出表。这个基准一天就能搭，先跑它再写一行 proxy 代码。

### 5.2 在线 A/B（真实账单）

同一任务集，`direct` vs `proxy`，记录 cached / uncached / output 和周限额曲线。关注 3.5 节的缓存断裂代价是否吃掉收益。

### 5.3 任务成功率（R6）

复用 `~/Program/agentic_agent/react_ablation_harness` 的 SWE-bench Lite dev23 跑法：champion 不变，只换上下文策略。接受条件：accepted 数不低于基线，token 下降 ≥ 3×。再补 5 到 10 个本机真实任务（从历史会话里挑，有明确验收命令的）作为 golden set。

指标统一为：`成功率` 与 `每成功任务的 token`，两者一起看。

---

## 6. 路线图

| 阶段 | 产出 | 验收 |
|---|---|---|
| P0（1 周） | `ctx-core` + 回放基准 + 报告 | 回放估算：长会话节省 ≥ 5×，且无 keepTags 内容被折叠 |
| P1（1 到 2 周） | `ctx-proxy` 接入 `codex_api`；Codex Desktop 指向代理；账本页面 | 真实一周账单：输入 token ≤ 原来 1/3，任务无感知退化 |
| P2（2 到 3 周） | `harness` CLI：阻塞 run/wait、读缓存、每 turn 重建、S、map-reduce | SWE-bench dev23 不低于基线；SP500 类批量任务 ≤ 1/10 |
| P3 | fork / merge / discard；Claude Code 适配（Messages API 的同构重写） | 临时问答 merge 回主线成本 < 1K token |
| P4 | sidecar 监控 + 旋钮调优；T1/T2 作业接小模型；T3 委派与升级 | 两周在线对比：成本当量再降 ≥ 30%，质量指标不跌 |

每阶段结束做一次复盘，按 4 月的规矩：看分数、看轨迹、再决定下一步，不围着单 case 补丁。

---

## 7. 与旧方案的关系

| 旧方案（agentic_agent） | 本设计的取舍 |
|---|---|
| ID-first external memory、ArtifactStore | 保留，简化为 content-hash 落盘 + `recall` |
| 可变 task context、每 turn 重建 | 保留，是 L1 的核心 |
| 五阶段协议、goal-gap 路由、blackboard、decision journal | 不要。复盘证明是框架税 |
| 模型决定 keep / compress / replace | 不要模型管内存。折叠由策略确定性执行，模型只有 `recall` 一个逃生口 |
| F4 截断、F6 压缩、P3 小切片被拒 | 整形保失败字段；折叠只动窗口外；读不强制切片 |
| Benchmark harness、promotion rule、decision log | 保留，照搬跑法 |

---

## 8. 待定问题

1. Codex Desktop 用 ChatGPT 登录时，`chatgpt_base_url` 能否指向本地代理（CLI 已验证可行，Desktop 待验）。
2. 周限额对 cached token 的计法。决定 `compaction.mode` 的默认值。
3. 代理内闭环的 `recall` 工具：Codex 客户端会不会因为 `tools` 数组多了一项而拒绝或显示异常。
4. Responses API 回灌 reasoning item 的要求：`store:false` 下 reasoning 是否必须原样回传（若必须，L4 的"丢弃旧 reasoning"要改成只保留最近 W 条）。
5. Claude Code 的 Messages API 重写是否能复用 ctx-core（item 模型同构，需要一个 adapter）。

---

## 9. 参考来源

- OpenAI Prompt caching 指南：https://developers.openai.com/api/docs/guides/prompt-caching
- ChatGPT / Codex pricing 与限额说明：https://learn.chatgpt.com/docs/pricing
- Codex rate card（积分口径，cached 约 0.1×）：https://help.openai.com/en/articles/20001106-codex-rate-card
- Codex Usage Limits 讨论（无官方公式）：https://github.com/openai/codex/discussions/2251
- 本机会话实测与回放脚本：`bench/codex_session_stats.py`（扫描 ~/.codex/sessions 输出 summary.json）

---

## 10. 实现状态（2026-10-01）

代码在本目录，`npm test` 24 个用例全部通过（core、harness 主循环用 mock 模型、proxy、upstream 登录与传输、sidecar）。真实冒烟：harness 经 `codex_api` 用 `qwen3.6-plus` 完成"建文件、运行、记笔记"4 步任务；proxy 在 60 条输出的历史上做了轮次起始折叠（82.8K → 17K），流式透传正常，`recall` 替换闭环成功。

| 设计章节 | 实现 | 位置 |
|---|---|---|
| 3.5 / 3.6 / 3.7 判定器、盈亏公式、缓存状态 | `judge()`、`kStar()`、`estimateCacheState()`、`fitTtl()`；词法主题相似度做无模型回退 | `src/core/judge.ts`、`cache_state.ts` |
| 4.2 Item 模型与纯函数重写 | `rewrite()` 幂等、折叠边界按 call_id 单调；预算折叠带滞回（可变部分超预算且累计一个窗口的新观察） | `src/core/rewrite.ts` |
| 4.3 存根 | `[output #id · tool · cmd · N tok · exit · 关键行 · recall("id")]` | `rewrite.ts: stubFor` |
| 4.4 Shapers | pytest / rg / log / generic；保留 traceback 尾部、断言、失败命令；剥离 exec header | `src/core/shapers.ts` |
| 4.5 阻塞等待 | `run` 阻塞到退出；`background` + `wait(until|silence|max)` 在 harness 内等待 | `src/harness/tools.ts` |
| 4.6 读缓存 | `(path, range, hash)` 会话级缓存；窗口外不去重 | `tools.ts`、`rewrite.ts` pass C |
| 4.7 每轮重建与 S | 固定提示 ≈450 token + digest + 上一轮窗口存根 + 新消息；`state_update` 写笔记；可选 T2 小模型摘要 | `src/harness/loop.ts`、`core/summary.ts` |
| 4.8 fork / merge / discard | 会话 DAG，merge 合并状态增量成 ≤600 token 的 merged block | `src/harness/session.ts` |
| 4.9 map-reduce | `mph map`，每条目 fresh 上下文，T3 模型，batch 画像 | `src/harness/cli.ts` |
| 4.10 旋钮 | 28 个旋钮带 default/min/max/step，五层覆盖，变更带来源可回滚；cacheBreaking 标记 | `src/core/knobs.ts` |
| 4.11 sidecar | 账本聚合、折叠净收益、缓存衰减、delegate 通过率；爬山 + Thompson + k̂ 校准 + TTL 拟合；质量护栏回滚并冻结 | `src/sidecar/` |
| 4.12 多模型分级 | T0–T4 路由表，`delegate` 先便宜后升级，按任务类通过率调整 | `src/harness/router.ts` |
| 4.1 proxy | `/v1/responses` 透明代理，按 `prompt_cache_key` 持久化折叠边界，注入 `recall` 工具（substitute / loop / off） | `src/proxy/server.ts` |
| 5.1 回放基准 | 逐请求重建 + 公共前缀模拟缓存 + 估计器按实测校准（比值 0.99） | `src/bench/replay.ts` |
| 内置 Codex 反代（10-01 晚新增） | 凭据顺序 env → `~/.my-poor-harness/codex-auth.json` → `~/.codex/auth.json`；到期前用 refresh_token 刷新并把轮换后的 token 同步回 Codex CLI 的文件；`mph login` 走 PKCE（浏览器回调 localhost:1455 或手工粘贴）；上游 `chatgpt.com/backend-api/codex/responses`，强制 `stream:true, store:false`，非流式调用由反代聚合 SSE；`response.completed` 的 `output` 为空、SSE 无 content-type，这两点都做了处理；429/5xx/网络错误退避重试，401 刷新一次；`x-codex-*` 限额头透传给 Codex 客户端。`provider=openai_compatible` 时填自己的 base_url 和 api_key；解析顺序 CLI → env → config.json → 默认 codex | `src/upstream/` |
| agent_message 折叠（10-01 晚新增） | 多 agent 会话里 `agent_message` 条目（载荷为 encrypted_content）在窗口外折成一行存根；文本载荷进 artifact 可 recall，加密载荷丢弃；token 估计按 reasoning 的字符比折算而不是 JSON 长度 | `rewrite.ts` 折叠段 |

**回放结果（proxy 模式，默认旋钮）**

| 样本 | 请求数 | 原始输入基线 | 重写后 | 原始倍数 | 成本当量倍数 | 模拟缓存命中 |
|---|---|---|---|---|---|---|
| 30 个会话（最大的一批） | 1182 | 1.28 亿 | 0.58 亿 | 2.2 | 1.48 | 91% |
| 118 个会话（每 12 个取 1，每会话 ≤300 请求） | 4619 | 4.97 亿 | 2.44 亿 | 2.0 | 1.56 | 93% |
| 同一 118 个会话，`long_task` 画像（预算 40K、窗口 8、cap 1500） | 4619 | 4.97 亿 | 2.15 亿 | 2.3 | 1.64 | 92% |
| 其中 ≥100 请求的 12 个长会话（默认旋钮） | | | | 2.2 | 1.77 | |
| 其中 <20 请求的 54 个短会话 | | | | 1.45 | 1.16 | |

118 会话样本里：折叠 19.2 万条输出、合并 6930 次空轮询、整形省下 9890 万 token、固定前缀瘦身 1050 万。重写后剩余 token 的构成：窗口内工具输出 32%、窗口内 reasoning 22%（Codex 回灌的加密 reasoning）、固定前缀 17%、调用参数 13%、助手消息 6%、存根 5%。

读法和下一步：
- proxy 模式受制于 Codex 自己的固定前缀（约 7K 到 9K，已瘦身 2.9M）和回灌的 reasoning；这两项在自有 harness 里不存在，所以 harness 模式的收益会明显高于 proxy 模式。
- 教训：第一版预算折叠每步触发，变成滑动改写，成本当量反而是基线的 0.67 倍。加滞回后才回到 1.4 倍以上。3.5 节的警告在数据上被验证了一次。
- agent_message 折叠和 `compaction` 条目的 cap（`compaction_item_cap`）已实现。

**R6 质量回归（2026-10-02，`bench/swe_regress.py`）**：SWE-bench Lite dev 23 题，求解器 `mph run`（最多 40 步），模型 qwen3.7-plus（DashScope，经 Chat Completions 适配），判分复用 agentic_agent 的隐藏测试评估（FAIL_TO_PASS + PASS_TO_PASS），每题每组跑 1 次。三组只差上下文策略：off 关闭全部压缩；on 默认旋钮；tight 为 turn_budget 20000、window 6、cap 1500。

| 组 | 通过 | 仅看 FAIL_TO_PASS | 输入 token | 未命中缓存 | 输出 | 步数 | 发生折叠的题 | 成本当量 |
|---|---|---|---|---|---|---|---|---|
| off | 8 | 11 | 5.54M | 0.93M | 190K | 534 | 1 | 2.91M |
| on | 10 | 13 | 4.10M | 0.84M | 200K | 468 | 2 | 2.77M |
| tight | 10 | 14 | 5.79M | 0.98M | 213K | 582 | 5 | 3.16M |

读法：
- 质量不退化，满足"accepted 不低于基线"。没有任何一题因为压缩从通过变成失败。分歧只有 2 题，都是 on 和 tight 通过、off 失败（其中 sqlfluff-2419 是 off 组模型没调用 edit 就宣称已修复），属于单次采样噪声范围。
- token 节省在这个基准上测不出来，"下降 ≥3×"不成立。单轮 SWE 题加 qwen 的上下文很小（平均每步 9K 到 10K），默认 60K 预算下 on 组只有 2 题触发折叠，tight 组也只有 5 题。on 比 off 少 26% 输入，主要来自步数少和单条输出 cap（2000 对 8000），成本当量只差 5%。压缩的收益要在长会话、多轮对话或 Codex 回放里看（见上面的回放结果）。
- 判分受限的题：marshmallow-1359（PASS_TO_PASS 测试 ID 含空格被截断）、pvlib-1854（fixture setup error）、pydicom-1413（环境相关的 TypeError），三组同样失败，与策略无关。
- 回归中修掉的框架问题：判分前按官方 SWE-bench 做法把测试补丁涉及的文件还原到基线；以 base commit 为基准判分（qwen 会自己 `git commit`，3 个任务因此重跑）；题目提示里的工作区路径改成每组自己的副本；后台任务日志从用户仓库移到 `~/.my-poor-harness/jobs`；启动器改为用绝对路径加载 tsx。
- 产物：`~/.my-poor-harness/regress/r6_qwen37_20261001/`（`results.jsonl`、`summary.md`、每题 `runs/<arm>/<id>/` 里的 agent 日志、final.diff、eval_result.json）。

**真实验证（2026-10-01 晚，内置 Codex 反代，模型 gpt-5.6-sol）**：`mph whoami` 复用 `~/.codex/auth.json`；mph-proxy 非流式请求返回 "pong"（in 137 / out 5 入账本），流式请求事件完整并把 `x-codex-plan-type` 等头透传；`mph run` 4 步完成"建 hello.txt、cat 验证、state_update、回复 done"。验证期间遇到一次上游 `server_is_overloaded`（response.failed 被原样透传），据此加了退避重试。`~/Program/codex_api` 不再是前置条件，`--upstream` 仍可指向它。
