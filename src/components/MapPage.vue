<!--
  地图主页面组件

  实现要点：
  1. 加载 TileLayer 底图（World_Terrain_Base）+ MapImageLayer 业务图层（USA）。
  2. 左上：搜索面板，支持
     - 输入框实时模糊查询（areaname 属性，按字符防抖 300ms 触发）
     - "搜索"按钮触发同样的属性模糊查询
     - 矩形框选按钮：调用 SketchViewModel 画矩形，对城市图层做 intersects 空间过滤
     - 查询结果列表：点击列表项时地图定位到该城市，并把蓝色定位图改成红色
  3. 右上：清除按钮（清除地图标记和列表）+ 人口信息按钮（弹出查询窗体）
-->
<template>
  <div class="map-page">
    <!-- ArcGIS MapView 的挂载容器 -->
    <div ref="mapEl" class="map-view"></div>

    <!-- 左上角搜索面板 -->
    <div class="search-panel">
      <div class="search-bar">
        <!-- 双向绑定 keyword，输入会触发 watch 中的实时模糊查询；回车也触发一次查询 -->
        <a-input
          v-model:value="keyword"
          class="search-input"
          allow-clear
          @press-enter="handleSearch"
        />
        <a-button type="primary" class="btn-search" @click="handleSearch">搜索</a-button>
        <!-- 框选按钮：drawing 为 true 时高亮，再次点击则取消框选 -->
        <a-button
          type="primary"
          :class="['btn-rect', { active: drawing }]"
          @click="toggleRectSelect"
        >
          <img :src="rectIcon" alt="rect" />
        </a-button>
      </div>

      <!-- 查询结果列表：activeIdx 表示当前点击高亮项 -->
      <div v-if="results.length" class="result-list">
        <div
          v-for="(item, idx) in results"
          :key="(item.objectid || idx) + '_' + idx"
          :class="['result-item', { active: idx === activeIdx }]"
          @click="onResultClick(idx)"
        >
          {{ item.areaname }}
        </div>
      </div>
    </div>

    <!-- 右上角动作按钮：清除 + 人口信息 -->
    <div class="action-bar">
      <a-button type="primary" class="action-btn" title="清除" @click="onClear">
        <img :src="clearIcon" alt="clear" />
      </a-button>
      <a-button type="primary" class="action-btn" title="人口信息" @click="popOpen = true">
        <img :src="popIcon" alt="population" />
      </a-button>
    </div>

    <!-- 人口信息查询弹窗 -->
    <PopulationModal v-model:open="popOpen" />
  </div>
</template>

<script setup>
import { ref, shallowRef, onMounted, onBeforeUnmount, watch } from 'vue';
// ArcGIS JS API 模块按需引入（npm 包 @arcgis/core 提供的 ES Modules 形式）
import EsriMap from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import TileLayer from '@arcgis/core/layers/TileLayer';
import MapImageLayer from '@arcgis/core/layers/MapImageLayer';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import SpatialReference from '@arcgis/core/geometry/SpatialReference';
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel';
import * as query from '@arcgis/core/rest/query';
import Query from '@arcgis/core/rest/support/Query';

// 标记图标资源（已在 src/assets/images 下本地化）
import markIcon from '@/assets/images/mark.png';        // 蓝色：所有查询结果
import lightMarkIcon from '@/assets/images/lightmark.png'; // 红色：当前点击的结果
import rectIcon from '@/assets/images/rectango.svg';
import clearIcon from '@/assets/images/clearAll.svg';
import popIcon from '@/assets/images/statepop.svg';

import PopulationModal from './PopulationModal.vue';

// 城市图层服务地址（USA MapServer 的 0 号子图层为 cities）
const CITY_LAYER_URL =
  'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/0';

// ===== 响应式状态 =====
const mapEl = ref(null);          // MapView 挂载用 DOM 容器引用
const keyword = ref('');          // 搜索输入框内容
// 查询结果列表使用 shallowRef + 普通对象。原因：Esri 的 Graphic / Accessor 对象
// 内部使用了 Proxy + 不可配置属性，若被 Vue 深度代理会与之冲突报错，
// 所以模板中只引用纯净 POJO（在 showResults 里转换）。
const results = shallowRef([]);
const activeIdx = ref(-1);        // 当前点击高亮的列表项索引
const drawing = ref(false);       // 是否处于框选绘制状态
const popOpen = ref(false);       // 人口查询弹窗是否打开

// ===== 非响应式 / 模块级变量 =====
let view = null;                  // MapView 实例
let cityMarkerLayer = null;       // 蓝色查询结果标记层
let selectedMarkerLayer = null;   // 红色当前选中标记层
let drawLayer = null;             // 框选绘制临时图层
let sketchVM = null;              // SketchViewModel 实例
let sketchHandler = null;         // SketchVM 的事件订阅句柄
let searchTimer = null;           // 输入防抖定时器
let queryToken = 0;               // 查询令牌：避免快速输入时旧响应覆盖新结果
let featureRefs = [];             // 与 results 一一对应的原始 Esri Feature 列表，
                                  // 用于点击列表项时定位（避免把 Esri 对象塞进响应式系统）

