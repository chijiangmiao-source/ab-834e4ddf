# 辐照监测节点 · 无锁采样池地址复用复核器

审查员用工具：对“无锁采样池”的全序并发事件做规则复核，防止地址回收复用时，
仅凭地址相同把新旧样本（旧代次 / 新代次）混为一项。

## 它核对什么

每个对象以 **`(地址, 代次)`** 共同标识：初始节点代为 1；`reuse` 只能作用于
**已回收（freed）** 的地址，并产生严格递增的新代次。读取合法必须同时满足：

1. 线程候选与当前危险指针指向**同一代次**对象；
2. 危险指针发布之后成功 `reconfirm`，确认候选仍是**当前头指针**；
3. `read` 瞬间再次核对头指针未在“确认后—读取前”变化（一次确认只授权一次读取）。

其余规则：

- `scan` 仅可回收 **已退役且未受任何线程危险指针保护** 的节点（`FREE_PROTECTED`）；
- 退役 ≠ 回收：危险指针阻止回收，但不能让已退役样本继续被读取（`ACCESS_AFTER_RETIRE`）；
- 旧代次引用（`STALE_GENERATION`）、重复退役（`DOUBLE_RETIRE`）、
  非法摘链（`ILLEGAL_UNLINK`）、未回收即复用（`REUSE_NOT_RECYCLED`）均稳定定位到首个违规事件；
- 违规报告包含：首个违规事件、该瞬间**线程候选与保护快照**、
  **目标对象生命周期**及其**全序前序轨迹**。

## 事件语言

每行：`[序号] 线程 操作 [地址] [reclaim=地址:地址]`（支持中英文操作名）

| 操作 | 含义 |
|---|---|
| `load` / 装载 | 把头指针装入线程候选 |
| `publish` / 发布 | 发布候选为危险指针（`publish null` 撤销保护） |
| `reconfirm` / 再次确认 | 发布后再确认候选仍是当前头指针 |
| `read` / 读取 | 按协议读取样本 |
| `retire` / 摘链退役 | 从链表摘除并进入退役集合 |
| `scan` / 扫描回收 | 回收退役且无人保护节点；可 `reclaim=N1:N2` 显式列清单 |
| `reuse` / 复用 | 取**已回收**地址产生新代次并压入链头 |

约束：初始节点 ≤ 16，全局事件 ≤ 128。

## 本地运行（无需任何第三方依赖，Node ≥ 20）

```bash
node src/server.js            # 默认 http://localhost:8080 ，健康检查 /healthz
PORT=9090 node src/server.js  # 自定义端口
```

分析在 **Web Worker**（`public/analyze.worker.js`，ES Module Worker）中执行；
输入错误或分析失败时**保留草稿**（localStorage）但**清除旧成功证据**；
「清空草稿与结论」按钮可一键清空两者。

## Docker Compose

```bash
HOST_PORT=8080 docker compose up --build web     # 可配置宿主端口
curl http://localhost:8080/healthz
```

## verify：一次性验证服务

名为 `verify` 的服务运行**规则测试 → 构建检查 → HTTP 冒烟**，一次后退出，
以退出码报告结果（0 成功，非 0 失败）：

```bash
docker compose build verify && docker compose run --rm verify
# 或本地等价运行：
node scripts/verify.mjs
```

## 测试

```bash
node test/engine.test.js   # 36 项断言：地址复用 ABA、扫描保护、迟到读取等
```

## 目录结构

```
src/engine.js            复核引擎（浏览器 Worker / Node 共用 ESM，零依赖）
src/server.js            静态服务 + /healthz（白名单防路径穿越）
public/index.html        录入与结论页面
public/app.js            页面交互、Worker 调度、快照/生命周期渲染
public/analyze.worker.js Worker 入口
scripts/verify.mjs       一次性验证（规则测试 + 构建检查 + HTTP 冒烟）
test/engine.test.js      规则测试套件
```
