# Voice · 声学沙盒生存（3D 体素 Web 单机）

浏览器端 3D 体素「声学沙盒生存」游戏原型。当前为 **Sprint 1：世界与材料底座**。

- 技术栈：Vite + TypeScript（strict）+ Three.js（WebGL2）+ Vitest
- 无后端、无外部网络依赖。

## 目录结构

```
├─ index.html            # 入口（含早期 window.__app 骨架）
├─ css/style.css         # 深色声学实验室风格样式
├─ src/
│  ├─ main.ts            # 启动编排（生成世界→渲染→__app→面板）
│  ├─ config.ts          # 可调参数常量（唯一来源）
│  ├─ materials.ts       # M2 材料表（唯一数据源，tech-design §3.1）
│  ├─ rng.ts             # 确定性种子 RNG（世界生成禁用 Math.random）
│  ├─ worldgen.ts        # 地形/矿脉/声源点/出生点生成（确定性）
│  ├─ world.ts           # M1 体素存储 + 索引公式 + DDA 射线遍历
│  ├─ bench.ts           # 性能 spike：DDA 射线遍历基准
│  ├─ apphook.ts         # M12 调试句柄 window.__app
│  ├─ ui.ts              # M10（最小子集）：F2.3 材料参数面板
│  └─ render/renderer.ts # M13 渲染骨架（InstancedMesh + 轨道相机）
├─ tests/                # Vitest（材料方向性/世界一致性/体素索引）
```

## 安装与启动

```bash
cd /e/Deep_Game/Voice
npm install
npm run dev        # http://localhost:5173/（默认端口；被占用时 Vite 顺延）
npm run test:unit  # Vitest 单测
npm run build      # tsc --noEmit + vite build
```

## 调试句柄 `window.__app`

- `state`：`seed` / `worldSize` / `materials`（7 材料三频参数）/ `soundSources` /
  `player.spawn` / `perf` / `blockAt(g)` / `surfaceHeight(x,z)`
- `reset()`：等价「新游戏」（换种子 + 恢复默认材料参数）
- `debug`：`regenerate(seed)` / `setMaterial(id,patch)` / `resetMaterials()` /
  `setGraphicTier('high'|'low')` / `benchRay(opts)` / `findMaterialBlocks(id)`

示例：

```js
window.__app.state.worldSize;              // [64, 64, 24]
window.__app.state.surfaceHeight(10, 10);  // 该列地表高度（单列）
window.__app.state.surfaceHeight();           // 无参：64×64 扁平高度数组（x + 64*z 序）
window.__app.debug.findMaterialBlocks(5);  // 金属方块坐标列表
window.__app.debug.benchRay({ rays: 128, bounces: 3 });
```

## 降级

- URL 带 `?nogl=1` 或浏览器不支持 WebGL2 时：显示中文降级提示（不白屏），`window.__app` 仍可用。
- `window.__app.debug.setGraphicTier('low')` 降低渲染像素比（`state.perf.pixelRatio` 可读）。
