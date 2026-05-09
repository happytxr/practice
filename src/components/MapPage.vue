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

        <!-- 多边形框选按钮：drawingPolygon 为 true 时高亮，再次点击则取消；点击后在地图上依次点击落点，双击结束绘制 -->
        <a-button
          type="primary"
          :class="['btn-rect', { active: drawingPolygon }]"
          @click="togglePolygonSelect"
        >
          <img :src="polygonIcon" alt="polygon" />
        </a-button>
        
        <!-- 框选按钮：drawing 为 true 时高亮，再次点击则取消框选 -->
        <!-- 当 drawing 为 true 时，按钮高亮显示 -->
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

    <!-- 右上角动作按钮：清除 + 州区域专题 + 人口信息 -->
    <div class="action-bar">
      <a-button type="primary" class="action-btn" title="清除" @click="onClear">
        <img :src="clearIcon" alt="clear" />
      </a-button>
      <!-- 州区域专题按钮：点击切换；激活时按钮高亮，地图按 sub_region 着色，并显示右下角图例 -->
      <a-button
        type="primary"
        :class="['action-btn', { active: regionThemeOn }]"
        title="州区域专题"
        @click="toggleRegionTheme"
      >
        <img :src="stateRegionIcon" alt="state-region" />
      </a-button>
      <!-- 州人口专题按钮：与区域专题互斥；激活时地图按 pop2000 数值分级着色，显示人口图例 -->
      <a-button
        type="primary"
        :class="['action-btn', { active: popThemeOn }]"
        title="州人口专题"
        @click="togglePopTheme"
      >
        <img :src="popThemeIcon" alt="state-population" />
      </a-button>
      <a-button type="primary" class="action-btn" title="人口信息" @click="popOpen = true">
        <img :src="popIcon" alt="population" />
      </a-button>
    </div>

    <!-- 州信息弹窗：弹窗的"尾巴尖"锚定在 statePopup.x/y（即点击位置），通过 CSS transform 把整体浮在点击点上方 -->
    <div
      v-if="statePopup"
      class="state-popup"
      :style="{ left: statePopup.x + 'px', top: statePopup.y + 'px' }"
    >
      <div class="state-popup-header">
        <span class="title">州信息</span>
        <span class="close-btn" @click="closeStatePopup">×</span>
      </div>
      <div class="state-popup-body">
        <div><span class="lbl">州名：</span>{{ statePopup.state_name }}</div>
        <div><span class="lbl">区域：</span>{{ statePopup.sub_region }}</div>
        <div><span class="lbl">州缩写：</span>{{ statePopup.state_abbr }}</div>
        <div><span class="lbl">人口：</span>{{ statePopup.pop2000 }}</div>
      </div>
    </div>

    <!-- 右下角堆叠：区域图例 / 人口图例（互斥显示） + 缩放控件（始终显示） -->
    <div class="bottom-right-stack">
      <!-- 州区域图例：固定尺寸 + 滚动条；颜色块用 trapezoid.svg 做 mask -->
      <div v-if="regionThemeOn" class="region-legend">
        <div class="region-legend-title">州区域专题图例</div>
        <div class="region-legend-list">
          <div
            v-for="r in regionDefs"
            :key="r.value"
            :class="['region-item', { disabled: hiddenRegions.includes(r.value) }]"
            @click="toggleRegion(r.value)"
          >
            <span
              class="color-box"
              :style="{
                backgroundColor: hiddenRegions.includes(r.value)
                  ? '#bbb'
                  : `rgb(${r.color[0]}, ${r.color[1]}, ${r.color[2]})`,
                maskImage: `url(${trapezoidIcon})`,
                WebkitMaskImage: `url(${trapezoidIcon})`
              }"
            ></span>
            <span class="label">{{ r.value }}</span>
          </div>
        </div>
      </div>

      <!-- 州人口专题图例：横线上只有标题；横线下右侧"单位:百万"红字；3 个梯形色块（与区域图例一致，复用 trapezoid mask）-->
      <div v-if="popThemeOn" class="pop-legend">
        <div class="pop-legend-header">
          <div class="title">州人口专题图例</div>
        </div>
        <!-- 横线之下、列表之上：单位说明，独立一行右对齐 -->
        <div class="pop-legend-unit">单位:百万</div>
        <div class="pop-legend-list">
          <div
            v-for="p in popDefs"
            :key="p.value"
            :class="['pop-item', { disabled: hiddenPops.includes(p.value) }]"
            @click="togglePopRange(p.value)"
          >
            <!-- 梯形色块：背景色按区间或灰色，mask 用 trapezoid.svg -->
            <span
              class="color-box"
              :style="{
                backgroundColor: hiddenPops.includes(p.value)
                  ? '#bbb'
                  : `rgb(${p.color[0]}, ${p.color[1]}, ${p.color[2]})`,
                maskImage: `url(${trapezoidIcon})`,
                WebkitMaskImage: `url(${trapezoidIcon})`
              }"
            ></span>
            <span class="label">{{ p.label }}</span>
          </div>
        </div>
      </div>

      <!-- 地图缩放控件：右下角 + / - 按钮 -->
      <div class="zoom-controls">
        <button class="zoom-btn" title="放大" @click="zoomIn">+</button>
        <button class="zoom-btn" title="缩小" @click="zoomOut">−</button>
      </div>
    </div>

    <!-- 右侧图层选择器：勾选/取消勾选可显示或隐藏对应子图层 -->
    <div class="layer-panel">
      <div class="layer-title">图层</div>
      <!-- a-checkbox-group 双向绑定 visibleLayerIds 数组（数组里有哪个 id 就显示哪个图层） -->
      <a-checkbox-group v-model:value="visibleLayerIds" class="layer-checkbox-group">
        <a-checkbox
          v-for="layer in layerOptions"
          :key="layer.id"
          :value="layer.id"
          class="layer-checkbox"
        >
          {{ layer.label }}
        </a-checkbox>
      </a-checkbox-group>
    </div>

    <!-- 人口信息查询弹窗 -->
    <PopulationModal v-model:open="popOpen" />
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch } from 'vue';
// ArcGIS JS API 模块按需引入（npm 包 @arcgis/core 提供的 ES Modules 形式）
import EsriMap from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import TileLayer from '@arcgis/core/layers/TileLayer';
import MapImageLayer from '@arcgis/core/layers/MapImageLayer';
// FeatureLayer 用于"州区域专题"：客户端单独加一个 States 矢量图层，
// 这样可以本地控制 renderer（按 sub_region 着色）与 definitionExpression（按图例过滤）
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
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
// 多边形框选按钮图标
import polygonIcon from '@/assets/images/polygon.svg';
import clearIcon from '@/assets/images/clearAll.svg';
import popIcon from '@/assets/images/statepop.svg';
// 州区域专题按钮图标
import stateRegionIcon from '@/assets/images/stateregion.svg';
// 州人口专题按钮图标（用 pointselect.svg，避免与现有"人口信息"按钮的 statepop.svg 重复）
import popThemeIcon from '@/assets/images/pointselect.svg';
// 图例使用的梯形图标（用 CSS mask 着色，便于按区域上色 / 灰化）
import trapezoidIcon from '@/assets/images/trapezoid.svg';

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
const drawing = ref(false);       // 是否处于矩形框选绘制状态
const drawingPolygon = ref(false); // 是否处于多边形框选绘制状态（与矩形互斥）
const popOpen = ref(false);       // 人口查询弹窗是否打开

