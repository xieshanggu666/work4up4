// 历史复盘：基于事件 / 派发 / 转移 / 阻断 / 抢修记录自动记账，
// 支持按时间轴回放任意节点的状态变化、路线调整、资源占用与处置日志，
// 并可从历史节点截断分支、恢复演练继续指挥（显式分支 + 直接操作自动分支）。
import { defineStore } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import {
  SCENARIOS, RESOURCE_TYPES, EVENT_STATUS, TRANSFER_STATUS, REPAIR_STATUS, REGISTER_STAGES
} from '@/mock/data'

// 复盘节点上限（超出后最早节点归档丢弃）
const MAX_ENTRIES = 150
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
// 深拷贝业务状态（剔除 _ 开头的临时引用，如地图覆盖物 blk._poly，避免循环引用）
const clone = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => (k && k[0] === '_' ? undefined : v)))
const statusLabel = (list, v) => list.find((s) => s.value === v)?.label || v
const stageLabel = (v) => REGISTER_STAGES.find((s) => s.value === v)?.label || v

// 复盘节点类型（筛选与图标）
export const REPLAY_KINDS = [
  { value: 'all', label: '全部', icon: '🗂️' },
  { value: 'event', label: '事件', icon: '📌' },
  { value: 'dispatch', label: '派发', icon: '🚚' },
  { value: 'transfer', label: '转移', icon: '🚌' },
  { value: 'block', label: '阻断', icon: '🚧' },
  { value: 'repair', label: '抢修', icon: '🔧' },
  { value: 'system', label: '系统', icon: '⚙️' }
]

