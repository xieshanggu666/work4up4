<template>
  <div class="replay">
    <!-- 概览条 -->
    <div class="rp-overview">
      <div class="rp-stat">
        <b>{{ replay.journal.length }}</b>
        <span>复盘节点</span>
      </div>
      <div class="rp-stat wide">
        <b>{{ spanText }}</b>
        <span>记录时段</span>
      </div>
      <div class="rp-stat">
        <b :class="{ live: !replay.replaying }">{{ replay.replaying ? '#' + (replay.current?.seq ?? '') : '实时' }}</b>
        <span>当前视角</span>
      </div>
    </div>

    <!-- 当前复盘节点详情 -->
    <div v-if="replay.current" class="rp-current">
      <div class="rp-cur-head">
        <span class="rp-seq">#{{ replay.current.seq }}</span>
        <span class="rp-at">{{ replay.current.at }}</span>
        <strong>{{ replay.current.label }}</strong>
      </div>
      <ul class="rp-summary">
        <li v-for="(s, i) in replay.current.summary" :key="i">{{ s }}</li>
      </ul>
      <div class="rp-cur-actions">
        <button class="rp-btn play" @click="replay.play()">▶ 从此播放</button>
        <button class="rp-btn fork" @click="replay.fork()">🔀 从此恢复演练</button>
        <button class="rp-btn" @click="replay.backToLive()">⏭ 返回实时</button>
      </div>
    </div>
    <p v-else class="rp-live-tip">
      🟢 当前为实时态势 · 点击下方任意节点回放该时刻（地图路线 / 资源占用 / 事件状态 / 处置日志同步还原）
    </p>

    <!-- 类型筛选 -->
    <div class="rp-filters">
      <button
        v-for="k in kinds" :key="k.value"
        :class="{ active: filter === k.value }"
        @click="filter = k.value"
      >{{ k.icon }} {{ k.label }}</button>
    </div>

    <!-- 节点列表（最新在前） -->
    <div class="rp-list">
      <div v-if="!filtered.length" class="tiny-empty">暂无复盘节点</div>
      <div
        v-for="e in filtered" :key="e.seq"
        class="rp-item"
        :class="{ active: isCurrent(e) }"
        @click="locate(e)"
      >
        <div class="rp-item-head">
          <span class="rp-seq">#{{ e.seq }}</span>
          <span class="rp-kind" :data-kind="e.kind">{{ kindOf(e.kind).icon }}</span>
          <strong class="rp-label">{{ e.label }}</strong>
          <span class="rp-at">{{ e.at }}</span>
        </div>
        <p v-if="e.summary.length" class="rp-item-sum">
          {{ e.summary[0] }}<template v-if="e.summary.length > 1"> · 等{{ e.summary.length }}项变化</template>
        </p>
        <div class="rp-item-foot">
          <span v-for="c in changedIcons(e)" :key="c" class="rp-chip">{{ c }}</span>
          <span v-if="e.forked" class="rp-fork">🔀 分支点</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useReplayStore, REPLAY_KINDS } from '@/store/replay'

const replay = useReplayStore()
const filter = ref('all')
const kinds = REPLAY_KINDS

const kindOf = (v) => REPLAY_KINDS.find((k) => k.value === v) || REPLAY_KINDS[0]
const filtered = computed(() => {
  const list = filter.value === 'all'
    ? replay.journal
    : replay.journal.filter((e) => e.kind === filter.value)
  return [...list].reverse()
})
const spanText = computed(() => {
  const j = replay.journal
  if (!j.length) return '--'
  return j.length === 1 ? j[0].at : `${j[0].at} ~ ${j[j.length - 1].at}`
})
const isCurrent = (e) => replay.cursor !== null && replay.journal[replay.cursor] === e
const locate = (e) => replay.viewEntry(replay.journal.indexOf(e))
const changedIcons = (e) => {
  const icons = []
  if (e.changed?.command) icons.push('📦')
  if (e.changed?.transfer) icons.push('🚌')
  if (e.changed?.roadblock) icons.push('🚧')
  if (e.changed?.repair) icons.push('🔧')
  return icons
}
</script>

