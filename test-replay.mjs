// 历史复盘：业务动作自动记账（级联合并/无效动作不记账）→ 按节点回放状态/路线/资源/日志
// → 显式分支与直接操作自动分支恢复演练 → 播放/步进 → 场景切换重置
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useReplayStore } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const rp = useRepairStore()
const replay = useReplayStore()
replay.init()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const last = () => replay.journal[replay.journal.length - 1]
const dp = (id) => cmd.dispatches.find((d) => d.id === id)
const ev1 = () => cmd.events.find((e) => e.id === 'ev-001')
const rb2 = () => cmd.bases.find((b) => b.id === 'rb-2')

cmd.loadScenario('s1')
tr.load(); rb.load(); rp.load()
await tick()

console.log('— 自动记账：初始节点与级联合并 —')
assert(replay.journal.length === 1, '载入场景产生初始复盘节点')
assert(replay.journal[0].kind === 'system' && replay.journal[0].label.includes('载入'), '初始节点为场景载入')
assert(replay.journal[0].summary[0].includes('初始'), '初始节点摘要为演练初始状态')
assert(replay.cursor === null && !replay.replaying, '初始为实时视角')

const food0 = rb2().stock.food
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100 })
await tick()
assert(replay.journal.length === 2, '手动派发产生复盘节点')
assert(last().kind === 'dispatch' && last().label.includes('手动派发'), '派发节点类型与标题正确')
assert(last().summary.some((s) => s.includes('资源占用') && s.includes('绵阳')), '摘要含资源占用变化')
assert(last().summary.some((s) => s.includes('新增派发')), '摘要含新增派发')

console.log('— 无效动作不记账 —')
const bad = cmd.signDispatch(rec.id, { qty: 0, shortQty: 0 })
await tick()
assert(!bad.ok && replay.journal.length === 2, '校验拦截的签收不产生复盘节点')

console.log('— 签收 / 转移 / 阻断 / 抢修全量记账 —')
cmd.signDispatch(rec.id, { qty: 40, receiver: '李四' })
await tick()
assert(replay.journal.length === 3, '签收产生复盘节点')
assert(last().summary.some((s) => s.includes('处置日志')), '签收节点摘要含处置日志增量')

const bt = tr.createBatch({ eventId: 'ev-001', name: '第一批', headcount: 10, vehicleBaseId: 'rb-1', vehicleCount: 2, shelterId: 'sh-1' })
await tick()
assert(replay.journal.length === 4 && last().kind === 'transfer', '建批产生转移类节点')
assert(last().summary.some((s) => s.includes('新增转移批次')), '建批摘要含新增批次')

// 绵阳库 → 江油走廊上的阻断区
const midPoly = [
  [104.6438, 31.5209], [104.8438, 31.5209],
  [104.8438, 31.7209], [104.6438, 31.7209]
]
const blk = rb.reportBlock({ name: '绵江公路塌方断道', polygon: midPoly }).block
await tick()
assert(replay.journal.length === 5 && last().kind === 'block', '阻断上报产生阻断类节点')
assert(last().summary.some((s) => s.includes('新增阻断')), '阻断摘要含新增阻断')

rb.confirmImpacts(blk.id)
await tick()
assert(replay.journal.length === 6, '确认影响产生复盘节点')
const imp = blk.impacts.find((i) => i.id === rec.id)
imp.plan = imp.options.find((o) => o.action === 'detour')
rb.applyImpact(blk.id, imp.key)
await tick()
assert(replay.journal.length === 7, '执行处置方案产生复盘节点')
assert(last().summary.some((s) => s.includes('路线调整')), '绕行节点摘要含路线调整')
assert(dp(rec.id).via.length > 0, '派发已绕行')

rp.createOrder({ blockId: blk.id, baseId: 'rb-1', personnel: 6, vehicles: 1 })
await tick()
assert(replay.journal.length === 8 && last().kind === 'repair', '抢修派单产生抢修类节点')
assert(last().summary.some((s) => s.includes('新增抢修工单')), '抢修摘要含新增工单')

console.log('— 时间轴回放：状态 / 路线 / 资源 / 日志同步还原 —')
const live = {
  viaLen: dp(rec.id).via.length,
  orders: rp.orders.length,
  timeline: ev1().timeline.length
}
replay.viewEntry(0)
assert(replay.cursor === 0 && replay.replaying, '定位到初始节点进入复盘视角')
assert(cmd.dispatches.length === 0 && tr.batches.length === 0, '初始节点：无派发无批次')
assert(rb.blocks.length === 0 && rp.orders.length === 0, '初始节点：无阻断无工单')
assert(rb2().stock.food === food0, '初始节点：库存占用还原')
assert(ev1().timeline.length === 1, '初始节点：处置日志还原（仅上报记录）')