// 蓝色定位图（普通查询结果）
const blueSymbol = {
  type: 'picture-marker',
  url: markIcon,
  width: '24px',
  height: '24px'
};

// 红色定位图（当前点击的结果）
const redSymbol = {
  type: 'picture-marker',
  url: lightMarkIcon,
  width: '28px',
  height: '28px'
};

// ===== 生命周期：挂载时初始化地图 =====
onMounted(() => {
  // WebMercator 投影（与所用底图、业务图层一致）
  const sr = new SpatialReference({ wkid: 102100 });

  // 底图：World_Terrain_Base
  const baseLayer = new TileLayer({
    id: 'baseLayer',
    url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Terrain_Base/MapServer'
  });

  // 业务地图：MapImageLayer，仅显示 1 号子图层（高速公路），
  // 城市点（0 号子图层）通过查询的方式按需展现为标记
  const businessLayer = new MapImageLayer({
    id: 'businessLayer',
    url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer',
    sublayers: [{ id: 1, visible: true }]
  });

  // 三个 GraphicsLayer 用于绘制临时图形
  cityMarkerLayer = new GraphicsLayer({ id: 'cityMarkerLayer' });// 城市点
  selectedMarkerLayer = new GraphicsLayer({ id: 'selectedMarkerLayer' });// 查询到的城市点
  drawLayer = new GraphicsLayer({ id: 'drawLayer' });// 框选绘制临时图层

  // Map 容器；图层顺序决定叠加：先加底图，再业务图层，最后是查询/绘制层
  const map = new EsriMap({
    layers: [baseLayer, businessLayer, cityMarkerLayer, selectedMarkerLayer, drawLayer]
  });

  // 创建 MapView，初始范围定位在美国大陆
  view = new MapView({
    container: mapEl.value,
    map,
    center: [-98, 39],
    zoom: 4,
    spatialReference: sr,
    constraints: { rotationEnabled: false } // 禁止旋转，避免误操作
  });

  // 移除默认地图控件，仅保留版权信息
  view.ui.components = [];
});

// 组件卸载：销毁 MapView 与 SketchViewModel，释放资源
onBeforeUnmount(() => {
  stopDraw();
  if (view) {
    view.destroy();
    view = null;
  }
});

// ===== 输入框实时模糊查询（带防抖） =====
watch(keyword, (v) => {
  clearTimeout(searchTimer);
  const text = (v || '').trim();
  if (!text) {
    // 空内容直接清空显示
    cancelDisplay();
    return;
  }
  // 300ms 防抖，避免逐字符发请求
  searchTimer = setTimeout(() => doAttrQuery(text), 300);
});

// 清空地图标记 + 列表 + 高亮状态
function cancelDisplay() {
  results.value = [];
  featureRefs = [];
  activeIdx.value = -1;
  //JS短路逻辑：如果 cityMarkerLayer 存在则调用 removeAll()，否则不执行后续操作
  cityMarkerLayer && cityMarkerLayer.removeAll();
  selectedMarkerLayer && selectedMarkerLayer.removeAll();
}

