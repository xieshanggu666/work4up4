import { defineStore, getActivePinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import {
  RESOURCE_TYPES, EVENT_TYPES, EVENT_STATUS, TRANSFER_STATUS, REPAIR_STATUS
} from '@/mock/data'

/* =========================================================================
 * 历史复盘模块（事件溯源）
 *
 * 录制：包装四个业务 store 的 action，每个成功改变状态的「最外层动作」沉淀一帧——
 *       全量状态快照（事件/派发/转移/阻断/抢修/库存）+ 动作元数据 + 当帧新增处置日志。
 * 回放：seek 到任意帧即用快照整体替换当前态势（地图/面板全部响应式联动），
 *       回放期间业务动作一律拦截，演练处于只读锁定状态。
 * 恢复：从任意节点「恢复演练」= 在该帧分叉，截断之后的历史，后续动作沿新分支继续记录。
 * ========================================================================= */

const STATUS_LABEL = (list) => (v) => list.find((s) => s.value === v)?.label || v
const eventStatusLabel = STATUS_LABEL(EVENT_STATUS)
const batchStatusLabel = STATUS_LABEL(TRANSFER_STATUS)
const repairStatusLabel = STATUS_LABEL(REPAIR_STATUS)

// 不进入复盘时间轴的动作：内部「_」方法、纯 UI 状态、绘图草稿、时钟、自动模拟、场景载入、
// 以及只会被其它业务动作内部调用的联动方法（由外层动作统一记一帧）
const JOURNAL_SKIP = new Set([
  'loadScenario', 'load',
  'selectEvent',
  'startDrawing', 'addDraftPoint', 'undoDraftPoint', 'cancelDrawing', 'finishDrawing', 'cancelReport', 'quickPolygon',
  'startAssign', 'cancelAssign', 'focusOrder',
  'setClock', 'startAutoPlay', 'stopAutoPlay',
  'assessActive', 'resetDispatchRoute', 'resetBatchRoute'
])

const CATEGORY_META = {
  event:    { label: '事件流转', color: '#ff9800', icon: '🚨' },
  dispatch: { label: '物资派发', color: '#2f9cf5', icon: '📦' },
  supply:   { label: '安置补给', color: '#26a69a', icon: '🥫' },
  transfer: { label: '群众转移', color: '#ab47bc', icon: '🚌' },
  block:    { label: '道路阻断', color: '#ef5350', icon: '🚧' },
  repair:   { label: '道路抢修', color: '#ffc107', icon: '🔧' },
  system:   { label: '系统', color: '#78909c', icon: '🎬' }
}

const ACTION_CATEGORY = {
  cmd: {
    advanceStatus: 'event',
    dispatchResource: 'dispatch', dispatchToShelter: 'supply',
    signDispatch: 'dispatch', replenishShortage: 'dispatch', returnDispatch: 'dispatch',
    rerouteDispatch: 'dispatch', reassignDispatch: 'dispatch',
    holdDispatch: 'dispatch', resumeDispatch: 'dispatch',
    withdrawDispatch: 'dispatch', resetResource: 'dispatch',
    generatePlan: 'dispatch', updatePlanItem: 'dispatch', removePlanItem: 'dispatch',
    clearPlan: 'dispatch', submitPlan: 'dispatch'
  },
  tr: {
    createBatch: 'transfer', reassignBatch: 'transfer', closeBatch: 'transfer', cancelBatch: 'transfer',
    register: 'transfer', advanceMember: 'transfer', movePerson: 'transfer', splitBatch: 'transfer',
    holdBatch: 'transfer', resumeBatch: 'transfer', rerouteBatch: 'transfer',
    settleShelters: 'supply', autoSupply: 'supply'
  },
  rb: {
    reportBlock: 'block', assess: 'block', confirmImpacts: 'block',
    applyImpact: 'block', applyAll: 'block', clearBlock: 'block',
    resumeHeld: 'block', removeBlock: 'block'
  },
  ro: {
    createOrder: 'repair', acceptOrder: 'repair', reportProgress: 'repair',
    finishOrder: 'repair', delayOrder: 'repair', failOrder: 'repair',
    cancelOrder: 'repair', acceptWork: 'repair'
  }
}

let recordDepth = 0
const FRAME_CAP = 1000
const PLAY_INTERVAL = { 1: 1600, 2: 900, 4: 450 }

const clone = (x) => JSON.parse(JSON.stringify(x))
const timeLabel = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

/* ---------- 快照 ---------- */

// 阻断多边形上挂着高德 Polygon 覆盖物（_poly），快照前剔除，保证可 JSON 序列化
function cleanBlocks(blocks) {
  return blocks.map((b) => {
    const { _poly, ...rest } = b
    return rest
  })
}

function takeSnapshot() {
  const cmd = useCommandStore()
  const tr = useTransferStore()
  const rb = useRoadblockStore()
  const ro = useRepairStore()
  // 整体深克隆：帧快照必须与实时状态脱钩，否则后续原地修改会穿透历史帧
  return clone({
    cmd: {
      events: cmd.events,
      bases: cmd.bases,
      dispatches: cmd.dispatches,
      plan: cmd.plan,
      planResult: cmd.planResult,
      selectedEventId: cmd.selectedEventId,
      filter: cmd.filter,
      search: cmd.search
    },
    tr: {
      shelters: tr.shelters,
      batches: tr.batches,
      settleDay: tr.settleDay,
      clock: tr.clock
    },
    rb: {
      blocks: cleanBlocks(rb.blocks),
      drawing: false, draft: [], reporting: false,
      selectedBlockId: rb.selectedBlockId
    },
    ro: {
      orders: ro.orders,
      assigningBlockId: null,
      focusOrderId: ro.focusOrderId,
      clock: ro.clock
    }
  })
}

/* ---------- 快照内联查 ---------- */

function evInSnap(snap, id) { return snap.cmd.events.find((e) => e.id === id) }
function baseInSnap(snap, id) { return snap.cmd.bases.find((b) => b.id === id) }
function dpInSnap(snap, id) { return snap.cmd.dispatches.find((d) => d.id === id) }
function batchInSnap(snap, id) { return snap.tr.batches.find((b) => b.id === id) }
function shelterInSnap(snap, id) { return snap.tr.shelters.find((s) => s.id === id) }
function blockInSnap(snap, id) { return snap.rb.blocks.find((b) => b.id === id) }
function orderInSnap(snap, id) { return snap.ro.orders.find((o) => o.id === id) }

function dispatchName(d) {
  if (!d) return '派发'
  return `${d.typeLabel} ${d.qty}${d.unit}｜${d.baseName} → ${d.eventTitle || d.shelterName}`
}
function batchName(snap, b) {
  if (!b) return '批次'
  const ev = evInSnap(snap, b.eventId)
  return `批次「${b.name}」${ev ? '（' + ev.title + '）' : ''}`
}

/* ---------- 动作标题 ---------- */

function describeFrame(module, action, args, snap) {
  const category = ACTION_CATEGORY[module]?.[action] || 'system'
  let title = ''
  try {
    if (module === 'cmd') title = describeCmd(action, args, snap)
    else if (module === 'tr') title = describeTr(action, args, snap)
    else if (module === 'rb') title = describeRb(action, args, snap)
    else if (module === 'ro') title = describeRo(action, args, snap)
  } catch { /* 标题生成失败不影响录制 */ }
  if (!title) title = action
  return { category, title }
}

function describeCmd(action, args, snap) {
  switch (action) {
    case 'advanceStatus': {
      const ev = evInSnap(snap, args[0])
      return `事件状态流转：${ev?.title || args[0]} → ${eventStatusLabel(args[1])}`
    }
    case 'dispatchResource': {
      const a = args[0] || {}
      const ev = evInSnap(snap, a.eventId)
      const base = baseInSnap(snap, a.baseId)
      return `派发 ${RESOURCE_TYPES[a.type]?.label || a.type} ${a.qty}${RESOURCE_TYPES[a.type]?.unit || ''}：${base?.name || ''} → ${ev?.title || ''}`
    }
    case 'dispatchToShelter': {
      const a = args[0] || {}
      const base = baseInSnap(snap, a.baseId)
      return `安置点补给 ${RESOURCE_TYPES[a.type]?.label || a.type} ${a.qty}${RESOURCE_TYPES[a.type]?.unit || ''}：${base?.name || ''} → ${a.shelterName || ''}`
    }
    case 'signDispatch': {
      const d = dpInSnap(snap, args[0])
      const a = args[1] || {}
      const parts = []
      if (a.qty > 0) parts.push(`签收 ${a.qty}${d?.unit || ''}`)
      if (a.shortQty > 0) parts.push(`认定短缺 ${a.shortQty}${d?.unit || ''}`)
      return `物资${parts.join('、') || '签认'}：${dispatchName(d)}`
    }
    case 'replenishShortage':
      return `短缺补派出库：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'returnDispatch':
      return `物资退回入库：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'rerouteDispatch':
      return `派发绕行改道：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'reassignDispatch': {
      const d = dpInSnap(snap, args[0])
      const nb = baseInSnap(snap, args[1])
      return `派发改派基地：${dispatchName(d)} → 改由 ${nb?.name || ''} 出库`
    }
    case 'holdDispatch':
      return `派发挂起待通：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'resumeDispatch':
      return `派发恢复续派：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'withdrawDispatch':
      return `撤回派发（在途余量回库留账）：${dispatchName(dpInSnap(snap, args[0]))}`
    case 'resetResource': {
      const ev = evInSnap(snap, args[0])
      return `重置事件资源、撤回全部派发：${ev?.title || args[0]}`
    }
    case 'generatePlan': return '生成多灾点统筹分配方案'
    case 'updatePlanItem': return '人工调整统筹方案（数量/基地）'
    case 'removePlanItem': return '删除统筹方案项'
    case 'clearPlan': return '清空统筹方案'
    case 'submitPlan': return '提交统筹方案、批量锁定库存并派发'
    default: return ''
  }
}

function describeTr(action, args, snap) {
  switch (action) {
    case 'createBatch': {
      const a = args[0] || {}
      const b = snap.tr.batches.find((x) => x.eventId === a.eventId && x.headcount === a.headcount)
      const sh = shelterInSnap(snap, a.shelterId)
      return `创建转移批次「${b?.name || ''}」：${a.headcount} 人 → ${sh?.name || ''}`
    }
    case 'reassignBatch':
      return `批次改派（安置点/车辆调整）：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'closeBatch':
      return `批次办结、车辆回收：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'cancelBatch':
      return `取消转移批次、释放车辆：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'register': {
      const b = batchInSnap(snap, args[0])
      const stage = { pickup: '接运', checkin: '入住', checkout: '转出' }[args[1]] || '登记'
      const p = args[2] || {}
      const who = p.count != null ? `${p.count} 人批量` : (p.name ? '「' + p.name + '」' : '人员')
      return `${stage}登记 ${who}：${batchName(snap, b)}`
    }
    case 'advanceMember':
      return `人员登记环节快捷推进：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'movePerson': {
      const to = batchInSnap(snap, args[1])
      return `人员跨批次改派 → 「${to?.name || ''}」`
    }
    case 'splitBatch': {
      const a = args[1] || {}
      return `按人员分组拆分批次，新分组「${a.name || ''}」`
    }
    case 'holdBatch':
      return `转移批次挂起（保留车辆/床位预占）：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'resumeBatch':
      return `转移批次恢复续派：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'rerouteBatch':
      return `转移批次绕行改道：${batchName(snap, batchInSnap(snap, args[0]))}`
    case 'settleShelters':
      return `安置点按日补给日结（第 ${snap.tr.settleDay - 1} 日账目结转）`
    case 'autoSupply': {
      const sh = shelterInSnap(snap, args[0])
      return `安置点一键按缺口补给：${sh?.name || ''}`
    }
    default: return ''
  }
}

function describeRb(action, args, snap) {
  switch (action) {
    case 'reportBlock': {
      const a = args[0] || {}
      return `现场上报道路阻断：${a.name || '未命名阻断'}`
    }
    case 'assess':
      return `重新进行阻断影响评估：${blockInSnap(snap, args[0])?.name || ''}`
    case 'confirmImpacts':
      return `指挥员确认受影响任务、生成处置方案：${blockInSnap(snap, args[0])?.name || ''}`
    case 'applyImpact':
      return `执行阻断处置方案（绕行/改派/挂起）：${blockInSnap(snap, args[0])?.name || ''}`
    case 'applyAll':
      return `一键执行阻断全部处置方案：${blockInSnap(snap, args[0])?.name || ''}`
    case 'clearBlock':
      return `道路恢复通行、受影响运输联合重算：${blockInSnap(snap, args[0])?.name || ''}`
    case 'resumeHeld':
      return '一键续派挂起任务（路线与库存复核）'
    case 'removeBlock':
      return '删除已恢复的阻断记录'
    default: return ''
  }
}

function describeRo(action, args, snap) {
  const o = orderInSnap(snap, args[0])
  const tag = o ? `工单（${o.blockName}）` : '抢修工单'
  switch (action) {
    case 'createOrder': return `派出道路抢修${tag}：分配队伍/车辆/物资`
    case 'acceptOrder': return `现场队伍接单、开始抢修：${tag}`
    case 'reportProgress': return `抢修进度上报 ${(args[1] || {}).progress ?? ''}%：${tag}`
    case 'finishOrder': return `完工上报实际消耗、进入待验收：${tag}`
    case 'delayOrder': return `抢修延期申请，阻断继续保留：${tag}`
    case 'failOrder': return `抢修失败/验收不通过，阻断保留、资源结算归还：${tag}`
    case 'cancelOrder': return `撤销抢修工单，阻断保留、资源结算归还：${tag}`
    case 'acceptWork': return `验收通过、解除封闭并重算运输：${tag}`
    default: return ''
  }
}

/* ---------- 当帧新增处置日志（事件时间线 / 阻断日志 / 工单日志） ---------- */

function collectLogs(next, prev) {
  const logs = []
  next.cmd.events.forEach((ev) => {
    const old = prev ? evInSnap(prev, ev.id) : null
    const from = old ? old.timeline.length : 0
    ev.timeline.slice(from).forEach((t) => logs.push({ source: 'event', tag: ev.title, at: t.at, text: t.text }))
  })
  next.rb.blocks.forEach((blk) => {
    const old = prev ? blockInSnap(prev, blk.id) : null
    const from = old ? old.log.length : 0
    blk.log.slice(from).forEach((t) => logs.push({ source: 'block', tag: blk.name, at: t.at, text: t.text }))
  })
  next.ro.orders.forEach((o) => {
    const old = prev ? orderInSnap(prev, o.id) : null
    const from = old ? old.logs.length : 0
    o.logs.slice(from).forEach((t) => logs.push({ source: 'repair', tag: o.blockName, at: t.at, text: t.text }))
  })
  return logs
}

/* ---------- 帧间差异（复盘详情四个维度） ---------- */

const DP_STATUS_LABEL = { enroute: '在途', held: '挂起', done: '已办结', withdrawn: '已撤回' }

function diffSnapshots(prev, next) {
  const statusChanges = []
  const routes = []
  const stocks = []
  const occupancy = []
  const counters = {}

  /* 事件 */
  next.cmd.events.forEach((ev) => {
    const old = prev ? evInSnap(prev, ev.id) : null
    if (!old) statusChanges.push({ icon: '🚨', color: CATEGORY_META.event.color, text: `新增事件：${ev.title}（${eventStatusLabel(ev.status)}）` })
    else {
      if (old.status !== ev.status) {
        statusChanges.push({ icon: '🔁', color: CATEGORY_META.event.color, text: `事件「${ev.title}」状态：${eventStatusLabel(old.status)} → ${eventStatusLabel(ev.status)}` })
      }
      if (old.affected !== ev.affected) {
        statusChanges.push({ icon: '👥', color: CATEGORY_META.event.color, text: `事件「${ev.title}」受影响人数：${old.affected} → ${ev.affected}` })
      }
    }
  })

  /* 派发：状态机 + 四本账 */
  next.cmd.dispatches.forEach((d) => {
    const old = prev ? dpInSnap(prev, d.id) : null
    const name = dispatchName(d)
    if (!old) {
      statusChanges.push({ icon: '📦', color: CATEGORY_META.dispatch.color, text: `新增派发：${name}` })
    } else {
      if (old.status !== d.status) {
        statusChanges.push({ icon: '🔁', color: CATEGORY_META.dispatch.color, text: `派发状态：${name} — ${DP_STATUS_LABEL[old.status] || old.status} → ${DP_STATUS_LABEL[d.status] || d.status}` })
      }
      const ledger = [
        ['signedQty', '累计实收'], ['shortQty', '认定短缺'],
        ['returnedQty', '累计退回'], ['withdrawnQty', '撤回回库']
      ]
      ledger.forEach(([k, lab]) => {
        if ((old[k] || 0) !== (d[k] || 0)) {
          statusChanges.push({ icon: '🧾', color: CATEGORY_META.dispatch.color, text: `${name} ${lab}：${old[k] || 0} → ${d[k] || 0}${d.unit}` })
        }
      })
    }
    const oRoute = old ? { base: old.baseName, distance: old.distance, minutes: old.minutes, via: (old.via || []).length } : null
    const nRoute = { base: d.baseName, distance: d.distance, minutes: d.minutes, via: (d.via || []).length }
    if (!oRoute || oRoute.base !== nRoute.base || oRoute.distance !== nRoute.distance || oRoute.minutes !== nRoute.minutes || oRoute.via !== nRoute.via) {
      routes.push({
        color: CATEGORY_META.dispatch.color,
        name,
        from: oRoute,
        to: nRoute,
        kind: old?.baseId !== d.baseId ? '改派基地' : (nRoute.via > 0 ? '绕行路线' : '直达路线')
      })
    }
  })
  if (prev) {
    prev.cmd.dispatches.forEach((d) => {
      if (!dpInSnap(next, d.id)) statusChanges.push({ icon: '🗑', color: CATEGORY_META.dispatch.color, text: `派发记录移除：${dispatchName(d)}` })
    })
  }

  /* 转移批次 */
  next.tr.batches.forEach((b) => {
    const old = prev ? batchInSnap(prev, b.id) : null
    const name = batchName(next, b)
    if (!old) {
      statusChanges.push({ icon: '🚌', color: CATEGORY_META.transfer.color, text: `新增转移批次：${name}（计划 ${b.headcount} 人，车辆 ${b.vehicleCount} 辆）` })
    } else {
      if (old.status !== b.status) {
        statusChanges.push({ icon: '🔁', color: CATEGORY_META.transfer.color, text: `${name} 状态：${batchStatusLabel(old.status)} → ${batchStatusLabel(b.status)}` })
      }
      if (!!old.held !== !!b.held) {
        statusChanges.push({ icon: b.held ? '⏸' : '▶️', color: CATEGORY_META.transfer.color, text: `${name} ${b.held ? '挂起待通（车辆/床位预占保留）' : '恢复续派'}` })
      }
      if (old.shelterId !== b.shelterId) {
        statusChanges.push({ icon: '🔀', color: CATEGORY_META.transfer.color, text: `${name} 安置点改派：${shelterInSnap(next, old.shelterId)?.name || ''} → ${shelterInSnap(next, b.shelterId)?.name || ''}` })
      }
      if (old.members.length !== b.members.length) {
        statusChanges.push({ icon: '👤', color: CATEGORY_META.transfer.color, text: `${name} 登记人数：${old.members.length} → ${b.members.length}` })
      }
      if (old.headcount !== b.headcount) {
        statusChanges.push({ icon: '✂️', color: CATEGORY_META.transfer.color, text: `${name} 计划人数调整：${old.headcount} → ${b.headcount}` })
      }
      const o = old.eta || {}, n = b.eta || {}
      const oSh = old.shelterId, nSh = b.shelterId
      if (o.distance !== n.distance || o.minutes !== n.minutes || (old.via || []).length !== (b.via || []).length || oSh !== nSh) {
        routes.push({
          color: CATEGORY_META.transfer.color,
          name,
          from: old ? { base: shelterInSnap(next, old.shelterId)?.name, distance: o.distance, minutes: o.minutes, via: (old.via || []).length } : null,
          to: { base: shelterInSnap(next, b.shelterId)?.name, distance: n.distance, minutes: n.minutes, via: (b.via || []).length },
          kind: (b.via || []).length ? '绕行路线' : '直达路线'
        })
      }
    }
  })
  if (prev) {
    prev.tr.batches.forEach((b) => {
      if (!batchInSnap(next, b.id)) statusChanges.push({ icon: '🗑', color: CATEGORY_META.transfer.color, text: `批次记录移除：${batchName(prev, b)}` })
    })
  }

  /* 阻断 */
  next.rb.blocks.forEach((blk) => {
    const old = prev ? blockInSnap(prev, blk.id) : null
    if (!old) statusChanges.push({ icon: '🚧', color: CATEGORY_META.block.color, text: `新增道路阻断：${blk.name}（封闭区 ${blk.polygon.length} 顶点）` })
    else if (old.status !== blk.status) {
      statusChanges.push({ icon: '✅', color: CATEGORY_META.block.color, text: `道路阻断「${blk.name}」：封闭中 → 已恢复通行` })
    }
  })

  /* 抢修工单 */
  next.ro.orders.forEach((o) => {
    const old = prev ? orderInSnap(prev, o.id) : null
    if (!old) statusChanges.push({ icon: '🔧', color: CATEGORY_META.repair.color, text: `新增抢修工单：${o.blockName}（${o.baseName}，队伍 ${o.personnel} 人/车辆 ${o.vehicles} 辆）` })
    else {
      if (old.status !== o.status) {
        statusChanges.push({ icon: '🔁', color: CATEGORY_META.repair.color, text: `抢修工单「${o.blockName}」：${repairStatusLabel(old.status)} → ${repairStatusLabel(o.status)}` })
      }
      if (old.progress !== o.progress) {
        statusChanges.push({ icon: '📍', color: CATEGORY_META.repair.color, text: `抢修工单「${o.blockName}」进度：${old.progress}% → ${o.progress}%` })
      }
    }
  })

  /* 资源占用：各基地各类型库存增减 */
  next.cmd.bases.forEach((b) => {
    const old = prev ? baseInSnap(prev, b.id) : null
    Object.keys(b.stock).forEach((type) => {
      const nv = b.stock[type] || 0
      const ov = old ? old.stock[type] || 0 : nv
      if (ov !== nv) {
        stocks.push({
          base: b.name,
          type: RESOURCE_TYPES[type]?.label || type,
          unit: RESOURCE_TYPES[type]?.unit || '',
          from: ov, to: nv, delta: nv - ov
        })
      }
    })
  })

  /* 安置点占用：在住人数（快照内按批次实时汇总） */
  next.tr.shelters.forEach((s) => {
    const countIn = (snap) => snap.tr.batches
      .filter((b) => b.shelterId === s.id)
      .reduce((n, b) => n + b.members.filter((m) => m.checkinAt && !m.checkoutAt).length, 0)
    const nv = countIn(next)
    const ov = prev ? countIn(prev) : nv
    if (ov !== nv) occupancy.push({ shelter: s.name, capacity: s.capacity, from: ov, to: nv, delta: nv - ov })
  })

  /* 结算日 */
  if (prev && prev.tr.settleDay !== next.tr.settleDay) {
    statusChanges.push({ icon: '🌙', color: CATEGORY_META.supply.color, text: `补给结算日：第 ${prev.tr.settleDay} 日 → 第 ${next.tr.settleDay} 日` })
  }

  counters.events = next.cmd.events.length
  counters.dispatches = next.cmd.dispatches.length
  counters.batches = next.tr.batches.length
  counters.blocks = next.rb.blocks.filter((b) => b.status === 'active').length
  counters.orders = next.ro.orders.length
  counters.settleDay = next.tr.settleDay

  return { statusChanges, routes, stocks, occupancy, counters }
}

// 基线帧（无前序帧）：演练开始时的总体态势
function baselineOverview(snap) {
  const items = []
  snap.cmd.events.forEach((ev) => {
    items.push({ icon: EVENT_TYPES[ev.type]?.icon || '🚨', color: '#ff9800', text: `${ev.title}（${eventStatusLabel(ev.status)}，影响 ${ev.affected} 人）` })
  })
  snap.cmd.bases.forEach((b) => {
    items.push({ icon: '🏗️', color: '#2962ff', text: `${b.name} 待命` })
  })
  snap.tr.shelters.forEach((s) => {
    items.push({ icon: '🏕️', color: '#26a69a', text: `${s.name} 床位容量 ${s.capacity}` })
  })
  return items
}

/* ---------- action 包装器（录制 + 回放锁定） ---------- */

function makeWrapper(module, name, orig) {
  return function wrapped(...args) {
    const replay = useReplayStore()
    // 回放模式：演练只读，全部业务动作拦截（$patch 恢复快照不走 action，不受影响）
    if (replay.active && replay.mode === 'review') return null
    const outer = replay.active && replay.mode === 'live' && recordDepth === 0 && !JOURNAL_SKIP.has(name)
    recordDepth++
    let ret
    try {
      ret = orig.apply(this, args)
    } finally {
      recordDepth--
    }
    if (outer) replay.recordFrame(module, name, args)
    return ret
  }
}

function wrapStore(store, module) {
  Object.keys(store).forEach((key) => {
    // 跳过内部「_」方法与 pinia 内置「$」成员（$patch/$subscribe 等）
    if (key.startsWith('_') || key.startsWith('$') || JOURNAL_SKIP.has(key)) return
    const desc = Object.getOwnPropertyDescriptor(store, key)
    if (!desc || !('value' in desc) || typeof desc.value !== 'function') return
    store[key] = makeWrapper(module, key, desc.value)
  })
}

// 在四个业务 store 创建后安装一次（幂等）；main.js 与测试入口调用
export function installReplayRecorder() {
  const pinia = getActivePinia()
  if (!pinia || pinia.__replayRecorderInstalled) return
  pinia.__replayRecorderInstalled = true
  wrapStore(useCommandStore(), 'cmd')
  wrapStore(useTransferStore(), 'tr')
  wrapStore(useRoadblockStore(), 'rb')
  wrapStore(useRepairStore(), 'ro')
}

let playTimer = null

export const useReplayStore = defineStore('replay', {
  state: () => ({
    active: false,          // 录制器已开始（begin 后为 true）
    mode: 'live',           // live 演练录制中 / review 复盘回放只读
    panelOpen: false,
    frames: [],             // 帧序列（每帧含全量快照）
    seq: 0,
    cursor: 0,              // 回放当前帧下标
    playing: false,
    speed: 1,
    filterCat: 'all',
    capReached: false,
    testClock: null         // 测试用：固定帧时间戳（ms）
  }),

  getters: {
    // 当前关注帧：复盘回放取游标帧；live 演练中始终为最新帧
    currentFrame(state) {
      const i = state.mode === 'review' ? state.cursor : state.frames.length - 1
      return state.frames[i] || null
    },
    frameCount(state) { return state.frames.length },
    atLastFrame(state) { return state.cursor >= state.frames.length - 1 },
    categoryMeta: () => CATEGORY_META,
    visibleFrames(state) {
      const list = state.frames.map((f, i) => ({ ...f, index: i }))
      return state.filterCat === 'all' ? list : list.filter((f) => f.category === state.filterCat)
    },
    // 当前帧相对前一帧的差异（详情四维度）
    currentDiff() {
      const f = this.currentFrame
      if (!f) return null
      const i = this.frames.indexOf(f)
      const prev = this.frames[i - 1]
      return diffSnapshots(prev?.snapshot || null, f.snapshot)
    },
    currentLogs() {
      return this.currentFrame?.logs || []
    },
    baselineItems() {
      const f = this.currentFrame
      return f?.seq === 0 ? baselineOverview(f.snapshot) : []
    }
  },

  actions: {
    // 演示/测试：固定帧时间戳
    setTestClock(ms) { this.testClock = ms == null ? null : Number(ms) },

    // 开始/重置录制：以当前态势作为基线帧（场景载入完成后调用）
    begin() {
      this._stopTimer()
      this.active = true
      this.mode = 'live'
      this.frames = []
      this.seq = 0
      this.cursor = 0
      this.playing = false
      this.capReached = false
      this._pushBaseline()
    },

    _pushBaseline() {
      const snap = takeSnapshot()
      this.frames.push({
        seq: 0,
        t: this._nowMs(),
        at: timeLabel(this._nowMs()),
        module: 'system', action: 'begin', category: 'system',
        title: '演练开始 · 场景载入',
        args: null,
        logs: [],
        snapshot: snap,
        fork: false
      })
    },

    _nowMs() {
      if (this.testClock != null) return this.testClock + this.seq * 1000
      return Date.now()
    },

    // 业务动作执行后沉淀一帧（状态无变化的空动作/校验拦截不记录）
    recordFrame(module, action, args) {
      if (this.mode !== 'live' || !this.active) return
      if (this.frames.length >= FRAME_CAP) { this.capReached = true; return }
      const snap = takeSnapshot()
      const prev = this.frames[this.frames.length - 1]
      // 与上一帧态势完全相同（动作被业务校验拦截、未产生任何变化）→ 不入时间轴
      if (prev && JSON.stringify(snap) === JSON.stringify(prev.snapshot)) return
      this.seq += 1
      const { category, title } = describeFrame(module, action, args, snap)
      const t = this._nowMs()
      this.frames.push({
        seq: this.seq,
        t,
        at: timeLabel(t),
        module, action, category, title,
        args: clone(args),
        logs: collectLogs(snap, prev?.snapshot || null),
        snapshot: snap,
        fork: false
      })
    },

    /* ---------- 面板 ---------- */
    openPanel() { this.panelOpen = true },
    closePanel() { this.panelOpen = false; this.pause() },
    setFilter(cat) { this.filterCat = cat },
    setSpeed(s) { this.speed = s; if (this.playing) { this._stopTimer(); this._startTimer() } },

    /* ---------- 回放 ---------- */
    enterReview(index = null) {
      if (!this.frames.length) return
      this.mode = 'review'
      this.panelOpen = true
      this.pause()
      const i = index == null ? this.frames.length - 1 : index
      this.seek(i)
    },
    seek(i) {
      if (!this.frames.length) return
      this.cursor = Math.max(0, Math.min(this.frames.length - 1, i))
      this._restore(this.frames[this.cursor].snapshot)
    },
    next() { if (this.cursor < this.frames.length - 1) this.seek(this.cursor + 1) },
    prev() { if (this.cursor > 0) this.seek(this.cursor - 1) },
    first() { this.seek(0) },
    last() { this.seek(this.frames.length - 1) },

    play() {
      if (this.mode !== 'review' || this.playing) return
      this.playing = true
      if (this.atLastFrame) this.seek(0) // 到尾后再次播放：从头开始
      this._startTimer()
    },
    _startTimer() {
      this._stopTimer()
      playTimer = setInterval(() => {
        if (this.cursor >= this.frames.length - 1) { this.pause(); return }
        this.next()
      }, PLAY_INTERVAL[this.speed] || PLAY_INTERVAL[1])
    },
    pause() {
      this.playing = false
      this._stopTimer()
    },
    _stopTimer() {
      if (playTimer) { clearInterval(playTimer); playTimer = null }
    },

    // 从当前节点恢复演练：截断后续历史形成分叉分支，回到可操作的 live 态势
    resumeHere() {
      const node = this.frames[this.cursor]
      if (!node) return
      this.pause()
      const kept = this.frames.slice(0, this.cursor + 1)
      kept[kept.length - 1] = { ...node, fork: true }
      this.frames = kept
      this._restore(node.snapshot)
      this.mode = 'live'
      this.playing = false
      this.panelOpen = false
    },

    // 退出回放：回到「当前」（最后一帧）态势继续演练，保留完整历史
    exitToLive() {
      this.pause()
      const last = this.frames[this.frames.length - 1]
      if (last) {
        this.cursor = this.frames.length - 1
        this._restore(last.snapshot)
      }
      this.mode = 'live'
      this.panelOpen = false
    },

    // 快照整体替换四 store 态势（地图/面板经响应式 watch 自动重绘）
    _restore(snap) {
      const cmd = useCommandStore()
      const tr = useTransferStore()
      const rb = useRoadblockStore()
      const ro = useRepairStore()
      if (cmd.autoPlay) {
        cmd.autoPlay = false
        clearInterval(cmd.replayTimer)
        cmd.replayTimer = null
      }
      // 直接赋值替换（reactive 数组/对象替换同样触发响应式更新；
      // 不走 $patch 是为了规避本模块对业务 store action 的包装链）
      cmd.events = clone(snap.cmd.events)
      cmd.bases = clone(snap.cmd.bases)
      cmd.dispatches = clone(snap.cmd.dispatches)
      cmd.plan = clone(snap.cmd.plan)
      cmd.planResult = clone(snap.cmd.planResult)
      cmd.selectedEventId = snap.cmd.selectedEventId
      cmd.filter = clone(snap.cmd.filter)
      cmd.search = snap.cmd.search

      tr.shelters = clone(snap.tr.shelters)
      tr.batches = clone(snap.tr.batches)
      tr.settleDay = snap.tr.settleDay
      tr.clock = snap.tr.clock

      rb.blocks = clone(snap.rb.blocks)
      rb.drawing = false
      rb.draft = []
      rb.reporting = false
      rb.selectedBlockId = snap.rb.selectedBlockId

      ro.orders = clone(snap.ro.orders)
      ro.assigningBlockId = null
      ro.focusOrderId = snap.ro.focusOrderId
      ro.clock = snap.ro.clock
    }
  }
})
