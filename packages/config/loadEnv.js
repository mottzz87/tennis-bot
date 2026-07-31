const path = require('path')
const dotenv = require('dotenv')

// 仓库根目录（packages/config → 上二级）
const ROOT = path.resolve(__dirname, '..', '..')

/**
 * 加载环境变量，`.env.local` 优先、缺失字段回退 `.env`：
 *   - 本地开发：编辑 `.env.local` 即可覆盖端口/Token 等，不依赖线上 `.env`
 *   - 线上：通常只有 `.env`，`.env.local` 不存在时仅加载 `.env`
 */
function loadEnv() {
  dotenv.config({
    path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')],
    quiet: true
  })
}

module.exports = loadEnv