// 转义 SQL 单引号，防止 where 语句注入
function escapeSql(s) {
  return s.replace(/'/g, "''"); // 将内容的'替换为''
}

// 属性模糊查询：areaname LIKE %text%（不区分大小写）
async function doAttrQuery(text) {
  const token = ++queryToken; // 记录当前令牌
  const q = new Query();
  // UPPER(...) 实现大小写不敏感的模糊匹配
  q.where = `UPPER(areaname) LIKE UPPER('%${escapeSql(text)}%')`;
  q.outFields = ['objectid', 'areaname', 'pop2000'];
  q.returnGeometry = true;
  q.outSpatialReference = view.spatialReference;

  try {
    const res = await query.executeQueryJSON(CITY_LAYER_URL, q);
    // 若已有更新的查询发起，丢弃当前回包，避免旧结果覆盖
    if (token !== queryToken) return;
    showResults(res.features);
  } catch (e) {
    console.error('Attribute query error', e);
  }
}

// 点击"搜索"按钮：触发一次属性模糊查询
function handleSearch() {
  const text = (keyword.value || '').trim();
  if (!text) return;
  doAttrQuery(text);
}

// 空间过滤查询：根据传入几何对城市图层做 intersects 过滤
async function doSpatialQuery(geometry) {
  const token = ++queryToken;
  const q = new Query();
  q.geometry = geometry;
  q.spatialRelationship = 'intersects'; // 需求要求的空间关系
  q.outFields = ['objectid', 'areaname', 'pop2000'];
  q.returnGeometry = true;
  q.outSpatialReference = view.spatialReference;

  try {
    const res = await query.executeQueryJSON(CITY_LAYER_URL, q);
    if (token !== queryToken) return;
    showResults(res.features);
  } catch (e) {
    console.error('Spatial query error', e);
  }
}

// 渲染查询结果：列表 + 蓝色标记
function showResults(features) {
  // 原始 Esri Feature 留在非响应式数组里，供点击定位使用
  featureRefs = features;
  // 模板里只用到 areaname / objectid，把它们提取成 POJO 防止响应式踩到 Esri 代理
  results.value = features.map((f) => ({
    objectid: f.attributes && f.attributes.objectid,// 防止数据为空报错
    areaname: f.attributes && f.attributes.areaname,
    pop2000: f.attributes && f.attributes.pop2000
  }));
  activeIdx.value = -1;
  cityMarkerLayer.removeAll();
  selectedMarkerLayer.removeAll();
  // 在地图上撒蓝色定位图
  features.forEach((f) => {
    cityMarkerLayer.add(
      new Graphic({
        geometry: f.geometry,
        symbol: blueSymbol,
        attributes: { ...f.attributes } // 用这个，是复制一个对象
      })
    );
  });
}

// 点击结果列表项：把对应位置画成红色定位图，并把视图飞到该点
function onResultClick(idx) {
  const feature = featureRefs[idx];
  if (!feature) return;
  activeIdx.value = idx;
  selectedMarkerLayer.removeAll();
  selectedMarkerLayer.add(
    new Graphic({
      geometry: feature.geometry,
      symbol: redSymbol
    })
  );
  // goTo 会使用动画切换中心和缩放级别
  view.goTo({ target: feature.geometry, zoom: Math.max(view.zoom, 7) });
}

// ===== 框选切换：点开则进入绘制，再次点则取消 =====
function toggleRectSelect() {
  if (drawing.value) {
    stopDraw();
    return;
  }
  startDraw();
}

// 启动框选绘制
function startDraw() {
  drawing.value = true;
  drawLayer.removeAll();

  // 创建 SketchViewModel，控制矩形画在 drawLayer 上
  sketchVM = new SketchViewModel({
    layer: drawLayer,
    view,
    polygonSymbol: {
      type: 'simple-fill',
      color: [3, 255, 240, 0.1],
      outline: { style: 'solid', color: [255, 0, 0], width: 2 }
    }
  });

  // freehand 模式：按下鼠标拖动即可画矩形
  sketchVM.create('rectangle', { mode: 'freehand' });

  // 监听绘制事件
  sketchHandler = sketchVM.on('create', (event) => {
    if (event.state === 'complete') {
      // 绘制完成时使用矩形 geometry 做空间过滤查询
      doSpatialQuery(event.graphic.geometry);
      stopDraw();
    } else if (event.state === 'cancel') {
      stopDraw();
    }
  });
}

// 关闭框选模式 + 清理状态
function stopDraw() {
  if (drawLayer) drawLayer.removeAll();
  if (sketchHandler) {
    sketchHandler.remove();
    sketchHandler = null;
  }
  if (sketchVM) {
    sketchVM.cancel();
    sketchVM = null;
  }
  drawing.value = false;
}

// 清除按钮：地图标记 + 列表都清空
function onClear() {
  cancelDisplay();
}
</script>

<style lang="scss" scoped>
.map-page {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.map-view {
  width: 100%;
  height: 100%;
}

// 搜索面板：固定在地图左上角
.search-panel {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 280px;
  z-index: 10;

  .search-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #fff;
    padding: 6px 8px;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);

    .search-input {
      flex: 1;
      min-width: 0;
    }

    .btn-search {
      flex: 0 0 auto;
    }

    // 框选图标按钮，激活时颜色加深
    .btn-rect {
      padding: 0;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;

      img {
        width: 16px;
        height: 16px;
        // 把彩色 svg 反相为白色，与蓝底按钮搭配
        filter: brightness(0) invert(1);
      }

      &.active {
        background: #096dd9;
      }
    }
  }

  // 查询结果下拉列表
  .result-list {
    margin-top: 6px;
    max-height: 360px;
    overflow-y: auto;
    background: #fff;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);

    .result-item {
      padding: 8px 12px;
      cursor: pointer;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: #f5f5f5;
      }

      // 当前点击的项高亮
      &.active {
        background: #e6f4ff;
        color: #1677ff;
      }
    }
  }
}

// 右上角的两个动作按钮（清除 / 人口信息）
.action-bar {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 8px;
  z-index: 10;

  .action-btn {
    width: 38px;
    height: 38px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    img {
      width: 20px;
      height: 20px;
      filter: brightness(0) invert(1);
    }
  }
}
</style>
