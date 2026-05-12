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
    <!-- 矩形/多边形绘制时挂上 sketching 类，配合 CSS 强制把光标改回默认箭头 -->
    <div
      ref="mapEl"
      class="map-view"
      :class="{ sketching: drawing || drawingPolygon }"
    ></div>

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

    <!-- 右上角动作按钮：点选 + 清除 + 州区域专题 + 州人口专题 + 城市热力图 + 人口信息 -->
    <div class="action-bar">
      <!-- 点选按钮：开启后点击地图任意位置都会弹出当前坐标弹窗 -->
      <a-button
        type="primary"
        :class="['action-btn', { active: pickOn }]"
        title="点选"
        @click="togglePick"
      >
        <img :src="pickIcon" alt="pick" />
      </a-button>
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
        <!-- 用 ant-design 的 BgColorsOutlined：寓意"分色专题"，与州区域专题区分明显 -->
        <BgColorsOutlined class="action-anticon" />
      </a-button>
      <!-- 城市人口热力图按钮：以 cities (MapServer/0) 为数据源、pop2000 为权重，HeatmapRenderer 渲染密度热力图 -->
      <a-button
        type="primary"
        :class="['action-btn', { active: heatmapOn }]"
        title="城市人口热力图"
        @click="toggleHeatmap"
      >
        <!-- 使用 ant-design 的 HeatMapOutlined 矢量图标，颜色随父级 currentColor（按钮文字色）继承为白色 -->
        <HeatMapOutlined class="action-anticon" />
      </a-button>
      <a-button type="primary" class="action-btn" title="人口信息" @click="popOpen = true">
        <img :src="popIcon" alt="population" />
      </a-button>
    </div>

    <!-- 州信息弹窗：弹窗的"尾巴尖"锚定在 statePopupPos.x/y（由 mapPoint 实时投影出来的屏幕坐标），地图移动时跟随 -->
    <div
      v-if="statePopup && statePopupPos"
      class="state-popup"
      :style="{ left: statePopupPos.x + 'px', top: statePopupPos.y + 'px' }"
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

    <!-- 点选弹窗：与州信息弹窗共用 .state-popup 样式；屏幕坐标由 pickPopupPos 实时投影，地图移动时跟随 -->
    <div
      v-if="pickPopup && pickPopupPos"
      class="state-popup"
      :style="{ left: pickPopupPos.x + 'px', top: pickPopupPos.y + 'px' }"
    >
      <div class="state-popup-header">
        <span class="title">我的点选</span>
        <span class="close-btn" @click="pickPopup = null">×</span>
      </div>
      <div class="state-popup-body">
        <div>x: {{ pickPopup.mapX }}</div>
        <div>y: {{ pickPopup.mapY }}</div>
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
                mask: `url('${trapezoidIcon}') center / contain no-repeat`,
                WebkitMask: `url('${trapezoidIcon}') center / contain no-repeat`
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
                mask: `url('${trapezoidIcon}') center / contain no-repeat`,
                WebkitMask: `url('${trapezoidIcon}') center / contain no-repeat`
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
import { ref, shallowRef, computed, markRaw, onMounted, onBeforeUnmount, watch } from 'vue';
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

import Polygon from '@arcgis/core/geometry/Polygon';
import Polyline from '@arcgis/core/geometry/Polyline';
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
// 点选按钮图标（用 point.svg，与其他按钮图标不冲突）
import pickIcon from '@/assets/images/point.svg';
// 图例使用的梯形图标（用 CSS mask 着色，便于按区域上色 / 灰化）
import trapezoidIcon from '@/assets/images/trapezoid.svg';

import PopulationModal from './PopulationModal.vue';
// 城市人口热力图按钮：HeatMap 矢量图标；州人口专题按钮：BgColors（按颜色分组主题），都用 ant-design 矢量图标避免与点选类 svg 重复
import { HeatMapOutlined, BgColorsOutlined } from '@ant-design/icons-vue';
// 用 message 给用户友好提示（替代刺眼的 console.error）
import { message } from 'ant-design-vue';

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

// 是否开启城市人口热力图（基于 cities 子图层 0 + pop2000 字段加权），与州专题独立
const heatmapOn = ref(false);