// ===== 图层选择器配置 =====
// USA MapServer 提供 4 个子图层：0 Cities / 1 Highways / 2 States / 3 Counties
// label 用作复选框文本，id 与 MapServer 子图层 id 对应
const layerOptions = [
  { id: 0, label: 'Cities' },
  { id: 1, label: 'Highways' },
  { id: 2, label: 'States' },
  { id: 3, label: 'Counties' }
];
// 默认勾选 Cities / Highways / States（与设计稿一致，Counties 默认不勾选）
const visibleLayerIds = ref([0, 1, 2]);

// ===== 州区域专题配置 =====
// States 子图层（id=2）的服务地址，专题用 FeatureLayer 单独加载它
const STATES_LAYER_URL =
  'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/2';

// 9 个 sub_region 分区与对应配色（颜色尽量贴近设计稿，按需可微调）
// value 必须与服务端 sub_region 字段值一一对应
const regionDefs = [
  { value: 'Mtn',     color: [228, 26, 28] },    // 红
  { value: 'N Eng',   color: [255, 127, 0] },    // 橙
  { value: 'W N Cen', color: [166, 118, 100] },  // 棕
  { value: 'E N Cen', color: [55, 126, 34] },    // 绿
  { value: 'Pacific', color: [255, 184, 197] },  // 粉
  { value: 'Mid Atl', color: [33, 99, 197] },    // 深蓝
  { value: 'W S Cen', color: [200, 30, 30] },    // 暗红
  { value: 'E S Cen', color: [126, 199, 240] },  // 浅蓝
  { value: 'S Atl',   color: [127, 39, 159] }    // 紫
];

