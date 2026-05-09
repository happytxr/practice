// Vite 配置：开启 Vue SFC 支持，并把 @ 别名指向 src
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // 在源码中可使用 @/components/... 这样的导入路径
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    open: true
  }
});