// 是否开启"点选"工具：开启后地图任意点击都会弹出当前位置的 map 坐标
const pickOn = ref(false);
// 点选弹窗数据：{ mapPoint, mapX, mapY } 或 null（mapPoint 用于 view.toScreen 算屏幕坐标）
const pickPopup = ref(null);

// 视图版本号：view 每次平移/缩放 +1；用作弹窗屏幕坐标 computed 的"变更触发器"
const viewVersion = ref(0);

// 弹窗的屏幕坐标 computed：依赖 viewVersion + 当前 popup 的 mapPoint
// 每次地图变化 viewVersion 改 → computed 重算 → DOM left/top 跟着更新 → 弹窗"贴"在地图上
const statePopupPos = computed(() => {
  // 读 viewVersion 让 computed 跟它建立依赖关系
  // eslint-disable-next-line no-unused-expressions
  viewVersion.value;
  if (!statePopup.value || !view || !statePopup.value.mapPoint) return null;
  const sp = view.toScreen(statePopup.value.mapPoint);
  return sp ? { x: sp.x, y: sp.y } : null;
});

const pickPopupPos = computed(() => {
  // eslint-disable-next-line no-unused-expressions
  viewVersion.value;
  if (!pickPopup.value || !view || !pickPopup.value.mapPoint) return null;
  const sp = view.toScreen(pickPopup.value.mapPoint);
  return sp ? { x: sp.x, y: sp.y } : null;
});

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
let cityHeatmapLayer = null;      // 城市人口热力图 FeatureLayer（独立于州专题，挂在最上层）
let pickClickHandler = null;      // "点选"工具的 view.on('click') 句柄
let viewExtentWatchHandle = null; // reactiveUtils.watch 返回的句柄，组件卸载时 remove
let cityMarkerLayer = null;       // 蓝色查询结果标记层
let selectedMarkerLayer = null;   // 红色当前选中标记层
let drawLayer = null;             // 框选绘制临时图层
let sketchVM = null;              // SketchViewModel 实例
let sketchHandler = null;         // SketchVM 的事件订阅句柄
let polygonVertices = [];         // 手动画多边形时保存顶点坐标
let polygonPointerDownHandler = null; // 鼠标按下立即加点事件
let polygonMoveHandler = null;    // 鼠标移动预览事件
let polygonDoubleClickHandler = null; // 双击结束绘制事件
let polygonKeyHandler = null;     // Enter / Esc 键盘事件
let polygonPreviewRaf = null;          // 鼠标移动预览节流
let polygonPendingPreview = null;      // 待绘制的预览数据
let polygonLastClickTime = 0;          // 上一次点击时间
let polygonLastClickScreen = null;     // 上一次点击的屏幕坐标
const POLYGON_DBLCLICK_MS = 350;       // 判定双击的最大时间间隔
const POLYGON_DBLCLICK_PX = 8;         // 判定双击的最大屏幕距离
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
  constraints: { rotationEnabled: false },

  // 让 Sketch 交互提示色透明，去掉鼠标旁边的橙色小圆点
  theme: {
    accentColor: [0, 0, 0, 0]
  }
});


  // 移除默认地图控件，仅保留版权信息
  view.ui.components = [];

  // 关闭 ArcGIS 自带的"点击自动开 popup"逻辑：我们用 Vue 自渲染弹窗，view.popup 全部不用
  // 这个开关如果是 true（默认），View 会在每次点击时对所有 FeatureLayer 做内部 hitTest 来决定要不要弹 popup，
  // 即使所有图层 popupEnabled:false 也会占资源；更关键的是这个 hitTest 可能与 Sketch 的双击检测竞争事件
  if (view.popup) view.popup.autoOpenEnabled = false;

  // 监听视图变化，每次平移/缩放都让 viewVersion +1，触发弹窗位置 computed 重新计算
  // 这样弹窗就能"跟随地图"，因为它们的 left/top 是用 mapPoint 现算的屏幕坐标
  // 用 view.watch 虽然 4.32+ 标了 deprecated，但仍可用；避免再额外 import reactiveUtils 触发 Vite 重新打包导致 Esri 模块加载两份
  viewExtentWatchHandle = view.watch('extent', () => {
    viewVersion.value++;
  });

  // 全局兜底：吞掉 ArcGIS 内部 fetch 抛出的未捕获 Promise 错误（绘制中地图刷新瓦片时常见）
  // 仅匹配典型的"网络相关"特征，避免误屏蔽业务异常
  window.addEventListener('unhandledrejection', suppressArcGISFetchError);
});

