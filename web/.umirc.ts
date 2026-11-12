import { defineConfig } from 'umi';

export default defineConfig({
  title: 'OIS · 全局搜索',
  routes: [{ path: '/', component: 'index' }],
  mfsu: false,
  npmClient: 'npm',
  proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT || 4107}`, changeOrigin: true } },
});
