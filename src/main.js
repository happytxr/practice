// 应用入口：创建 Vue 实例、注册 Ant Design Vue、配置 ArcGIS JS API 资源路径

import { createApp } from 'vue';
import Antd from 'ant-design-vue';
// esriConfig 用于配置 ArcGIS JS API 的全局参数（资源路径、API Key 等）
import esriConfig from '@arcgis/core/config';

// 全局样式：Ant Design Vue 重置样式 + ArcGIS 主题样式 + 项目自定义样式
import 'ant-design-vue/dist/reset.css';
import '@arcgis/core/assets/esri/themes/light/main.css';
import './styles/index.scss';

import App from './App.vue';

// 将 ArcGIS JS API 运行时所需的图片、字体、Worker 等资源指向本地路径，
// 实现"资源本地化"。资源由 scripts/copy-arcgis-assets.cjs 脚本在
// npm install 后自动从 node_modules/@arcgis/core/assets 复制到 public/arcgis/assets。
esriConfig.assetsPath = `${import.meta.env.BASE_URL}arcgis/assets`;

const app = createApp(App);

// 全局异常捕获，便于排查渲染或异步流程中的错误
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue error]', info, err && err.stack ? err.stack : err);
};

// 注册 Ant Design Vue 全部组件并挂载到 #app
app.use(Antd).mount('#app');
