# Voice · 声学沙盒生存（3D 体素 Web 单机）

浏览器端 3D 体素「声学沙盒生存」游戏原型。当前为 **Sprint 2：第一人称移动 + 挖掘采集库存 + 存档初版**。

- 技术栈：Vite + TypeScript（strict）+ Three.js（WebGL2）+ Vitest
- 无后端、无外部网络依赖（全程离线可玩）。

## 目录结构

```
├─ index.html            # 入口（含早期 window.__app 骨架 + HUD/准星/库存栏）
├─ css/style.css         # 深色声学实验室风格样式
├─ src/
│  ├─ main.ts            # 启动编排（载档→生成世界→渲染→输入绑定→__app→循环）
│  ├─ config.ts          # 可调参数常量（唯一来源，含 S2 玩家物理/交互/存档常量）
│  ├─ materials.ts       # M2 材料表（唯一数据源，tech-design §3.1）
│  ├─ theme.ts           # 调色板单一常量源（材质 7 色 + 频段 3 色）
│  ├─ rng.ts             # 确定性种子 RNG（世界生成禁用 Math.random）
│  ├─ worldgen.ts        # 地形/矿脉/声源点/出生点生成（确定性）
│  ├─ world.ts           # M1 体素存储 + 索引公式 + DDA 遍历 + placed 标记
│  ├─ player.ts          # 确定性第一人称物理（重力/跳跃/AABB 碰撞）
│  ├─ pick.ts            # 体素拾取（唯一 DDA 实现处，复用 world.traverseVoxels）
│  ├─ save.ts            # M9 存档 v1（RLE+base64，schema 版本 + 损坏兜底）
│  ├─ game.ts            # S2 单权威运行时（世界/玩家/库存/挖掘/放置/存档）
│  ├─ bench.ts           # 性能 spike：DDA 射线遍历基准
│  ├─ apphook.ts         # M12 调试句柄 window.__app
│  ├─ ui.ts              # M10（最小子集）：材料面板 + 库存栏 + 进度/状态
│  └─ render/renderer.ts # M13 渲染（InstancedMesh + 第一人称相机 + 像素比单源）
├─ tests/                # Vitest（材料/世界/索引/句柄/S2 挖掘放置存档回环）
```

## 安装与启动

```bash
cd /e/Deep_Game/Voice
npm install
npm run dev        # http://localhost:5173/（默认端口；被占用时 Vite 顺延）
npm run test:unit  # Vitest 单测
npm run build      # tsc --noEmit + vite build
```

## 操作说明

- **移动**：`WASD`（或方向键）水平移动；`空格` 跳跃并受重力落地。玩家 AABB 与实体方块碰撞，不会穿墙或落入地下。
- **视角**：**右键按住并拖动**旋转视角（不强依赖 Pointer Lock）；也可**点击画布捕获指针**后移动鼠标转视角，按 `Esc`（或浏览器退出捕获）释放。
- **挖掘**：准星对准方块、**按住左键**持续命中，中央进度条满后天然方块被挖除，该材料入库存 +1；松开则进度重置。
- **放置**：`1-7` 热键或点击底部库存栏切换选中材料；**右键点击**把选中材料放到准星相邻的合法空格（库存 −1，放置后方块标记为「玩家放置」）。
- **拆除**：对玩家放置的方块按住左键（与挖掘同机制），完成后全额返还材料。
- **库存**：底部栏显示 7 种材料数量与当前选中高亮，随挖掘/放置/拆除/热键/`giveItem` 实时刷新；与 `window.__app.state.inventory/selected` 恒一致。
- 交互距离上限 6 格（`state.interactionReach` 可读）；超出距离或未命中时状态行给出中文提示。

## 存档

- 单档本地自动存档（`localStorage` 键 `voice.save.v1`，带 schema version）。
- 挖掘 / 放置 / 拆除 / 库存变化后**同帧自动写档**（无需手动保存按钮）；`state.lastSavedAt`（Unix 毫秒）每次写档后更新。
- 启动自动载入唯一存档；损坏 / 版本不兼容给出中文提示并回退全新世界（不白屏）；本地存储不可用（隐私模式）时捕获并提示，游戏仍可玩。
- 存档覆盖：世界方块（ids + placed 标记）、库存、玩家位置、种子。S2 方块耐久不单独序列化（统一取材料常量）。

## 调试句柄 `window.__app`

- `state`：`seed` / `worldSize` / `materials`（7 材料三频参数）/ `soundSources` /
  `player.spawn` / `player.pos`（脚底浮点坐标）/ `inventory` / `selected` / `placedBlocks` /
  `miningProgress`（0..1）/ `interactionReach`（6）/ `lastSavedAt` / `saveError` / `loadNotice` /
  `perf` / `blockAt(g)`（含 `placed`）/ `surfaceHeight(x,z)` / `surfaceHeights()`
- `reset()`：等价「新游戏」（换新种子 + 重置运行态 + 立即覆盖存档）
- `debug`：`regenerate(seed)` / `setMaterial(id,patch)` / `resetMaterials()` /
  `setGraphicTier('high'|'low')` / `benchRay(opts)` / `findMaterialBlocks(id)` /
  `giveItem(id,n)` / `teleport(pos)` / `saveNow()` / `loadSave()` / `clearSave()`

示例：

```js
window.__app.state.worldSize;              // [64, 64, 24]
window.__app.state.player.pos;             // 脚底浮点坐标 [x,y,z]
window.__app.state.surfaceHeight(10, 10);  // 该列地表高度（单列 number）
window.__app.debug.giveItem(1, 64);        // 给 64 个泡沫
window.__app.debug.teleport([32, 11, 32]); // 传送（校验/夹取输入）
window.__app.debug.saveNow();              // 手动写档（与自动保存同一 writeSave）
window.__app.debug.loadSave();             // 载入存档（'loaded'|'empty'|'invalid'）
window.__app.debug.clearSave();            // 仅删存档键，不动当前运行态
```

## 降级

- URL 带 `?nogl=1` 或浏览器不支持 WebGL2 时：显示中文降级提示（不白屏），`window.__app` 仍可用。
- `window.__app.debug.setGraphicTier('low')` 降低渲染像素比（`state.perf.pixelRatio` 可读）。
