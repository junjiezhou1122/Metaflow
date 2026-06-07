# Workspace Restructure Plan

> 把 `src/` + `packages/` 重组为对齐核心概念模型的 pnpm workspace 真包结构。
> 概念模型基线见 [`info-design-consensus.md`](info-design-consensus.md) 与
> [`info-ambient-runtime-architecture.md`](info-ambient-runtime-architecture.md)。

## 0. 为什么重构

代码"乱"不是质量问题，是**物理目录没有对齐概念模型**。文档里的主循环极清晰：

```text
Observation -> Context Graph -> Program -> Capability/Agent -> View -> Application -> Feedback
```

但当前目录沿历史意外切分（`src/` vs `packages/`），横切了这条线。

### 当前结构的四个根因

1. **`src/` ↔ `packages/` 双向依赖。** 一次旧迁移（证据：`archive/dead-code/2026-05-src-package-shims/`）
   把 connectors/views 从 `src/` 搬到 `packages/`，但 kernel（`src/core`）留在原地。结果：
   - `src/runtime`、`src/server` → `packages/{connectors,views}`（向下，集中在 3 个文件）
   - `packages/{connectors,views}` → `src/core/{types,store,llm,env}`（向上，24 处）
   - 这是目录级循环，只靠 `src/core` 恰好是纯叶子才没爆。
2. **有 `packages/` 却无 `pnpm-workspace.yaml`。** 整个东西是被 `tsx` 拉平编译的单一 TS program
   （`tsconfig` include `src/**`+`packages/**`）。只有 `ui`、`browser-extension` 是真 workspace。
   `packages/connectors`、`packages/views` 是伪装成包的普通目录。
3. **三个分层违例：**
   - `src/broker` 反向 reach 进 `src/runtime`、`src/programs`
   - `packages/views/visual-frame` → `packages/connectors/screenpipe`（编译时拉 connector）
   - `src/pipeline`（content-classifier）是与 `runtimeTick` 完全断开的第二条编译路径
4. **重复与死代码：** `language-learning` 双份（`src/plugins` + `src/programs/builtins`）；
   `packages/evaluators` 仅 README；`worker.ts` 手抄 `http-server.ts` 路由子集；
   UI/extension types 手工镜像 `src/core`；`visual-frame` regex 在 `compiler.ts`/`shared.ts` 重复。

## 1. 目标：pnpm workspace 真包（路线 A）

每层是一个 `@info/*` 真包，靠 `package.json` 依赖声明强制单向边界（只能依赖下层）。

```text
apps/          Applications —— 纯 HTTP，零代码耦合
  @info/ui                 (现 packages/ui)
  @info/browser-extension  (现 packages/browser-extension)

@info/server      HTTP API + iii worker（唯一对外暴露面）   现 src/server
@info/runtime     Tick 编排：sensors→views→programs 串联     现 src/runtime
@info/programs    Program 循环 + ProgramRuntime + 路由       现 src/programs
@info/capabilities 可复用能力 + agent-runtime adapter        现 packages/adapters + src/programs/capabilities
@info/views       所有 View 编译器                          现 packages/views + src/pipeline + src/threads + runtime 内 timeline 编译器
@info/sensors     Observation 来源                          现 packages/connectors
@info/core        Kernel: types/schema/store(=Context Graph)/llm/env/policy/broker  现 src/core + src/broker + src/plugins
```

依赖方向（严格向下，无环）：

```text
apps  ->  server  ->  runtime  ->  programs  ->  capabilities
                                       |              |
                                       v              v
                                     views   ------> sensors
                                       |              |
                                       +----> core <--+
```

### 包归属决策

| 目标包 | 收纳现有目录 | 理由 |
|---|---|---|
| `@info/core` | `src/core`, `src/broker`, `src/plugins` | broker 本质是 policy-aware 图查询，属 kernel；plugins registry 是 manifest 读取，属 kernel |
| `@info/sensors` | `packages/connectors/*` | Observation 来源，重命名 connectors→sensors 对齐术语 |
| `@info/views` | `packages/views/*`, `src/pipeline`, `src/threads`, `src/runtime/{timeline,activity-timeline,project-timeline,work-thread-view,episode-summary,correlation}` | 所有"把 records→View"的编译逻辑归一处 |
| `@info/capabilities` | `packages/adapters/agent-runtime`, `src/programs/capabilities` | 可复用能力 + agent 执行后端 |
| `@info/programs` | `src/programs/{runner,registry,types,signals,view-kinds,builtins}` | Program 循环引擎 |
| `@info/runtime` | `src/runtime/{runtime,feedback,view-provenance,background-tasks,toolsmith-artifacts,screen-noise,triggers}` | tick 编排 |
| `@info/server` | `src/server` | HTTP + worker |

## 2. 待修违例（随迁移一并处理）

- **broker 反向依赖**：折叠进 `@info/core`。它对 `runtime/work-thread-view`、`programs/view-kinds`
  的依赖需切断——把 `workThreadViewToMarkdown`、`view-kinds` helper 下沉到 core，或让 broker 只接收已编译好的 markdown。
  ✅ 已于阶段 1 完成（下沉到 core）。