// 当前激活的专题：null | 'region'(州区域) | 'pop'(州人口)
// 同一时间只能开一个，互斥；切换专题时旧的会被自动停掉
const currentTheme = ref(null);
const regionThemeOn = computed(() => currentTheme.value === 'region');
const popThemeOn = computed(() => currentTheme.value === 'pop');

// 当前在图例中被点掉（隐藏）的分区 value 列表（区域专题用）
const hiddenRegions = ref([]);
// 当前在图例中被点掉（隐藏）的人口分组 value 列表（人口专题用）
const hiddenPops = ref([]);
// 州信息弹窗数据：{ x, y, state_name, sub_region, state_abbr, pop2000 } 或 null
const statePopup = ref(null);

// ===== 州人口专题配置 =====
// 3 个人口区间（单位：实际人口；图例显示时除以 100 万 = "百万"）
// 颜色与设计稿对应：4< 棕、4-8 绿、>8 红
const popDefs = [
  { value: '<4',  label: '4<',  color: [166, 118, 100], min: 0,        max: 4000000 },
  { value: '4-8', label: '4-8', color: [55, 126, 34],   min: 4000000,  max: 8000000 },
  { value: '>8',  label: '>8',  color: [228, 26, 28],   min: 8000000,  max: Number.MAX_SAFE_INTEGER }
];

