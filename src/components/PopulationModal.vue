<!--
  人口信息查询弹窗

  - 顶部头部标题："人口信息查询"
  - 左侧导航：州人口 / 城市人口
  - 右侧主区：
      · 上方搜索框（按 sub_region 或 areaname 模糊查询）
      · 中间统计图（州=饼图前5+其他，城市=柱状图前10）
      · 下方表格（人口降序排列，按 5 条/页分页）
  - 底部按钮：取消 / 确认（均关闭弹窗）

  使用 ECharts 渲染统计图，使用 Ant Design Vue 的 a-table 渲染表格。
-->
<template>
  <a-modal
    v-model:open="openModel"
    title="人口信息查询"
    :width="980"
    :body-style="{ padding: 0 }"
    :destroy-on-close="true"
  >
    <div class="pop-modal">
      <!-- 左侧导航：切换州 / 城市 -->
      <div class="nav">
        <div :class="['nav-item', { active: type === 'state' }]" @click="setType('state')">
          州人口
        </div>
        <div :class="['nav-item', { active: type === 'city' }]" @click="setType('city')">
          城市人口
        </div>
      </div>

      <!-- 右侧主区：搜索 + 图表 + 表格 -->
      <div class="content">
        <div class="search-bar">
          <a-input
            v-model:value="keyword"
            class="kw-input"
            :placeholder="placeholder"
            allow-clear
            @press-enter="doQuery(true)"
          />
          <a-button type="primary" @click="doQuery(true)">搜索</a-button>
        </div>

        <div class="chart-title">{{ chartTitle }}</div>
        <!-- ECharts 容器（initChart 时挂载实例） -->
        <div ref="chartEl" class="chart"></div>

        <a-table
          :columns="columns"
          :data-source="tableData"
          :pagination="pagination"
          :loading="loading"
          row-key="key"
          size="small"
          @change="handleTableChange"
        />
      </div>
    </div>

    <!-- 自定义底部，提供取消 / 确认按钮（都仅关闭弹窗） -->
    <template #footer>
      <a-button @click="onCancel">取消</a-button>
      <a-button type="primary" @click="onCancel">确认</a-button>
    </template>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount, reactive } from 'vue';
import * as echarts from 'echarts';
import * as query from '@arcgis/core/rest/query';
import Query from '@arcgis/core/rest/support/Query';

// 父组件通过 v-model:open 控制弹窗开闭
const props = defineProps({ open: Boolean });
const emit = defineEmits(['update:open']);

// 把 open 转成可读写计算属性，方便 a-modal 双向绑定
const openModel = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v)
});

// 州、城市图层服务地址
const STATE_URL =
  'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/2';
const CITY_URL =
  'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/0';

// ===== 状态 =====
const type = ref('state');     // 当前显示的页签：'state' | 'city'
const keyword = ref('');       // 搜索关键字
const stateRows = ref([]);     // 州表格数据
const cityRows = ref([]);      // 城市表格数据
const loading = ref(false);    // 表格 loading 状态
const chartEl = ref(null);     // ECharts 容器 DOM
let chart = null;              // ECharts 实例（非响应式，避免被代理）
let queryToken = 0;            // 查询令牌：避免旧请求覆盖新结果
let resizeObserver = null;     // 容器尺寸变化监听，用于自动 resize 图表
const pagination = reactive({
  current: 1,
  pageSize: 5,
  showSizeChanger: false
})

// 输入框 placeholder & 标题随当前页签切换
const placeholder = computed(() =>
  type.value === 'state' ? '请输入区域' : '请输入城市'
);
const chartTitle = computed(() =>
  type.value === 'state' ? '州人口显示饼状图' : '城市人口显示柱状图'
);

// 州表格列：序号 / 州名 / 区域 / 人口
const stateColumns = [
  { title: '序号', dataIndex: 'index', width: 80 },
  { title: '州名', dataIndex: 'state_name' },
  { title: '区域', dataIndex: 'sub_region' },
  { title: '人口', dataIndex: 'pop2000' }
];

// 城市表格列：序号 / 城市 / 人口
const cityColumns = [
  { title: '序号', dataIndex: 'index', width: 80 },
  { title: '城市', dataIndex: 'areaname' },
  { title: '人口', dataIndex: 'pop2000' }
];

// 根据页签切换列定义和数据源
const columns = computed(() =>
  type.value === 'state' ? stateColumns : cityColumns
);
const tableData = computed(() =>
  type.value === 'state' ? stateRows.value : cityRows.value
);

// 监听弹窗打开：每次打开都重置到默认状态并查询一次
watch(
  () => props.open,
  (v) => {
    if (v) {
      keyword.value = '';
      pagination.current = 1;
      type.value = 'state';
      // nextTick 确保 chartEl 容器已挂载
      nextTick(() => {
        initChart();
        doQuery();
      });
    } else {
      // 关闭时销毁图表，避免残留
      destroyChart();
    }
  }
);

function handleTableChange(page){
  pagination.current = page.current;
}

// 切换页签：清空搜索词，重新初始化图表 + 查询
watch(type, () => {
  keyword.value = '';
  pagination.current = 1;
  
  nextTick(() => {
    initChart();
    doQuery();
  });
});

function setType(t) {
  if (type.value !== t) type.value = t;
}

