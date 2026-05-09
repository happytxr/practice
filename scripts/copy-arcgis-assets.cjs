/**
 * ArcGIS JS API 资源本地化脚本
 *
 * 由 npm install 的 postinstall 阶段（或手动 npm run copy-arcgis-assets）触发，
 * 把 node_modules/@arcgis/core/assets 下的图片/字体/Worker 等运行时资源复制到
 * public/arcgis/assets 目录。运行时再通过 esriConfig.assetsPath = '/arcgis/assets'
 * 让 ArcGIS JS API 从本地路径加载这些资源（参见 src/main.js）。
 *
 * 之所以使用手写的递归而不是 fs.cpSync({recursive: true})，是因为在某些 Windows
 * 环境下后者会触发 Node 进程崩溃（路径较深 + 包含中文）。
 */
const fs = require('fs');
const path = require('path');

// 源目录：npm 包内的 assets
const src = path.resolve(__dirname, '..', 'node_modules', '@arcgis', 'core', 'assets');
// 目标目录：public/arcgis/assets，Vite 构建时会作为静态资源原样复制到 dist
const dest = path.resolve(__dirname, '..', 'public', 'arcgis', 'assets');

// 若 @arcgis/core 还未安装（npm install 的早期阶段），跳过即可
if (!fs.existsSync(src)) {
  console.warn('[copy-arcgis-assets] @arcgis/core/assets not found, skipping.');
  process.exit(0);
}

// 递归复制目录
function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  const entries = fs.readdirSync(s, { withFileTypes: true });
  for (const entry of entries) {
    const sp = path.join(s, entry.name);
    const dp = path.join(d, entry.name);
    if (entry.isDirectory()) {
      copyDir(sp, dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

try {
  // 先清理旧的目标目录，确保不残留过期资源
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  copyDir(src, dest);
  console.log('[copy-arcgis-assets] Copied to', dest);
} catch (e) {
  console.error('[copy-arcgis-assets] Failed:', e.message);
  process.exit(1);
}