// ===== 非响应式 / 模块级变量 =====
let view = null;                  // MapView 实例
let businessLayer = null;         // USA MapImageLayer 实例（图层选择器用其 sublayers 控制显隐）
let stateThemeLayer = null;       // 州区域专题 FeatureLayer（启用时挂到 map，关闭时移除）
let stateClickHandler = null;     // view.on('click') 句柄，仅在专题模式下监听州点击
let selectedStateLayer = null;    // 红色加粗高亮层：被点击的州的边框
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

  // 业务地图：MapImageLayer，预先声明全部 4 个子图层并赋上初始可见性，
  // 这样图层选择器可以通过 findSublayerById 切换 visible
  // 关键：sublayers 数组顺序 = 图层叠放顺序，**数组第一个元素绘制在最上层**，最后一个在最下层
  // 当前期望顺序：Cities(顶) → Highways → States → Counties(底)
  businessLayer = new MapImageLayer({
    id: 'businessLayer',
    url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer',
    sublayers: [
      { id: 3, visible: false },   
      { id: 2, visible: true },   
      { id: 1, visible: true },   
      { id: 0, visible: true }   
    ]
  });

  // 三个 GraphicsLayer 用于绘制临时图形
  cityMarkerLayer = new GraphicsLayer({ id: 'cityMarkerLayer' });// 城市点
  selectedMarkerLayer = new GraphicsLayer({ id: 'selectedMarkerLayer' });// 查询到的城市点
  drawLayer = new GraphicsLayer({ id: 'drawLayer' });// 框选绘制临时图层
  // 州区域专题点击时，把命中州的轮廓画到这一层（红色加粗），位于 businessLayer 之上
  selectedStateLayer = new GraphicsLayer({ id: 'selectedStateLayer' });

  // Map 容器；图层顺序决定叠加（数组靠前 = 渲染在更下层）：
  // baseLayer → businessLayer(Cities/Highways/States/Counties) → selectedStateLayer(高亮) → 搜索/绘制层
  const map = new EsriMap({
    layers: [baseLayer, businessLayer, selectedStateLayer, cityMarkerLayer, selectedMarkerLayer, drawLayer]
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

// ===== 图层选择器：监听勾选状态变化，同步更新 MapImageLayer 子图层 visible =====
// 用 deep 是因为 v-model 会替换数组引用，但 ref 数组的 push/splice 也要监听
watch(visibleLayerIds, (ids) => {
  if (!businessLayer) return;
  layerOptions.forEach((opt) => {
    // findSublayerById 返回 Sublayer 实例，直接给 visible 赋值即可触发地图刷新
    const sub = businessLayer.findSublayerById(opt.id);
    if (sub) sub.visible = ids.includes(opt.id);
  });
}, { deep: true });

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
  // 若当前在多边形绘制中，先停掉再切到矩形（两种模式互斥）
  if (drawingPolygon.value) stopDraw();
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

// 关闭框选模式 + 清理状态（矩形 / 多边形 共用一套 sketchVM，所以一并清理）
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
  // 同步清掉多边形高亮状态，避免按钮残留 active 样式
  drawingPolygon.value = false;
}

// ===== 多边形框选切换：点开则进入绘制，再次点则取消；与矩形框选互斥 =====
function togglePolygonSelect() {
  // 已在多边形绘制中：再次点击则取消
  if (drawingPolygon.value) {
    stopDraw();
    return;
  }
  // 若当前在矩形绘制中，先停掉再切到多边形
  if (drawing.value) stopDraw();
  startDrawPolygon();
}

// 启动多边形框选绘制
function startDrawPolygon() {
  drawingPolygon.value = true;
  drawLayer.removeAll();

  // 创建 SketchViewModel，控制多边形画在 drawLayer 上（样式与矩形保持一致）
  sketchVM = new SketchViewModel({
    layer: drawLayer,
    view,
    polygonSymbol: {
      type: 'simple-fill',
      color: [3, 255, 240, 0.1],
      outline: { style: 'solid', color: [255, 0, 0], width: 2 }
    }
  });

  // 多边形采用 click 模式：在地图上依次点击落点，双击结束绘制
  sketchVM.create('polygon', { mode: 'click' });

  // 监听绘制事件：完成或取消时分别处理
  sketchHandler = sketchVM.on('create', (event) => {
    if (event.state === 'complete') {
      // 绘制完成：用多边形 geometry 做空间过滤查询
      doSpatialQuery(event.graphic.geometry);
      stopDraw();
    } else if (event.state === 'cancel') {
      stopDraw();
    }
  });
}

// 清除按钮：地图标记 + 列表都清空
function onClear() {
  cancelDisplay();
}

// ===== 州专题切换入口（区域 / 人口 互斥）=====
function toggleRegionTheme() {
  if (currentTheme.value === 'region') stopStateTheme();
  else startStateTheme('region');
}
function togglePopTheme() {
  if (currentTheme.value === 'pop') stopStateTheme();
  else startStateTheme('pop');
}

// 构造 UniqueValueRenderer：按 sub_region 字段值匹配不同填充色
function buildRegionRenderer() {
  return {
    type: 'unique-value',
    field: 'sub_region',
    // 没匹配到的州（理论上不会出现）用浅灰兜底
    defaultSymbol: {
      type: 'simple-fill',
      color: [200, 200, 200, 0.6],
      outline: { color: [80, 80, 80], width: 0.5 }
    },
    // 把 regionDefs 映射成 ArcGIS 所需的 uniqueValueInfos
    uniqueValueInfos: regionDefs.map((r) => ({
      value: r.value,
      symbol: {
        type: 'simple-fill',
        color: [...r.color, 0.85],   // 带一点透明度，避免完全盖住底图
        outline: { color: [50, 50, 50], width: 0.5 }
      }
    }))
  };
}

// 构造 ClassBreaksRenderer：按 pop2000 数值落入哪个区间匹配填充色
function buildPopulationRenderer() {
  return {
    type: 'class-breaks',
    field: 'pop2000',
    classBreakInfos: popDefs.map((p) => ({
      minValue: p.min,
      maxValue: p.max,
      symbol: {
        type: 'simple-fill',
        color: [...p.color, 0.85],
        outline: { color: [50, 50, 50], width: 0.5 }
      }
    }))
  };
}

// 启动专题（'region' 或 'pop'）：根据 themeName 选择 renderer，挂层并监听点击
function startStateTheme(themeName) {
  // 先把任何已开启的专题清干净（保证互斥）
  if (currentTheme.value) stopStateTheme();
  currentTheme.value = themeName;

  // FeatureLayer 配置：渲染器按专题切换；人口专题时还要在每个州上标注人口（百万）
  const layerConfig = {
    url: STATES_LAYER_URL,
    // 根据当前专题选择 renderer
    renderer: themeName === 'region' ? buildRegionRenderer() : buildPopulationRenderer(),
    // 弹窗里只用到这 4 个字段，按需 outFields 减小数据量
    outFields: ['state_name', 'sub_region', 'state_abbr', 'pop2000'],
    popupEnabled: false   // 禁用 Esri 默认弹窗，我们用 Vue 自己渲染
  };
  // 仅人口专题：在每个州的形心位置用 Arcade 表达式标注 pop2000/100 万，保留 3 位小数
  if (themeName === 'pop') {
    layerConfig.labelingInfo = [
      {
        labelExpressionInfo: {
          expression: 'Round($feature.pop2000 / 1000000, 3)'
        },
        // 黑字 + 白色光晕，保证在不同区间色块上都能看清
        symbol: {
          type: 'text',
          color: [0, 0, 0, 1],
          haloColor: [255, 255, 255, 1],
          haloSize: 1.5,
          font: { size: 11, family: 'Arial', weight: 'bold' }
        },
        labelPlacement: 'always-horizontal'
      }
    ];
    layerConfig.labelsVisible = true;
  }
  stateThemeLayer = new FeatureLayer(layerConfig);
  // 关键：插到 baseLayer 之后、businessLayer 之前（index=1），这样 Cities/Highways/States 渲染在专题色之上
  view.map.add(stateThemeLayer, 1);

  // 监听地图点击：用 hitTest 命中专题图层时显示弹窗 + 红色高亮，命中空白则全部清掉
  stateClickHandler = view.on('click', async (evt) => {
    if (!currentTheme.value) return;
    try {
      const result = await view.hitTest(evt, { include: stateThemeLayer });
      const hit = result.results.find(
        (r) => r.graphic && r.graphic.layer === stateThemeLayer
      );
      if (hit) {
        const a = hit.graphic.attributes || {};
        statePopup.value = {
          x: evt.x,           // 弹窗位置使用屏幕坐标（相对于 view 容器，弹窗的尾巴尖锚定在这里）
          y: evt.y,
          state_name: a.state_name,
          sub_region: a.sub_region,
          state_abbr: a.state_abbr,
          pop2000: a.pop2000
        };
        // 在 selectedStateLayer 上绘制选中州的红色加粗轮廓
        setStateHighlight(hit.graphic.geometry);
      } else {
        statePopup.value = null;
        setStateHighlight(null);
      }
    } catch (e) {
      console.error('hitTest error', e);
    }
  });
}

// 在 selectedStateLayer 上重绘"红色加粗"轮廓；传 null 表示清掉高亮
function setStateHighlight(geometry) {
  if (!selectedStateLayer) return;
  selectedStateLayer.removeAll();
  if (!geometry) return;
  selectedStateLayer.add(
    new Graphic({
      geometry,
      symbol: {
        type: 'simple-fill',
        color: [0, 0, 0, 0],            // 透明填充，只突出边框
        outline: { color: [255, 0, 0], width: 3 }
      }
    })
  );
}

// 关闭弹窗 + 清掉高亮（× 按钮和点击空白都走这个）
function closeStatePopup() {
  statePopup.value = null;
  setStateHighlight(null);
}

// 关闭专题：清掉图层、句柄、弹窗、两套图例隐藏列表、红色高亮
function stopStateTheme() {
  currentTheme.value = null;
  statePopup.value = null;
  hiddenRegions.value = [];
  hiddenPops.value = [];
  setStateHighlight(null);   // 清掉高亮
  if (stateClickHandler) {
    stateClickHandler.remove();
    stateClickHandler = null;
  }
  if (stateThemeLayer) {
    view.map.remove(stateThemeLayer);
    stateThemeLayer.destroy();
    stateThemeLayer = null;
  }
}

// 人口图例点击：切换某个区间在地图上的显隐，同区域专题用 definitionExpression 过滤
function togglePopRange(value) {
  const idx = hiddenPops.value.indexOf(value);
  if (idx === -1) hiddenPops.value.push(value);
  else hiddenPops.value.splice(idx, 1);

  if (!stateThemeLayer) return;
  // 把"未隐藏的区间"拼成 OR 表达式：(pop2000 >= a AND pop2000 < b) OR ...
  const visible = popDefs.filter((p) => !hiddenPops.value.includes(p.value));
  if (visible.length === popDefs.length) {
    stateThemeLayer.definitionExpression = '';
  } else if (visible.length === 0) {
    stateThemeLayer.definitionExpression = '1=0'; // 全部隐藏
  } else {
    const conds = visible.map((p) => `(pop2000 >= ${p.min} AND pop2000 < ${p.max})`);
    stateThemeLayer.definitionExpression = conds.join(' OR ');
  }
}

// ===== 地图缩放控件：右下角 + / - 按钮 =====
function zoomIn() {
  if (view) view.goTo({ zoom: view.zoom + 1 });
}
function zoomOut() {
  if (view) view.goTo({ zoom: view.zoom - 1 });
}

// 图例点击：把对应分区加入 / 移出 hiddenRegions，并通过 definitionExpression 过滤地图要素
function toggleRegion(value) {
  const idx = hiddenRegions.value.indexOf(value);
  if (idx === -1) hiddenRegions.value.push(value);
  else hiddenRegions.value.splice(idx, 1);

  if (!stateThemeLayer) return;
  if (hiddenRegions.value.length === 0) {
    // 没有被隐藏的分区：清空过滤条件
    stateThemeLayer.definitionExpression = '';
  } else {
    // 用 NOT IN 过滤：把被隐藏的 sub_region 排除
    const list = hiddenRegions.value
      .map((r) => `'${r.replace(/'/g, "''")}'`)
      .join(',');
    stateThemeLayer.definitionExpression = `sub_region NOT IN (${list})`;
  }
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

// 右侧图层选择器：定位在动作按钮下方
.layer-panel {
  position: absolute;
  top: 64px;          // 让在 action-bar（顶 12px + 高 38px）下方留点间距
  right: 12px;
  z-index: 10;
  background: #fff;
  padding: 10px 14px;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  min-width: 130px;

  // 标题"图层"
  .layer-title {
    font-size: 14px;
    font-weight: 600;
    color: #333;
    padding-bottom: 6px;
    margin-bottom: 8px;
    border-bottom: 1px solid #f0f0f0;
  }

  // 让 a-checkbox-group 中的每个复选框纵向排列
  .layer-checkbox-group {
    display: flex;
    flex-direction: column;

    .layer-checkbox {
      margin-left: 0;       // 覆盖 antd 默认横向排列时的左边距
      margin-bottom: 6px;
      font-size: 13px;

      &:last-child {
        margin-bottom: 0;
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

    // 州区域专题按钮处于激活状态时加深背景，与矩形/多边形按钮保持一致
    &.active {
      background: #096dd9;
    }
  }
}

// 州信息弹窗：尾巴尖锚定在 left/top（点击位置），整体通过 transform 上移到点击点正上方
.state-popup {
  position: absolute;
  z-index: 20;
  min-width: 280px;
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: 14px 18px;
  // 把 (left,top) 当作"尾巴尖"位置：水平居中、整体上移自身高度 + 10px 间距
  transform: translate(-50%, calc(-100% - 10px));

  // 底部三角形尾巴
  &::after {
    content: '';
    position: absolute;
    bottom: -10px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 10px solid transparent;
    border-right: 10px solid transparent;
    border-top: 10px solid #fff;
    // 让三角形也带一点投影，与卡片自身的 box-shadow 衔接
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.08));
  }

  .state-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;

    .title {
      font-size: 16px;
      font-weight: 600;
      color: #222;
    }

    .close-btn {
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      color: #888;
      padding: 0 4px;

      &:hover {
        color: #333;
      }
    }
  }

  .state-popup-body {
    color: #444;
    font-size: 13px;
    line-height: 1.9;

    .lbl {
      color: #333;
    }
  }
}

// 右下角堆叠容器：图例 + 缩放按钮
.bottom-right-stack {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}

// 州区域图例：固定大小 + 滚动条
.region-legend {
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 10px 14px;
  width: 150px;
  height: 160px;        // 固定高度，超出滚动
  display: flex;
  flex-direction: column;

  .region-legend-title {
    font-size: 13px;
    font-weight: 600;
    color: #333;
    padding-bottom: 6px;
    margin-bottom: 6px;
    border-bottom: 1px solid #f0f0f0;
    flex-shrink: 0;
  }

  .region-legend-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-right: 2px;

    .region-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 12px;
      color: #333;
      user-select: none;

      // 用 trapezoid.svg 作为遮罩，背景色由内联 style 控制，从而实现"按区域上色 / 隐藏时变灰"
      .color-box {
        display: inline-block;
        width: 16px;
        height: 12px;
        flex-shrink: 0;
        mask-repeat: no-repeat;
        mask-size: contain;
        mask-position: center;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-size: contain;
        -webkit-mask-position: center;
      }

      &.disabled {
        color: #aaa;
      }
    }
  }
}

