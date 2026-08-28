# Voice · 声学沙盒生存（3D 体素 Web 单机）

浏览器端 3D 体素「声学沙盒生存」游戏原型。当前为 **Sprint 3：轨道俯瞰 + 合成/设施基础 + 最小时钟/存档 v2**。

- 技术栈：Vite + TypeScript（strict）+ Three.js（WebGL2）+ Vitest
- 无后端、无外部网络依赖（全程离线可玩）。

## 目录结构

```
├─ index.html            # 入口（含早期 window.__app 骨架 + HUD/准星/库存/合成面板）
├─ css/style.css         # 深色声学实验室风格样式
├─ src/
│  ├─ main.ts            # 启动编排（载档→生成世界→渲染→输入绑定→__app→循环）
│  ├─ config.ts          # 可调参数常量（唯一来源，含 S2/S3 玩家物理/交互/存档/时钟常量）
│  ├─ materials.ts       # M2 材料表（唯一数据源，tech-design §3.1）
│  ├─ recipes.ts         # S3 配方/物品/设施定义（唯一数据源）
│  ├─ theme.ts           # 调色板单一常量源（材质 7 色 + 频段 3 色 + 设施色）
│  ├─ rng.ts             # 确定性种子 RNG（世界生成禁用 Math.random）
│  ├─ worldgen.ts        # 地形/矿脉/声源点/出生点生成（确定性）
│  ├─ world.ts           # M1 体素存储 + 索引公式 + DDA 遍历 + placed 标记 + 设施 Map
│  ├─ player.ts          # 确定性第一人称物理（重力/跳跃/AABB 碰撞，设施视为实体）
│  ├─ pick.ts            # 体素拾取（唯一 DDA 实现处，设施可被拾取/放置相邻）
│  ├─ save.ts            # M9 存档 v2（RLE+base64，schema 版本 + v1 迁移 + 损坏兜底）
│  ├─ game.ts            # S3 单权威运行时（世界/玩家/库存/合成/设施/时钟/存档）
│  ├─ bench.ts           # 性能 spike：DDA 射线遍历基准
│  ├─ apphook.ts         # M12 调试句柄 window.__app
│  ├─ ui.ts              # M10（最小子集）：材料面板 + 库存/合成 + 进度/状态
│  └─ render/renderer.ts # M13 渲染（InstancedMesh + 第一/俯瞰双相机 + 设施网格）
├─ tests/                # Vitest（材料/世界/索引/句柄/S2/S3）
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

- **移动**：`WASD`（或方向键）水平移动；`空格` 跳跃并受重力落地。玩家 AABB 与实体方块/设施碰撞。
- **视角**：第一人称**右键按住并拖动**旋转视角；也可点击画布捕获指针后移动鼠标转视角，`Esc` 释放。
- **俯瞰**：按 `C` 或点击顶部“切换视角（C）”按钮在第一人称 ↔ 轨道俯瞰间切换。俯瞰中**左键拖动旋转**、**右键拖动平移**、**滚轮缩放**；切回第一人称后玩家位置不变，游戏不暂停。
- **挖掘**：准星对准方块、**按住左键**持续命中，进度满后天然方块被挖除，该材料入库存 +1。
- **放置**：`1-9` 热键或点击底部库存槽切换选中；**右键点击**把选中材料/设施放到准星相邻的合法空格（库存 −1）。`1-7` 为材料，`8-12` 为设施物品。
- **拆除**：玩家放置的方块按左键挖掘；已放置设施通过调试句柄/后续 UI 拆除，返还对应设施物品。
- **合成**：左下面板列出 5 个配方（能量核心/声波炮/声学探针/声导管/中继器），点击“合成”按钮按配方扣材料并产出设施物品；库存不足时显示失败提示。
- **设施旋转**：准星对着已放置设施按 `R` 键，每次旋转 90°（π/2 弧度）。
- 交互距离上限 6 格（`state.interactionReach` 可读）。

## 存档

- 单档本地自动存档（`localStorage` 键 `voice.save.v1`，**schema v2**）。
- 挖掘 / 放置 / 合成 / 设施变化后同帧自动写档；玩家移动与**时钟推进**共享节流自动保存（默认 2s），静止时 `timeOfDay` 变化也会落盘。
- 启动自动载入唯一存档；损坏 / 版本 0、3+ 给出中文提示并回退全新世界；旧 v1 档自动迁移（库存补零到 13、selected 夹取、设施空、`timeOfDay=0/day=0`，下次写档为 v2）。
- 存档覆盖：世界方块（ids + placed 标记）、库存（13 长度）、selected、玩家位置、设施列表、`timeOfDay`、`day`、种子。

## 调试句柄 `window.__app`

- `state`：`seed` / `worldSize` / `materials` / `soundSources` /
  `player.pos/vel/yaw/pitch/grounded/viewMode` / `orbit{distance,yaw,pitch,target}` /
  `timeOfDay` / `day` / `dayLengthSeconds` / `recipes` / `facilityDefs` / `facilities` /
  `inventory`（13 长度）/ `selected` / `placedBlocks` / `miningProgress` / `interactionReach` /
  `lastSavedAt` / `saveError` / `loadNotice` / `uiNotice` / `perf` / `blockAt(g)` /
  `surfaceHeight(x,z)` / `surfaceHeights()`
- `reset()`：等价「新游戏」（换新种子 + 重置运行态 + 立即覆盖存档）
- `debug`：`regenerate(seed)` / `setMaterial(id,patch)` / `resetMaterials()` /
  `setGraphicTier('high'|'low')` / `benchRay(opts)` / `findMaterialBlocks(id)` /
  `giveItem(id,n)`（1..12）/ `teleport(pos)` / `saveNow()` / `loadSave()` / `clearSave()` /
  `setViewMode('first'|'orbit')` / `setOrbit(patch)` / `craft(recipeId)` /
  `placeFacility(kind,cell,yaw?)` / `rotateFacility(cell,deltaRadians?)` / `removeFacility(cell)`

示例：

```js
window.__app.state.worldSize;              // [64, 64, 24]
window.__app.state.player.viewMode;        // 'first' | 'orbit'
window.__app.state.timeOfDay;              // [0,1)
window.__app.debug.giveItem(8, 1);         // 给 1 个能量核心
window.__app.debug.craft(1);               // 合成能量核心
window.__app.debug.placeFacility('core', [20, 18, 20], 0);
window.__app.debug.rotateFacility([20, 18, 20]); // 旋转 π/2
window.__app.debug.removeFacility([20, 18, 20]);
window.__app.debug.saveNow();
```

## 降级

- URL 带 `?nogl=1` 或浏览器不支持 WebGL2 时：显示中文降级提示（不白屏），`window.__app` 仍可用。
- `window.__app.debug.setGraphicTier('low')` 降低渲染像素比（`state.perf.pixelRatio` 可读）。