- **views/visual-frame → connectors**：摄取与编译分离。runtime 在 tick 时拉 frame，把数据喂给编译器，
  编译器不再 import sensor。⏸ **延后**：这是行为重构（改编译器签名），留到 9 个结构阶段全部完成后单独处理。
  当前 visual-frame→sensor 已是 `@info/views` 声明的合法 `@info/sensors` 依赖，不再是隐藏跨目录 reach。
- **src/pipeline 断连**：content-classifier 并入 `@info/views`（✅ 阶段 3a 结构已并入）。
  ⏸ **延后**：由 runtime 统一调度（content-classifier 当前仍只由脚本触达）是行为变更，结构迁移完成后处理。
- **去重**：✅ 阶段 3b 已去 visual-frame 6 个重复函数。
  合并两份 language-learning（阶段 5）；删 `packages/evaluators`、`worker.ts` 复用路由表（阶段 7/8）。

### 延后的行为重构（结构迁移全部完成后单独评估）

1. visual-frame 摄取/编译分离（runtime 喂 frame 数据，编译器去掉 `@info/sensors` 依赖）。
2. content-classifier（pipeline）并入 runtime tick 统一调度。
3. `worker.ts` 复用 `http-server` 路由表，消除手抄子集。

## 3. 分阶段执行（每阶段独立验证 typecheck+test）

原则：一次只动一层，从最底层 core 往上推；每阶段后 `pnpm typecheck && pnpm test` 必须绿。
用 pnpm workspace + `@info/*` 包名 import 替代相对 `../../`，文件移动后引用不再脆。

- **阶段 0｜脚手架**：建 `pnpm-workspace.yaml`，根 tsconfig 加 `paths`/project references 或靠
  workspace 解析。先不移动文件，仅让 workspace 能解析 `@info/*`（指向现有目录），验证基线仍绿。
- **阶段 1｜`@info/core`**：`src/core` + `src/broker` + `src/plugins` → `packages/core/`。
  切断 broker 对 runtime/programs 的反向依赖（下沉 helper）。所有 `../core/x` → `@info/core`。
- **阶段 2｜`@info/sensors`**：`packages/connectors/*` → `packages/sensors/`，import 改 `@info/core`。
- **阶段 3｜`@info/views`**：收 `packages/views` + `src/pipeline` + `src/threads` + runtime 内 timeline 编译器。
  修 visual-frame→sensor（摄取/编译分离）；并 pipeline 进统一调度；提取重复 regex。
- **阶段 4｜`@info/capabilities`**：`packages/adapters/agent-runtime` + `src/programs/capabilities`。
- **阶段 5｜`@info/programs`**：`src/programs/*`。合并双份 language-learning。
- **阶段 6｜`@info/runtime`**：`src/runtime/*`（去掉已下沉到 views 的部分）。
- **阶段 7｜`@info/server`**：`src/server`。`worker.ts` 复用 `http-server` 路由表。
- **阶段 8｜apps + 清理**：ui/browser-extension 移入 `apps/`；删 `packages/evaluators`；
  更新根 `package.json` scripts 路径；删 `archive/dead-code`（已确认无引用）。
- **阶段 9｜收尾**：更新 README、tests/scripts 的 import 全部走 `@info/*`；最终全量 typecheck+test。

每阶段是一个独立 commit，可随时停下/回退。

## 4. 验证基线

- 重构前基线：`pnpm typecheck` exit 0（已确认）。
- 每阶段后跑同样命令对比。
- 数据库 `data/context.sqlite` 不动；store schema 不动。

## 5. 解析机制（阶段 0 已验证）

用探针包实测确认了路线 A 的可行性与约束：

1. **tsx 直接解析 `.ts` 源**：包 `package.json` 写 `"exports": { ".": "./index.ts" }`，
   `node --import tsx` 能把 bare specifier `@info/x` 解析到源文件，**无需 build/dist**。
2. **关键约束——必须声明依赖**：workspace 包只有被 `package.json` 列为
   `"@info/x": "workspace:*"` 依赖后，pnpm 才在顶层 `node_modules/@info/x` 建软链。
   否则从 `tests/`、`scripts/` 等根目录运行时 **解析失败**（实测确认）。
   → 因此根 `package.json` 必须把所有 `@info/*` 包列为 dependencies（供 tests/scripts 解析）；
     各包之间的依赖也要在各自 `package.json` 声明（强制单向边界）。
3. **install 提速**：声明依赖后 `pnpm install --offline` 仅需数百 ms 重链，不重装 app 依赖。

### 每个 `@info/*` 包的 package.json 模板

```json
{
  "name": "@info/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.ts" },
  "dependencies": { "zod": "^3.24.4" }
}
```

下层包依赖上层包时在 `dependencies` 加 `"@info/core": "workspace:*"`。
每个包需要一个 `index.ts` barrel 作为对外入口（对应现有目录的 `index.ts`）。