replay.viewEntry(2)
assert(dp(rec.id).signedQty === 40, '签收节点：实收 40 已入账')
assert(tr.batches.length === 0, '签收节点：批次尚未创建')

replay.viewEntry(6)
assert(dp(rec.id).via.length === live.viaLen, '绕行节点：路线途经点还原')
assert(rb.blocks.length === 1 && rp.orders.length === 0, '绕行节点：阻断已上报、工单未发起')

replay.backToLive()
assert(replay.cursor === null, '返回实时退出复盘视角')
assert(rp.orders.length === live.orders && rb.blocks.length === 1, '实时态势恢复工单与阻断')
assert(ev1().timeline.length === live.timeline, '实时态势恢复处置日志')

console.log('— 步进导航 —')
replay.viewEntry(0)
replay.step(1)
assert(replay.cursor === 1, '步进到下一节点')
replay.step(-1)
assert(replay.cursor === 0, '步退回上一节点')
replay.viewEntry(replay.journal.length - 2)
replay.step(1)
assert(replay.cursor === null, '越过最新节点自动回到实时')

console.log('— 显式分支：从任意节点恢复演练 —')
replay.viewEntry(2) // 签收后、建批前
replay.fork()
assert(replay.cursor === null, '分支后回到实时视角')
assert(replay.journal.length === 4, '后续节点已截断并追加分支标记')
assert(last().forked && last().label.includes('恢复演练'), '分支标记节点留痕')
assert(tr.batches.length === 0 && rb.blocks.length === 0, '分支点之后的批次与阻断不再存在')
const rec2 = cmd.dispatchResource({ baseId: 'rb-1', eventId: 'ev-001', type: 'water', qty: 50 })
await tick()
assert(replay.journal.length === 5 && last().kind === 'dispatch', '分支后继续记账')
assert(cmd.dispatches.length === 2, '演练自分支点继续：原派发保留 + 新派发')

console.log('— 自动分支：历史节点上直接操作 —')
replay.viewEntry(1) // 派发后、签收前
const rec3 = cmd.dispatchResource({ baseId: 'rb-2', eventId: 'ev-001', type: 'tent', qty: 10 })
await tick()
assert(replay.cursor === null, '业务操作自动退出复盘视角')
assert(replay.journal.length === 3, '自动分支截断后续节点')
assert(last().forked === true, '自动分支节点带分支标记')
assert(dp(rec.id).signedQty === 0, '分支点之后的签收已被截断')
assert(cmd.dispatches.length === 2, '分支点状态 + 新派发')

console.log('— 播放：自动逐节点回放，播完回到实时 —')
replay.viewEntry(0)
replay.setSpeed(4)
replay.play()
assert(replay.playing, '进入播放状态')
await sleep(1200)
assert(replay.cursor === null && !replay.playing, '播放到最新节点自动回到实时')

console.log('— 场景切换：复盘日志重置 —')
cmd.loadScenario('s2')
tr.load(); rb.load(); rp.load()
await tick()
assert(replay.journal.length === 1, '切换场景后重新记账')
assert(replay.journal[0].state.command.scenarioId === 's2', '初始节点对应当前场景')

console.log('— 统筹批量派发：级联动作合并为单节点 —')
cmd.generatePlan()
await tick()
const n1 = replay.journal.length
cmd.submitPlan()
await tick()
assert(replay.journal.length === n1 + 1, '批量派发合并为一个复盘节点')
assert(last().label.includes('统筹'), '批量派发节点标题为统筹方案')
assert(cmd.dispatches.length > 0, '批量派发已生成派发记录')

console.log('— 事件状态流转节点与回放 —')
cmd.advanceStatus('ev-101', 'controlled')
await tick()
assert(last().kind === 'event', '状态流转产生事件类节点')
assert(last().summary.some((s) => s.includes('已控制')), '摘要含状态变化')
replay.viewEntry(replay.journal.length - 2)
assert(cmd.events.find((e) => e.id === 'ev-101').status === 'dispatching', '回放撤销状态流转')
replay.backToLive()
assert(cmd.events.find((e) => e.id === 'ev-101').status === 'controlled', '返回实时恢复状态')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