// 业务动作记账规则：kind 用于筛选；primary 动作决定节点标题；
// 级联动作（primary:false）与同 tick 的主动作合并为一个节点，不单独成题。
const ACTION_SPEC = {
  command: {
    loadScenario: { kind: 'system', primary: true, label: ([id]) => `🎬 载入场景《${SCENARIOS.find((s) => s.id === id)?.name || id}》` },
    advanceStatus: { kind: 'event', primary: true, label: ([, to]) => `事件状态流转 → ${statusLabel(EVENT_STATUS, to)}` },
    dispatchResource: { kind: 'dispatch', primary: true, label: ([p]) => `手动派发 ${RESOURCE_TYPES[p?.type]?.label || '资源'}` },
    dispatchToShelter: { kind: 'dispatch', primary: false, label: ([p]) => `安置点补给 ${RESOURCE_TYPES[p?.type]?.label || '物资'}` },
    signDispatch: { kind: 'dispatch', primary: true, label: () => '物资签收 / 短缺认定' },
    replenishShortage: { kind: 'dispatch', primary: true, label: () => '短缺补派' },
    returnDispatch: { kind: 'dispatch', primary: true, label: () => '物资退回入库' },
    withdrawDispatch: { kind: 'dispatch', primary: true, label: () => '撤回派发' },
    resetResource: { kind: 'dispatch', primary: true, label: () => '重置事件资源' },
    submitPlan: { kind: 'dispatch', primary: true, label: () => '提交统筹方案（批量派发）' },
    generatePlan: { kind: 'dispatch', primary: false, label: () => '生成统筹方案' },
    updatePlanItem: { kind: 'dispatch', primary: false, label: () => '调整统筹方案' },
    removePlanItem: { kind: 'dispatch', primary: false, label: () => '移除统筹方案项' },
    clearPlan: { kind: 'dispatch', primary: false, label: () => '清空统筹方案' },
    _pushDispatch: { kind: 'dispatch', primary: false, label: () => '生成派发单' },
    _withdrawRecord: { kind: 'dispatch', primary: false, label: () => '撤回留账' },
    rerouteDispatch: { kind: 'dispatch', primary: false, label: () => '派发绕行改道' },
    reassignDispatch: { kind: 'dispatch', primary: false, label: () => '派发改派基地' },
    holdDispatch: { kind: 'dispatch', primary: false, label: () => '派发挂起' },
    resumeDispatch: { kind: 'dispatch', primary: false, label: () => '派发续派' },
    resetDispatchRoute: { kind: 'dispatch', primary: false, label: () => '派发路线回直' }
  },
  transfer: {
    load: { kind: 'system', primary: false, label: null },
    createBatch: { kind: 'transfer', primary: true, label: ([p]) => `创建转移批次（${p?.headcount ?? '?'}人）` },
    reassignBatch: { kind: 'transfer', primary: true, label: () => '批次改派' },
    closeBatch: { kind: 'transfer', primary: true, label: () => '批次办结' },
    cancelBatch: { kind: 'transfer', primary: true, label: () => '取消批次' },
    register: { kind: 'transfer', primary: true, label: ([, stage]) => `现场登记：${stageLabel(stage)}` },
    advanceMember: { kind: 'transfer', primary: true, label: () => '人员登记推进' },
    movePerson: { kind: 'transfer', primary: true, label: () => '人员跨批改派' },
    splitBatch: { kind: 'transfer', primary: true, label: () => '批次拆分' },
    settleShelters: { kind: 'transfer', primary: true, label: () => '安置点补给日结' },
    autoSupply: { kind: 'transfer', primary: true, label: () => '安置点一键补给' },
    holdBatch: { kind: 'transfer', primary: false, label: () => '批次挂起' },
    resumeBatch: { kind: 'transfer', primary: false, label: () => '批次续派' },
    rerouteBatch: { kind: 'transfer', primary: false, label: () => '批次绕行改道' },
    resetBatchRoute: { kind: 'transfer', primary: false, label: () => '批次路线回直' }
  },
  roadblock: {
    load: { kind: 'system', primary: false, label: null },
    reportBlock: { kind: 'block', primary: true, label: ([p]) => `上报道路阻断「${p?.name || '未命名'}」` },
    assess: { kind: 'block', primary: false, label: () => '影响评估' },
    assessActive: { kind: 'block', primary: false, label: () => '影响复核' },
    confirmImpacts: { kind: 'block', primary: true, label: () => '确认影响生成处置方案' },
    applyImpact: { kind: 'block', primary: true, label: () => '执行阻断处置方案' },
    applyAll: { kind: 'block', primary: true, label: () => '一键执行全部处置方案' },
    clearBlock: { kind: 'block', primary: true, label: () => '恢复通行' },
    resumeHeld: { kind: 'block', primary: true, label: () => '挂起任务续派' },
    removeBlock: { kind: 'block', primary: false, label: () => '删除历史阻断记录' }
  },
  repair: {
    load: { kind: 'system', primary: false, label: null },
    createOrder: { kind: 'repair', primary: true, label: () => '发起抢修工单' },
    acceptOrder: { kind: 'repair', primary: true, label: () => '现场接单' },
    reportProgress: { kind: 'repair', primary: true, label: ([, p]) => `抢修进度上报 ${p?.progress ?? ''}%` },
    finishOrder: { kind: 'repair', primary: true, label: () => '完工上报（待验收）' },
    delayOrder: { kind: 'repair', primary: true, label: () => '抢修延期' },
    failOrder: { kind: 'repair', primary: true, label: () => '抢修失败 / 验收不通过' },
    cancelOrder: { kind: 'repair', primary: true, label: () => '抢修撤单' },
    acceptWork: { kind: 'repair', primary: true, label: () => '验收通过解除封闭' },
    settleByBlock: { kind: 'repair', primary: false, label: () => '工单联动办结' }
  }
}

const SLICES = ['command', 'transfer', 'roadblock', 'repair']
let pending = null // 同 tick 内合并记账的动作队列
let lastSliceRaw = null // 日志头部节点的分片快照串（去重与变更标记）
let pendingForkFrom = null // 自动分支来源节点 seq
let playTimer = null