// 组件卸载：销毁 MapView 与 SketchViewModel，释放资源；同步移除全局监听 + watch handle
onBeforeUnmount(() => {
  stopDraw();
  window.removeEventListener('unhandledrejection', suppressArcGISFetchError);
  if (viewExtentWatchHandle) {
    viewExtentWatchHandle.remove();
    viewExtentWatchHandle = null;
  }
  
  if (view) {
    view.destroy();
    view = null;
  }
});

// 只吞 ArcGIS 内部 fetch 失败（典型 name === 'fetchError'，或 message 命中网络关键字）
function suppressArcGISFetchError(evt) {
  const reason = evt && evt.reason;
  if (!reason) return;
  const msg = String(reason.message || '').toLowerCase();
  const name = String(reason.name || '').toLowerCase();
  if (
    name === 'fetcherror' ||
    /failed to fetch|networkerror|abort|err_network|err_connection/.test(msg)
  ) {
    evt.preventDefault(); // 阻止控制台标红，业务逻辑不受影响
  }
}

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
    // 已有更新查询发起 → 当前响应已过时，静默忽略
    if (token !== queryToken) return;
    const msg = (e && e.message) || '';
    const name = (e && e.name) || '';
    // 典型的"示例服务器抖动 / 网络变化 / 中断"——不是代码 bug，降级成 warn + 用户友好提示
    const isNetwork =
      /Failed to fetch|NetworkError|aborted|ERR_/i.test(msg) ||
      name === 'fetchError' || name === 'AbortError';
    if (isNetwork) {
      console.warn('Spatial query: 网络/服务暂时不可用', msg);
      message.warning('地图服务暂时不可达，请稍后重试');
    } else {
      console.error('Spatial query error', e);
    }
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
  // 点选与绘制互斥：开始绘制前关闭点选工具
  if (pickOn.value) stopPick();
  startDraw();
}

