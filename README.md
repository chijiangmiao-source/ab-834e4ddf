# 辐照监测节点 · 无锁采样池复核

在浏览器中录入初始单链表（≤16 个节点）与全局有序并发事件（≤128 条），页面在 Web Worker 中
按危险指针协议复核事件记录，给出「通过」或「首个违规事件」及其上下文：

- 节点以「地址 + 单调代次」共同标识；复用只能取已回收地址并产生新代次。
- 读取前必须完成 装载候选 → 发布同代次危险指针 → 再次确认当前头指针，
  且读取时该候选代次不得已退役 / 已回收（迟到读取）。
- 扫描仅回收未受任何线程保护的退役节点。
- 旧代次引用、重复退役、非法摘链、复用未回收地址均稳定定位到首个违规事件，
  并展示线程候选与保护快照、对象生命周期及其前序。
- 输入错误或分析失败后保留草稿、清除旧成功证据；可一键清空草稿与结论。

## 事件格式

每行一条：`线程 操作 [地址]`，`#` 或 `//` 之后为注释。

| 操作 | 中文别名 | 含义 |
| --- | --- | --- |
| `load` | 装载候选 | 把当前头指针装载为线程候选 |
| `protect` | 发布危险指针 | 发布对候选（地址+代次）的保护 |
| `confirm` | 再次确认 | 确认当前头指针仍为同代次候选 |
| `read` | 读取 | 读取候选节点 |
| `retire 地址` | 摘链退役 | 摘除链表头节点并退役（仅限头节点） |
| `scan` | 扫描回收 | 回收未受任何线程保护的退役节点 |
| `reuse 地址` | 复用地址 | 取已回收地址生成新代次并压入表头 |

## 运行（Compose）

```sh
HOST_PORT=8080 docker compose up --build web
# 页面：http://localhost:8080/    健康响应：http://localhost:8080/health
```

`HOST_PORT` 为可配置的宿主端口（默认 8080）。

## 一次性校验（verify 服务）

```sh
docker compose build
docker compose up --exit-code-from verify --abort-on-container-exit verify
# 或：docker compose run --rm verify
```

`verify` 依次执行：规则测试（地址复用 / 扫描回收 / 迟到读取等）→ 构建检查
（JS 语法与页面脚本引用链）→ HTTP 冒烟（`/health`、首页、静态资源），
运行一次后退出，退出码 0 表示全部通过、1 表示失败。

## 本地（无 Docker）开发校验

```sh
node --test verify/tests/     # 规则测试
node verify/tests/smoke.js http://127.0.0.1:8080   # 对任意已启动的 web 做冒烟
```

## 目录结构

```
web/static/     页面（index.html / app.js / worker.js / analyzer.js）
web/            nginx 镜像（页面 + /health）
verify/         一次性校验服务（规则测试 + 构建检查 + HTTP 冒烟）
docker-compose.yml
```