// 相邻节点对比摘要：状态变化 / 路线调整 / 资源占用 / 处置日志（复盘四要素）
function summarize(prev, next) {
  if (!prev) return ['🎬 演练初始状态']
  const out = []
  // 1) 事件状态变化
  const prevEv = new Map(prev.command.events.map((e) => [e.id, e]))
  next.command.events.forEach((e) => {
    const p = prevEv.get(e.id)
    if (p && p.status !== e.status) {
      out.push(`📌 ${e.title}：${statusLabel(EVENT_STATUS, p.status)} → ${statusLabel(EVENT_STATUS, e.status)}`)
    }
  })
  // 2) 路线调整（物资派发 + 转移批次）
  const prevDp = new Map(prev.command.dispatches.map((d) => [d.id, d]))
  const DP_STATUS = { enroute: '在途', held: '挂起', done: '办结', withdrawn: '撤回' }
  next.command.dispatches.forEach((d) => {
    const p = prevDp.get(d.id)
    if (!p) return
    if (JSON.stringify(p.via || []) !== JSON.stringify(d.via || [])) {
      out.push(d.via?.length
        ? `🔀 路线调整：${d.typeLabel} 绕行 ${d.via.length} 个途经点（${d.distance}km·${d.minutes}min）`
        : `↩️ 路线回直：${d.typeLabel}（${d.distance}km·${d.minutes}min）`)
    }
    if (p.status !== d.status) out.push(`🚚 派发${DP_STATUS[d.status] || d.status}：${d.typeLabel} ${d.qty}${d.unit}（${d.baseName}）`)
    if (p.baseId !== d.baseId) out.push(`🔀 改派出库：${d.typeLabel} ${p.baseName} → ${d.baseName}`)
  })
  const newDp = next.command.dispatches.filter((d) => !prevDp.has(d.id))
  if (newDp.length) out.push(`🚀 新增派发 ${newDp.length} 条（${[...new Set(newDp.map((d) => d.typeLabel))].join('、')}）`)
  const prevBt = new Map(prev.transfer.batches.map((b) => [b.id, b]))
  next.transfer.batches.forEach((b) => {
    const p = prevBt.get(b.id)
    if (!p) return
    if (JSON.stringify(p.via || []) !== JSON.stringify(b.via || [])) {
      out.push(b.via?.length ? `🔀 批次「${b.name}」绕行 ${b.via.length} 个途经点` : `↩️ 批次「${b.name}」路线回直`)
    }
    if (!!p.held !== !!b.held) out.push(b.held ? `⏸ 批次「${b.name}」挂起待通` : `▶️ 批次「${b.name}」恢复续派`)
    if (p.status !== b.status) out.push(`🚌 批次「${b.name}」：${statusLabel(TRANSFER_STATUS, p.status)} → ${statusLabel(TRANSFER_STATUS, b.status)}`)
  })
  const newBt = next.transfer.batches.filter((b) => !prevBt.has(b.id))
  if (newBt.length) out.push(`🚌 新增转移批次 ${newBt.length} 个（${newBt.map((b) => b.name).join('、')}）`)
  // 3) 资源占用（各基地库存增减）
  const prevBase = new Map(prev.command.bases.map((b) => [b.id, b]))
  const deltas = []
  next.command.bases.forEach((b) => {
    const p = prevBase.get(b.id)
    if (!p) return
    Object.keys(b.stock || {}).forEach((t) => {
      const d = (b.stock[t] || 0) - ((p.stock || {})[t] || 0)
      if (d !== 0) deltas.push(`${b.name} ${RESOURCE_TYPES[t]?.label || t} ${d > 0 ? '+' : ''}${d}`)
    })
  })
  if (deltas.length) out.push(`📦 资源占用：${deltas.slice(0, 2).join('；')}${deltas.length > 2 ? ` 等${deltas.length}项` : ''}`)
  // 4) 阻断与抢修
  const prevBlk = new Map(prev.roadblock.blocks.map((b) => [b.id, b]))
  next.roadblock.blocks.forEach((b) => {
    const p = prevBlk.get(b.id)
    if (!p) out.push(`🚧 新增阻断「${b.name}」`)
    else if (p.status !== b.status) out.push(b.status === 'cleared' ? `✅ 阻断「${b.name}」恢复通行` : `🚧 阻断「${b.name}」${b.status}`)
  })
  const prevRo = new Map(prev.repair.orders.map((o) => [o.id, o]))
  next.repair.orders.forEach((o) => {
    const p = prevRo.get(o.id)
    if (!p) out.push(`🔧 新增抢修工单（${o.blockName}）`)
    else if (p.status !== o.status) out.push(`🔧 工单${statusLabel(REPAIR_STATUS, o.status)}：${o.blockName}`)
  })
  // 5) 处置日志增量（事件时间线 + 阻断日志 + 工单日志）
  const logs = (s) =>
    s.command.events.reduce((n, e) => n + (e.timeline?.length || 0), 0) +
    s.roadblock.blocks.reduce((n, b) => n + (b.log?.length || 0), 0) +
    s.repair.orders.reduce((n, o) => n + (o.logs?.length || 0), 0)
  const dlog = logs(next) - logs(prev)
  if (dlog > 0) out.push(`📝 新增处置日志 ${dlog} 条`)
  return out.slice(0, 6)
}