// 初始化 ECharts 实例并监听容器尺寸变化
function initChart() {
  if (!chartEl.value) return;
  destroyChart();
  chart = echarts.init(chartEl.value);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => chart && chart.resize());
    resizeObserver.observe(chartEl.value);
  }
}

// 销毁图表实例 + ResizeObserver
function destroyChart() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (chart) {
    chart.dispose();
    chart = null;
  }
}

// 转义 SQL 单引号
function escapeSql(s) {
  return s.replace(/'/g, "''");
}

// 查询入口：根据当前页签构造查询参数 + 渲染图表 + 填充表格
async function doQuery(resetPage = false) {
  if (resetPage) pagination.current = 1;
  const text = (keyword.value || '').trim();
  const token = ++queryToken;
  loading.value = true;

  try {
    if (type.value === 'state') {
      // ----- 州查询 -----
      const q = new Query();
      // sub_region 模糊查询，未输入时默认查询全部
      q.where = text ? `UPPER(sub_region) LIKE UPPER('%${escapeSql(text)}%')` : '1=1';
      q.outFields = ['state_name', 'sub_region', 'pop2000'];
      q.returnGeometry = false;
      const res = await query.executeQueryJSON(STATE_URL, q);
      if (token !== queryToken) return;

      // 按人口降序排列后用于图表 + 表格
      const list = res.features
        .map((f) => f.attributes)
        .sort((a, b) => (b.pop2000 || 0) - (a.pop2000 || 0));

      // 表格数据：附加 index 序号 + key 行键
      stateRows.value = list.map((a, i) => ({
        key: i,
        index: i + 1,
        state_name: a.state_name,
        sub_region: a.sub_region,
        pop2000: a.pop2000
      }));
      renderStateChart(list);
    } else {
      // ----- 城市查询 -----
      const q = new Query();
      q.where = text ? `UPPER(areaname) LIKE UPPER('%${escapeSql(text)}%')` : '1=1';
      q.outFields = ['areaname', 'pop2000'];
      q.returnGeometry = false;
      const res = await query.executeQueryJSON(CITY_URL, q);
      if (token !== queryToken) return;
      const list = res.features
        .map((f) => f.attributes)
        .sort((a, b) => (b.pop2000 || 0) - (a.pop2000 || 0));
      cityRows.value = list.map((a, i) => ({
        key: i,
        index: i + 1,
        areaname: a.areaname,
        pop2000: a.pop2000
      }));
      renderCityChart(list);
    }
  } catch (e) {
    console.error('Population query error', e);
  } finally {
    if (token === queryToken) loading.value = false;
  }
}

// 州人口饼图：前 5 单独显示，其余合并为 "其他"
function renderStateChart(list) {
  if (!chart) initChart();
  if (!chart) return;
  const top5 = list.slice(0, 5);
  const others = list.slice(5);
  const otherSum = others.reduce((s, x) => s + (x.pop2000 || 0), 0);
  const data = top5.map((x) => ({ name: x.state_name, value: x.pop2000 || 0 }));
  if (otherSum > 0) data.push({ name: '其他', value: otherSum });

  chart.setOption(
    {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', right: 20, top: 'middle' },
      series: [
        {
          type: 'pie',
          radius: '65%',
          center: ['38%', '50%'],
          data,
          label: { formatter: '{b}' }// 可进行各种配置
        }
      ]
    },
    true // notMerge：完全替换上次的 option
  );
}

// 城市人口柱状图：仅显示前 10
function renderCityChart(list) {
  if (!chart) initChart();
  if (!chart) return;
  const top10 = list.slice(0, 10);
  chart.setOption(
    {
      tooltip: { trigger: 'axis' },
      grid: { left: 70, right: 30, top: 30, bottom: 70 },
      xAxis: {
        type: 'category',
        data: top10.map((x) => x.areaname),
        axisLabel: { rotate: 30 }, // 城市名较长时倾斜显示
        name: '城市'
      },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'bar',
          data: top10.map((x) => x.pop2000 || 0),
          itemStyle: { color: '#5470c6' }
        }
      ]
    },
    true
  );
}

// 取消 / 确认：都只关闭弹窗
function onCancel() {
  emit('update:open', false);
}

onBeforeUnmount(() => {
  destroyChart();
});
</script>

<style lang="scss" scoped>
.pop-modal {
  display: flex;
  height: 600px;

  // 左侧导航栏
  .nav {
    width: 150px;
    border-right: 1px solid #f0f0f0;
    padding-top: 8px;
    background: #fafafa;

    .nav-item {
      padding: 12px 20px;
      cursor: pointer;
      font-size: 14px;

      // 选中态：浅蓝背景 + 蓝色右侧条
      &.active {
        background: #e6f4ff;
        color: #1677ff;
        font-weight: 500;
        border-right: 2px solid #1677ff;
      }

      &:hover:not(.active) {
        background: #f0f0f0;
      }
    }
  }

  // 右侧内容区
  .content {
    flex: 1;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: auto;

    .search-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;

      .kw-input {
        max-width: 320px;
      }
    }

    .chart-title {
      font-weight: 500;
      margin-bottom: 8px;
      font-size: 14px;
    }

    .chart {
      width: 100%;
      height: 240px;
      margin-bottom: 16px;
    }
  }
}
</style>