// 州人口专题图例（与区域图例风格一致，3 项无需滚动）
.pop-legend {
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 10px 14px;
  width: 150px;

  // header 只装标题；横线就是它的 border-bottom
  .pop-legend-header {
    padding-bottom: 6px;
    margin-bottom: 6px;
    border-bottom: 1px solid #f0f0f0;

    .title {
      font-size: 13px;
      font-weight: 600;
      color: #333;
    }
  }

  // 横线下、列表上：单位说明，独立一行右对齐红色小字
  .pop-legend-unit {
    text-align: right;
    font-size: 11px;
    color: #d4380d;
    margin-bottom: 6px;
  }

  .pop-legend-list {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .pop-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 12px;
      color: #333;
      user-select: none;

      // 复用 .color-box 样式（在 .region-legend 中定义），这里只需追加共用样式
      .color-box {
        display: inline-block;
        width: 16px;
        height: 12px;
        flex-shrink: 0;
        mask-repeat: no-repeat;
        mask-size: contain;
        mask-position: center;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-size: contain;
        -webkit-mask-position: center;
      }

      &.disabled {
        color: #aaa;
      }
    }
  }
}

// 右下角缩放控件
.zoom-controls {
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  overflow: hidden;

  .zoom-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: #fff;
    color: #333;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0;

    & + .zoom-btn {
      border-top: 1px solid #f0f0f0;
    }

    &:hover {
      background: #f5f5f5;
    }
  }
}
</style>