export const useReplayStore = defineStore('replay', {
  state: () => ({
    journal: [], // 复盘节点：{ seq, at, kind, label, summary, changed, forked, state }
    cursor: null, // null=实时（最新节点）；数字=正在查看的历史节点下标
    playing: false,
    speed: 1,
    ready: false // 动作订阅是否已挂载
  }),

  getters: {
    replaying: (s) => s.cursor !== null,
    current: (s) => (s.cursor !== null ? s.journal[s.cursor] || null : null),
    latest: (s) => s.journal[s.journal.length - 1] || null
  },

  actions: {
    // 挂载四个业务 store 的动作订阅（幂等；App 启动与测试初始化时调用）
    init() {
      if (this.ready) return
      this.ready = true
      const stores = {
        command: useCommandStore(),
        transfer: useTransferStore(),
        roadblock: useRoadblockStore(),
        repair: useRepairStore()
      }
      Object.entries(ACTION_SPEC).forEach(([storeName, spec]) => {
        stores[storeName].$onAction(({ name, args, after }) => {
          const meta = spec[name]
          if (!meta) return
          after(() => this._onAction(storeName, name, args, meta))
        })
      })
    },

    // 业务动作完成 → 并入同 tick 记账队列（微任务统一落账，级联动作合并为单节点）
    _onAction(storeName, action, args, meta) {
      // 场景切换：清空复盘日志重新记账
      if (storeName === 'command' && action === 'loadScenario') this._reset()
      // 历史节点上继续操作 → 自动分支（截断后续节点）
      if (this.cursor !== null) this._forkAtCursor(false)
      if (!pending) pending = []
      const text = typeof meta.label === 'function' ? meta.label(args) : null
      pending.push({ text, primary: meta.primary, kind: meta.kind })
      queueMicrotask(() => this._flush())
    },

    _flush() {
      const items = pending
      pending = null
      if (!items || !items.length) return
      const state = this._snapshot()
      const sliceRaw = {}
      SLICES.forEach((k) => { sliceRaw[k] = JSON.stringify(state[k]) })
      const prev = this.journal[this.journal.length - 1] || null
      const changed = {}
      let any = false
      SLICES.forEach((k) => {
        changed[k] = !lastSliceRaw || sliceRaw[k] !== lastSliceRaw[k]
        if (changed[k]) any = true
      })
      // 校验拦截等未改变状态的动作不产生复盘节点
      if (!any) return
      const mains = items.filter((x) => x.primary && x.text)
      const picks = mains.length ? mains : items.filter((x) => x.text)
      const texts = [...new Set(picks.map((x) => x.text))]
      let label = texts.slice(0, 2).join('；')
      if (texts.length > 2) label += ` 等${texts.length}项`
      this.journal.push({
        seq: (prev?.seq || 0) + 1,
        at: nowStr(),
        kind: (mains[0] || picks[0] || items[0]).kind,
        label: label || '状态变更',
        summary: summarize(prev?.state || null, state),
        changed,
        forked: pendingForkFrom != null,
        state
      })
      pendingForkFrom = null
      if (this.journal.length > MAX_ENTRIES) this.journal.shift()
      lastSliceRaw = sliceRaw
    },

    // 全量业务状态快照（仅业务数据，不含筛选/圈画等界面状态）
    _snapshot() {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const rb = useRoadblockStore()
      const rp = useRepairStore()
      return {
        command: clone({
          scenarioId: cmd.scenarioId, events: cmd.events, bases: cmd.bases,
          dispatches: cmd.dispatches, plan: cmd.plan, planResult: cmd.planResult
        }),
        transfer: clone({ shelters: tr.shelters, batches: tr.batches, settleDay: tr.settleDay }),
        roadblock: clone({ blocks: rb.blocks }),
        repair: clone({ orders: rp.orders })
      }
    },

    // 将节点状态回放到各业务 store（地图/面板/大屏经响应式自动还原）
    _apply(state) {
      const s = clone(state)
      useCommandStore().$patch(s.command)
      useTransferStore().$patch(s.transfer)
      useRoadblockStore().$patch(s.roadblock)
      useRepairStore().$patch(s.repair)
    },

    _reset() {
      this.journal = []
      this.cursor = null
      this.pause()
      lastSliceRaw = null
      pendingForkFrom = null
    },

    _recomputeLastRaw() {
      const head = this.journal[this.journal.length - 1]
      if (!head) { lastSliceRaw = null; return }
      lastSliceRaw = {}
      SLICES.forEach((k) => { lastSliceRaw[k] = JSON.stringify(head.state[k]) })
    },

    /* ---------- 时间轴回放 ---------- */

    // 定位查看任意节点
    viewEntry(i) {
      if (!this.journal.length) return
      i = Math.max(0, Math.min(this.journal.length - 1, Math.round(i)))
      this.pause()
      const cmd = useCommandStore()
      if (cmd.autoPlay) cmd.stopAutoPlay() // 实时模拟与复盘回放互斥，避免状态漂移
      this.cursor = i
      this._apply(this.journal[i].state)
    },
    // 返回实时（最新节点即当前态势）
    backToLive() {
      const head = this.journal[this.journal.length - 1]
      if (head) this._apply(head.state)
      this.cursor = null
      this.pause()
    },
    // 步进：越过最新节点即回到实时
    step(d) {
      const cur = this.cursor === null ? this.journal.length - 1 : this.cursor
      const next = cur + d
      if (next >= this.journal.length - 1) {
        if (d > 0) { this.backToLive(); return }
      }
      if (next < 0 || next > this.journal.length - 1) return
      this.viewEntry(next)
    },
    // 播放：实时状态下从头回放；查看历史节点时从该节点续播，播完自动回到实时
    play() {
      if (this.playing || this.journal.length < 2) return
      if (this.cursor === null) this.viewEntry(0)
      this.playing = true
      this._armTimer()
    },
    _armTimer() {
      clearInterval(playTimer)
      playTimer = setInterval(() => {
        if (this.cursor === null) { this.pause(); return }
        const next = this.cursor + 1
        if (next >= this.journal.length - 1) {
          this.backToLive()
          return
        }
        this.cursor = next
        this._apply(this.journal[next].state)
      }, Math.round(1100 / this.speed))
    },
    pause() {
      this.playing = false
      clearInterval(playTimer)
    },
    setSpeed(v) {
      this.speed = v
      if (this.playing) this._armTimer()
    },

    /* ---------- 从任意节点恢复演练 ---------- */

    // 显式分支：截断后续节点并留痕，演练自当前查看节点继续
    fork() {
      if (this.cursor === null) return
      this._forkAtCursor(true)
    },
    _forkAtCursor(withMarker) {
      const i = this.cursor
      const head = this.journal[i]
      if (!head) { this.cursor = null; return }
      const dropped = this.journal.length - i - 1
      this.journal = this.journal.slice(0, i + 1)
      this.cursor = null
      this.pause()
      this._recomputeLastRaw()
      if (withMarker) {
        // 分支标记节点（状态与截断点一致，便于复盘留痕）
        this.journal.push({
          seq: head.seq + 1,
          at: nowStr(),
          kind: 'system',
          label: `🔀 从节点 #${head.seq} 恢复演练`,
          summary: [`后续 ${dropped} 个节点已归档，演练自 #${head.seq} 继续`],
          changed: { command: false, transfer: false, roadblock: false, repair: false },
          forked: true,
          state: clone(head.state)
        })
      } else {
        pendingForkFrom = head.seq // 下一个业务节点标记为分支
      }
    }
  }
})