// 启动框选绘制
function startDraw() {
  drawing.value = true;
  drawLayer.removeAll();
  // 关掉地图上任何已显示的弹窗与高亮，避免遮挡绘制视野
  closeStatePopup();
  pickPopup.value = null;
  // 关键：临时摘掉 state-theme 的 click 监听，避免它对 Sketch 的点击/双击事件造成干扰
  if (stateClickHandler) {
    stateClickHandler.remove();
    stateClickHandler = null;
  }

  // 创建 SketchViewModel，控制矩形画在 drawLayer 上
  sketchVM = new SketchViewModel({
    layer: drawLayer,
    view,
    // 把"绘制中的点"符号设为完全透明，去掉跟随鼠标的橙色小圆点（顶点预览 + 已落点 都不再画）
    pointSymbol: {
      type: 'simple-marker',
      style: 'circle',
      color: [0, 0, 0, 0],
      size: 6,
      outline: { color: [0, 0, 0, 0], width: 0 }
    },
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

  // 清理 SketchViewModel：给矩形用
  if (sketchHandler) {
    sketchHandler.remove();
    sketchHandler = null;
  }
  if (sketchVM) {
    sketchVM.cancel();
    sketchVM = null;
  }

  // 清理手写多边形事件
  if (polygonPointerDownHandler) {
    polygonPointerDownHandler.remove();
    polygonPointerDownHandler = null;
  }
  if (polygonMoveHandler) {
    polygonMoveHandler.remove();
    polygonMoveHandler = null;
  }
  if (polygonDoubleClickHandler) {
    polygonDoubleClickHandler.remove();
    polygonDoubleClickHandler = null;
  }
  if (polygonKeyHandler) {
    polygonKeyHandler.remove();
    polygonKeyHandler = null;
  }
  if (polygonPreviewRaf) {
    cancelAnimationFrame(polygonPreviewRaf);
    polygonPreviewRaf = null;
  }
  polygonPendingPreview = null;
  polygonLastClickTime = 0;
  polygonLastClickScreen = null;

  polygonVertices = [];

  drawing.value = false;
  drawingPolygon.value = false;

  // 绘制结束后再挂回州专题点击事件
  if (currentTheme.value && stateThemeLayer && view) {
    setTimeout(() => {
      if (currentTheme.value && stateThemeLayer && view && !stateClickHandler) {
        stateClickHandler = view.on('click', onStateMapClick);
      }
    }, 80);
  }
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
  // 点选与绘制互斥：开始绘制前关闭点选工具
  if (pickOn.value) stopPick();
  startDrawPolygon();
}

function closeRing(vertices) {
  const ring = vertices.map((v) => [v[0], v[1]]);
  if (ring.length < 3) return ring;

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return ring;
}

function renderPolygonPreview(vertices, fixedCount = vertices.length) {
  drawLayer.removeAll();

  if (!vertices || vertices.length === 0) return;

  const graphics = [];

  // 2 个点时：画预览线
  if (vertices.length === 2) {
    graphics.push(
      new Graphic({
        geometry: new Polyline({
          paths: [vertices],
          spatialReference: view.spatialReference
        }),
        symbol: {
          type: 'simple-line',
          color: [255, 0, 0],
          width: 2
        }
      })
    );
  }

  // 3 个点及以上：画预览面
  if (vertices.length >= 3) {
    graphics.push(
      new Graphic({
        geometry: new Polygon({
          rings: [closeRing(vertices)],
          spatialReference: view.spatialReference
        }),
        symbol: {
          type: 'simple-fill',
          color: [3, 255, 240, 0.1],
          outline: {
            style: 'solid',
            color: [255, 0, 0],
            width: 2
          }
        }
      })
    );
  }

  // 只画已经点击确定的顶点
  vertices.slice(0, fixedCount).forEach((v) => {
    graphics.push(
      new Graphic({
        geometry: {
          type: 'point',
          x: v[0],
          y: v[1],
          spatialReference: view.spatialReference
        },
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          color: [255, 0, 0, 0.9],
          size: 5,
          outline: {
            color: [255, 255, 255, 0.9],
            width: 1
          }
        }
      })
    );
  });

  drawLayer.addMany(graphics);
}

function schedulePolygonPreview(vertices, fixedCount) {
  polygonPendingPreview = { vertices, fixedCount };

  if (polygonPreviewRaf) return;

  polygonPreviewRaf = requestAnimationFrame(() => {
    polygonPreviewRaf = null;
    if (!polygonPendingPreview) return;

    const { vertices, fixedCount } = polygonPendingPreview;
    polygonPendingPreview = null;
    renderPolygonPreview(vertices, fixedCount);
  });
}

function finishManualPolygonDraw() {
  if (!drawingPolygon.value) return;

  if (polygonVertices.length < 3) {
    stopDraw();
    return;
  }

  const polygon = new Polygon({
    rings: [closeRing(polygonVertices)],
    spatialReference: view.spatialReference
  });

  doSpatialQuery(polygon);
  stopDraw();
}

// 启动多边形框选绘制
function startDrawPolygon() {
  drawingPolygon.value = true;
  polygonVertices = [];
  polygonLastClickTime = 0;
  polygonLastClickScreen = null;
  drawLayer.removeAll();

  closeStatePopup();
  pickPopup.value = null;

  // 临时摘掉州专题点击监听
  if (stateClickHandler) {
    stateClickHandler.remove();
    stateClickHandler = null;
  }

  // 临时摘掉点选监听
  if (pickClickHandler) {
    pickClickHandler.remove();
    pickClickHandler = null;
  }

  if (view && view.popup) {
    try { view.popup.close(); } catch (e) { /* ignore */ }
  }

  // 让地图容器获得焦点，方便 Enter / Esc 生效
  if (view && view.container) {
    view.container.focus();
  }

  // 单击：添加一个顶点
  polygonPointerDownHandler = view.on('pointer-down', (event) => {
    if (!drawingPolygon.value) return;

    const button = event.button ?? event.native?.button ?? 0;
    if (button !== 0) return;

    event.stopPropagation();

    const now = Date.now();
    const screenPoint = { x: event.x, y: event.y };

    // 关键：不用等 view.on('double-click')，直接在 pointer-down 中手动判断双击
    const isManualDoubleClick =
      polygonLastClickScreen &&
      now - polygonLastClickTime <= POLYGON_DBLCLICK_MS &&
      Math.hypot(
        screenPoint.x - polygonLastClickScreen.x,
        screenPoint.y - polygonLastClickScreen.y
      ) <= POLYGON_DBLCLICK_PX;

    if (isManualDoubleClick) {
      polygonLastClickTime = 0;
      polygonLastClickScreen = null;

      // 至少已有 3 个点时，双击结束绘制
      if (polygonVertices.length >= 3) {
        finishManualPolygonDraw();
      }

      return;
    }

    const mapPoint = view.toMap({
      x: event.x,
      y: event.y
    });

    if (!mapPoint) return;

    polygonVertices.push([mapPoint.x, mapPoint.y]);

    polygonLastClickTime = now;
    polygonLastClickScreen = screenPoint;

    // 鼠标按下后立即绘制顶点，不等 click 事件
    renderPolygonPreview(polygonVertices, polygonVertices.length);
  });

  // 鼠标移动：预览线 / 面
  polygonMoveHandler = view.on('pointer-move', (event) => {
    if (!drawingPolygon.value || polygonVertices.length === 0) return;

    const mapPoint = view.toMap({ x: event.x, y: event.y });
    if (!mapPoint) return;

    const previewVertices = [
      ...polygonVertices,
      [mapPoint.x, mapPoint.y]
    ];

    schedulePolygonPreview(previewVertices, polygonVertices.length);
  });

  // 双击：结束绘制
  // 双击：兜底结束绘制
// 正常情况下已经由 pointer-down 手动双击判断处理；这里仅作为备用
polygonDoubleClickHandler = view.on('double-click', (event) => {
  if (!drawingPolygon.value) return;

  event.stopPropagation();

  polygonLastClickTime = 0;
  polygonLastClickScreen = null;

  // 如果 double-click 事件真的触发了，第二下 pointer-down 可能已经多加了一个点
  if (polygonVertices.length > 0) {
    polygonVertices.pop();
  }

  finishManualPolygonDraw();
});

  // Enter 结束，Esc 取消
  polygonKeyHandler = view.on('key-down', (event) => {
    if (!drawingPolygon.value) return;

    if (event.key === 'Enter') {
      event.stopPropagation();
      finishManualPolygonDraw();
    }

    if (event.key === 'Escape') {
      event.stopPropagation();
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
    // 把 regionDefs 映射成 ArcGIS 所需的 uniqueValueInfos；
    // 被图例点掉的分区只把填充改成透明，outline 保留 → 州轮廓仍然可见
    uniqueValueInfos: regionDefs.map((r) => ({
      value: r.value,
      symbol: {
        type: 'simple-fill',
        color: hiddenRegions.value.includes(r.value) ? [0, 0, 0, 0] : [...r.color, 0.85],
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
    // 被图例点掉的区间只把填充改成透明，outline 保留 → 州轮廓仍然可见
    classBreakInfos: popDefs.map((p) => ({
      minValue: p.min,
      maxValue: p.max,
      symbol: {
        type: 'simple-fill',
        color: hiddenPops.value.includes(p.value) ? [0, 0, 0, 0] : [...p.color, 0.85],
        outline: { color: [50, 50, 50], width: 0.5 }
      }
    }))
  };
}

// 人口专题的标注配置：每个州中心标 pop2000/100 万；带 where 过滤，被图例隐藏的区间不画标注
function buildPopulationLabelingInfo() {
  const visible = popDefs.filter((p) => !hiddenPops.value.includes(p.value));
  // 拼 SQL where：只给"未被隐藏"的区间画标注；全部隐藏时用 1=0（一个都不画）
  let where = '';
  if (visible.length === 0) {
    where = '1=0';
  } else if (visible.length < popDefs.length) {
    where = visible
      .map((p) => `(pop2000 >= ${p.min} AND pop2000 < ${p.max})`)
      .join(' OR ');
  }
  return [
    {
      where,                       // 空串 = 不过滤，全部显示；否则按 OR 表达式过滤
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
    // 标注配置抽成函数，方便 togglePopRange 在隐藏 / 显示某区间时同步刷新
    layerConfig.labelingInfo = buildPopulationLabelingInfo();
    layerConfig.labelsVisible = true;
  }
  stateThemeLayer = new FeatureLayer(layerConfig);
  // 关键：插到 baseLayer 之后、businessLayer 之前（index=1），这样 Cities/Highways/States 渲染在专题色之上
  view.map.add(stateThemeLayer, 1);

  // 注册地图点击监听（命名函数 onStateMapClick，便于绘制时临时摘除、绘制后再次挂载）
  stateClickHandler = view.on('click', onStateMapClick);
}

// 州专题点击逻辑：hitTest 命中专题图层时显示弹窗 + 红色高亮，命中空白则全部清掉
async function onStateMapClick(evt) {
  if (!currentTheme.value) return;
  // 点选工具开启时，让坐标弹窗独占，避免两个弹窗同位置叠加
  if (pickOn.value) return;
  // 矩形/多边形绘制进行中：双保险（实际上 startDraw 会把这个 handler 摘掉）
  if (drawing.value || drawingPolygon.value) return;
  try {
    const result = await view.hitTest(evt, { include: stateThemeLayer });
    if (drawing.value || drawingPolygon.value || !currentTheme.value || !stateThemeLayer) return;
    const hit = result.results.find(
      (r) => r.graphic && r.graphic.layer === stateThemeLayer
    );
    if (hit) {
      const a = hit.graphic.attributes || {};
      statePopup.value = {
        mapPoint: markRaw(evt.mapPoint),
        state_name: a.state_name,
        sub_region: a.sub_region,
        state_abbr: a.state_abbr,
        pop2000: a.pop2000
      };
      setStateHighlight(hit.graphic.geometry);
    } else {
      statePopup.value = null;
      setStateHighlight(null);
    }
  } catch (e) {
    console.error('hitTest error', e);
  }
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

// 人口图例点击：切换某个区间；同时刷新 renderer（填充色）和 labelingInfo（标注的 where 过滤）
function togglePopRange(value) {
  const idx = hiddenPops.value.indexOf(value);
  if (idx === -1) hiddenPops.value.push(value);
  else hiddenPops.value.splice(idx, 1);

  if (!stateThemeLayer) return;
  stateThemeLayer.renderer = buildPopulationRenderer();
  // 被隐藏区间的人口数标注也要一并去掉
  stateThemeLayer.labelingInfo = buildPopulationLabelingInfo();
}

// ===== 城市人口热力图：开关切换 =====
function toggleHeatmap() {
  if (heatmapOn.value) stopHeatmap();
  else startHeatmap();
}

// 启动：基于 cities 子图层 (MapServer/0) 创建 FeatureLayer，HeatmapRenderer 按 pop2000 字段加权
function startHeatmap() {
  heatmapOn.value = true;
  cityHeatmapLayer = new FeatureLayer({
    url: CITY_LAYER_URL,
    // HeatmapRenderer：用 Arcade 表达式做权重，先把 pop2000 开方压缩量级（1 万→100, 800 万→2828），
    // 否则 NYC/LA 这种巨型城市权重会比小镇大 800 倍，导致热力图被极值"撑爆"成一片红
    renderer: {
      type: 'heatmap',
      valueExpression: 'When($feature.pop2000 > 0, Sqrt($feature.pop2000), 0)',
      // 颜色阶梯：低密度透明 → 高密度红色（常见的"冷-暖"热力配色）
      colorStops: [
        { ratio: 0,    color: 'rgba(0, 0, 0, 0)' },
        { ratio: 0.2,  color: 'rgba(0, 0, 255, 0.5)' },
        { ratio: 0.5,  color: 'rgba(0, 255, 0, 0.7)' },
        { ratio: 0.8,  color: 'rgba(255, 255, 0, 0.85)' },
        { ratio: 1,    color: 'rgba(255, 0, 0, 1)' }
      ],
      radius: 30,
      minDensity: 0,
      // 经过 Sqrt 压缩后，单点最大权重 ≈ 2800，单点峰值密度 ≈ 2-3；阈值取 5 让大都市区进红、稀疏区进透明蓝
      maxDensity: 5
    },
    popupEnabled: false
  });
  // 不指定 index，默认加在 layers 最末（最上层），避免被州专题或其它图层盖住
  view.map.add(cityHeatmapLayer);
}

// 关闭：从地图移除并销毁热力图层
function stopHeatmap() {
  heatmapOn.value = false;
  if (cityHeatmapLayer) {
    view.map.remove(cityHeatmapLayer);
    cityHeatmapLayer.destroy();
    cityHeatmapLayer = null;
  }
}

// ===== 点选工具：开启后地图任意点击 → 弹出当前 map 坐标 =====
function togglePick() {
  if (pickOn.value) {
    stopPick();
    return;
  }
  // 点选与绘制互斥：开启点选前关闭任何在进行的矩形/多边形绘制
  if (drawing.value || drawingPolygon.value) stopDraw();
  startPick();
}

function startPick() {
  pickOn.value = true;
  // 用 view.on('click') 拿到点击位置：evt.x/evt.y 是屏幕坐标（用于弹窗定位），evt.mapPoint 是地图坐标（用于显示）
  pickClickHandler = view.on('click', (evt) => {
    if (!pickOn.value || !evt.mapPoint) return;
    pickPopup.value = {
      // 用 markRaw 避免 Esri Point 被 Vue 深度代理（详见 statePopup 处的说明）
      mapPoint: markRaw(evt.mapPoint),
      mapX: evt.mapPoint.x,
      mapY: evt.mapPoint.y
    };
  });
}

function stopPick() {
  pickOn.value = false;
  pickPopup.value = null;
  if (pickClickHandler) {
    pickClickHandler.remove();
    pickClickHandler = null;
  }
}

// ===== 地图缩放控件：右下角 + / - 按钮 =====
function zoomIn() {
  if (view) view.goTo({ zoom: view.zoom + 1 });
}
function zoomOut() {
  if (view) view.goTo({ zoom: view.zoom - 1 });
}

// 图例点击：把对应分区加入 / 移出 hiddenRegions，重新构建 renderer
// （只改填充色，不再用 definitionExpression 过滤，州边框始终保留）
function toggleRegion(value) {
  const idx = hiddenRegions.value.indexOf(value);
  if (idx === -1) hiddenRegions.value.push(value);
  else hiddenRegions.value.splice(idx, 1);

  if (!stateThemeLayer) return;
  stateThemeLayer.renderer = buildRegionRenderer();
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

  // 处于矩形/多边形绘制时，把 ArcGIS 内部对光标的修改覆盖回默认箭头
  // ArcGIS 在 SketchViewModel.create() 后会把 view.cursor 设成 crosshair，
  // 通过给 .esri-view 设 data-cursor 属性 + 对应 CSS 规则把光标改成十字。
  // 用 :deep() 穿透 scoped 边界，加 !important 覆盖 ArcGIS 自带的规则。
  &.sketching {
    :deep(.esri-view),
    :deep(.esri-view-surface),
    :deep(canvas) {
      cursor: default !important;
    }
  }

  // 去除 ArcGIS 视图自带的所有外框/焦点框：
  // 1) 元素自身的 outline / box-shadow（含 :focus / :focus-visible 状态）
  // 2) 键盘焦点态由 .esri-view-surface--inset-outline::after 画的蓝色内陷"图框"
  :deep(.esri-view),
  :deep(.esri-view-root),
  :deep(.esri-view-surface),
  :deep(canvas) {
    outline: none !important;

    &:focus,
    &:focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }
  }

  :deep(.esri-view-surface--inset-outline)::after,
  :deep(.esri-view-surface)::after,
  :deep(.esri-view-root)::after {
    content: none !important;
    display: none !important;
    border: none !important;
    outline: none !important;
    background: none !important;
  }
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

      // 鼠标按下瞬间（mousedown）→ 橙色，覆盖 Ant Design 默认的深蓝按压色
      &:active {
        background: #fa8c16 !important;
        border-color: #fa8c16 !important;
      }

      // 处于激活（toggled）状态时的橙色背景
      &.active,
      &.active:hover,
      &.active:focus {
        background: #fa8c16 !important;
        border-color: #fa8c16 !important;
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

    // ant-design 矢量图标尺寸对齐 svg；颜色由父级 currentColor 继承（按钮 primary 时是白色）
    .action-anticon {
      font-size: 20px;
      color: #fff;
    }

    // 鼠标按下瞬间（mousedown）→ 橙色，覆盖 Ant Design 默认的深蓝按压色
    &:active {
      background: #fa8c16 !important;
      border-color: #fa8c16 !important;
    }

    // 处于激活（toggled）状态时的橙色背景，与矩形/多边形按钮保持一致
    &.active,
    &.active:hover,
    &.active:focus {
      background: #fa8c16 !important;
      border-color: #fa8c16 !important;
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