<style scoped>
.replay {
  display: flex; flex-direction: column; gap: 10px;
}
.rp-overview {
  display: flex; gap: 8px;
}
.rp-stat {
  flex: 1; text-align: center;
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 9px; padding: 8px 6px;
}
.rp-stat.wide { flex: 1.6; }
.rp-stat b { display: block; color: #ce93ff; font-size: 15px; line-height: 1.2; }
.rp-stat b.live { color: #7ef0c9; }
.rp-stat span { font-size: 10px; color: #8ba2c8; }

.rp-current {
  background: rgba(29,35,73,0.7); border: 1px solid rgba(156,77,255,0.35);
  border-radius: 10px; padding: 10px 12px;
}
.rp-cur-head { display: flex; align-items: center; gap: 7px; }
.rp-cur-head strong { color: #fff; font-size: 12px; flex: 1; }
.rp-seq {
  font-size: 10px; font-weight: 700; color: #0c1730;
  background: #ce93ff; border-radius: 4px; padding: 1px 5px;
}
.rp-at { font-size: 10px; color: #8ba2c8; font-family: 'Consolas', monospace; }
.rp-summary {
  margin: 8px 0 0; padding: 0 0 0 2px; list-style: none;
  display: flex; flex-direction: column; gap: 4px;
}
.rp-summary li {
  font-size: 11px; color: #aebadd; line-height: 1.45;
  border-left: 2px solid rgba(156,77,255,0.4); padding-left: 7px;
}
.rp-cur-actions { display: flex; gap: 6px; margin-top: 10px; }
.rp-btn {
  flex: 1; padding: 6px 4px; font-size: 11px; border-radius: 6px; cursor: pointer;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.rp-btn:hover { color: #fff; border-color: #4d8dff; }
.rp-btn.play { border-color: rgba(38,166,154,0.5); color: #7ef0c9; }
.rp-btn.play:hover { background: rgba(38,166,154,0.15); }
.rp-btn.fork { border-color: rgba(156,77,255,0.5); color: #ce93ff; }
.rp-btn.fork:hover { background: rgba(156,77,255,0.15); }
.rp-live-tip {
  margin: 0; font-size: 10px; color: #5b6f94; line-height: 1.6;
  border: 1px dashed rgba(120,160,220,0.2); border-radius: 8px; padding: 8px 10px;
}

.rp-filters { display: flex; flex-wrap: wrap; gap: 5px; }
.rp-filters button {
  font-size: 10px; padding: 3px 8px; border-radius: 10px; cursor: pointer;
  background: #101d39; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
}
.rp-filters button.active {
  background: rgba(156,77,255,0.18); border-color: rgba(156,77,255,0.55); color: #e1bee7;
}

.rp-list { display: flex; flex-direction: column; gap: 7px; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
.rp-item {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 8px 10px; cursor: pointer; transition: all 0.15s;
}
.rp-item:hover { border-color: rgba(156,77,255,0.45); }
.rp-item.active {
  border-color: #9c4dff; background: rgba(156,77,255,0.12);
  box-shadow: 0 0 0 1px rgba(156,77,255,0.35);
}
.rp-item-head { display: flex; align-items: center; gap: 6px; }
.rp-item-head .rp-seq { background: #2a3a5e; color: #aebadd; }
.rp-item.active .rp-seq { background: #9c4dff; color: #fff; }
.rp-kind { font-size: 11px; }
.rp-label {
  flex: 1; font-size: 11px; color: #dbe4f3; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rp-item-sum { font-size: 10px; color: #8ba2c8; margin: 5px 0 0; line-height: 1.5; }
.rp-item-foot { display: flex; align-items: center; gap: 5px; margin-top: 5px; }
.rp-chip {
  font-size: 9px; padding: 0 4px; line-height: 15px; border-radius: 4px;
  background: rgba(120,160,220,0.12); border: 1px solid rgba(120,160,220,0.15);
}
.rp-fork {
  font-size: 9px; padding: 0 5px; line-height: 15px; border-radius: 4px;
  background: rgba(156,77,255,0.18); color: #ce93ff;
  border: 1px solid rgba(156,77,255,0.4); margin-left: auto;
}
</style>
