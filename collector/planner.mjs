// 出车规划：把待调听窗口翻译成「从哪个终端、领哪份原件的哪些帧」。
//
// 核心业务规则（对应任务约束）：
//  1. 只有同一设备、同一启动(boot)、同一份原件(file)的交叠范围才可共用领取；
//     相邻时间窗落在不同原件、或只是听起来相似，都不能合成一份。
//  2. 有限字节优先用于还可能满足高优先窗口的原始片段（priority 数值越大越优先）。
//  3. 对时尚不能确定归属，但原件会在下次出车前过期、且仍可能落入高优先窗口时，
//     允许先保全并注明「待判」；补锚后按能证实的范围推进，未确定部分不冒充已交付。
//  4. 现场没录到(gap)、取件掉线(offline)、留存覆盖(retention) 三态分开记账。
//  5. 缺样或没有原件时，绝不用填充音表示已采到。

import { normalize, intersect, subtract, totalLength } from './intervals.mjs'
import { overlapFrames } from './clock.mjs'
import { missingFrames, sessionKey } from './store.mjs'

const HIGH_PRIORITY_DEFAULT = 1

// 原件当前真实存在的连续帧区间（slices 缺号即来源明确没有该段）。
export function availableFrames(session) {
  return normalize(session.slices ?? [[0, session.samples]])
}

// 来源明确缺样的帧区间：原件帧域内、slices 之外。
export function sourceGapFrames(session) {
  return subtract([[0, session.samples]], availableFrames(session))
}

function originId(session) {
  return `${session.device}|${session.boot}|${session.file}`
}

// 为每个窗口 × 每份原件计算交叠，区分可证实与待判。
export function buildDemands({ windows, sessions, clocks, store, highPriority = HIGH_PRIORITY_DEFAULT }) {
  const demands = []
  for (const window of windows) {
    for (const session of sessions) {
      const key = sessionKey(session)
      const clock = clocks.find(c => c.device === session.device && c.boot === session.boot) ?? null
      const overlap = overlapFrames(session, clock, window.reference)
      const availability = availableFrames(session)
      const gaps = sourceGapFrames(session)

      if (overlap === null) {
        // 没有任何可用对时锚：只能凭 acquisitionHint 判定是否值得「待判保全」。
        const hint = session.acquisitionHint
        const mayMatchHint = hint &&
          hint.mayFallInReference[1] > window.reference[0] &&
          hint.mayFallInReference[0] < window.reference[1]
        if (!mayMatchHint) continue
        const possible = intersect(availability, [[0, session.samples]])
        if (!possible.length) continue
        demands.push({
          windowId: window.id,
          priority: window.priority,
          key,
          origin: originId(session),
          session,
          provable: [],
          possible,
          pending: true,
          reason: '对时锚未发布，按 acquisitionHint 待判保全',
          retainThroughTrip: hint?.retainThroughTrip ?? null,
          gaps: intersect(gaps, possible),
        })
        continue
      }

      const provable = intersect(overlap.provable, availability)
      const possible = intersect(overlap.possible, availability)
      if (!provable.length && !possible.length) continue
      demands.push({
        windowId: window.id,
        priority: window.priority,
        key,
        origin: originId(session),
        session,
        provable,
        possible,
        pending: false,
        reason: clock ? `按对时修订 ${clock.revision} 判定` : '无对时记录',
        retainThroughTrip: session.acquisitionHint?.retainThroughTrip ?? null,
        gaps: intersect(gaps, normalize([...overlap.provable, ...overlap.possible])),
      })
    }
  }
  return demands
}

// 待判保全：对时锚缺失，但原件在下次出车前过期且可能落入高优先窗口。
export function pendingPreservations({ demands, currentTrip, highPriority = HIGH_PRIORITY_DEFAULT }) {
  return demands.filter(d =>
    d.pending &&
    d.priority >= highPriority &&
    d.retainThroughTrip !== null &&
    d.retainThroughTrip <= currentTrip + 1)
}

// 把多个窗口对同一原件的需求合并成一份领取计划（仅同 origin 才允许合并）。
export function mergeByOrigin(demands) {
  const map = new Map()
  for (const demand of demands) {
    if (!map.has(demand.origin)) {
      map.set(demand.origin, {
        origin: demand.origin,
        key: demand.key,
        session: demand.session,
        provable: [],
        possible: [],
        pending: demand.pending,
        windowLinks: [],
        maxPriority: -Infinity,
      })
    }
    const plan = map.get(demand.origin)
    plan.provable.push(...demand.provable)
    plan.possible.push(...demand.possible)
    plan.pending = plan.pending && demand.pending
    plan.maxPriority = Math.max(plan.maxPriority, demand.priority)
    plan.windowLinks.push({
      windowId: demand.windowId,
      priority: demand.priority,
      provable: demand.provable,
      possible: demand.possible,
      pending: demand.pending,
    })
  }
  for (const plan of map.values()) {
    plan.provable = normalize(plan.provable)
    plan.possible = normalize(plan.possible)
    // 待判帧与可证实帧可能重合；已经能证实的部分不再标待判。
    plan.pendingFrames = subtract(plan.possible, plan.provable)
    plan.allWanted = normalize([...plan.provable, ...plan.possible])
  }
  return [...map.values()]
}

// 预算分配：先高优先级、先可证实、再待判可能；同一原件的字节只领一次，多窗口共用。
// 返回每个终端的有序领取动作（帧区间 + 字节区间 + 服务于哪些窗口）。
export function allocateBudget({ plans, terminals, store }) {
  const byDevice = new Map()
  for (const terminal of terminals) byDevice.set(terminal.device, { ...terminal, spent: 0, actions: [] })

  const ordered = plans.slice().sort((a, b) => {
    if (b.maxPriority !== a.maxPriority) return b.maxPriority - a.maxPriority
    if (a.pending !== b.pending) return a.pending ? 1 : -1 // 能证实的先于待判
    return a.key.localeCompare(b.key)
  })

  const decisions = []
  for (const plan of ordered) {
    const terminal = byDevice.get(plan.session.device)
    if (!terminal) {
      decisions.push({ plan, status: 'no-terminal', actions: [] })
      continue
    }
    if (!terminal.online) {
      decisions.push({ plan, status: 'offline', actions: [] })
      continue
    }

    const wanted = normalize([...plan.provable, ...plan.possible])
    const need = missingFrames(store, plan.key, wanted)
    // 已被来源宣告缺样的帧不进入领取动作。
    const fetchable = subtract(need, sourceGapFrames(plan.session))
    const actions = []
    let blockedByBudget = false

    for (const range of fetchable) {
      const [left, right] = range
      for (let cursor = left; cursor < right;) {
        const frameBytes = 2
        const remainingBudget = terminal.budget - terminal.spent
        const framesAffordable = Math.floor(remainingBudget / frameBytes)
        if (framesAffordable <= 0) {
          blockedByBudget = true
          break
        }
        const take = Math.min(right - cursor, framesAffordable)
        const frameRange = [cursor, cursor + take]
        actions.push({
          key: plan.key,
          file: plan.session.file,
          device: plan.session.device,
          frames: frameRange,
          bytes: [frameRange[0] * 2, frameRange[1] * 2 - 1],
          serves: plan.windowLinks
            .filter(link => intersect(normalize([...link.provable, ...link.possible]), [frameRange]).length)
            .map(link => ({
              windowId: link.windowId,
              kind: intersect(link.provable, [frameRange]).length ? 'provable' : 'possible',
            })),
          provisional: !intersect(plan.provable, [frameRange]).length,
        })
        terminal.spent += take * frameBytes
        cursor += take
      }
      if (blockedByBudget) break
    }

    terminal.actions.push(...actions)
    decisions.push({
      plan,
      status: blockedByBudget ? 'partial-budget' : 'planned',
      actions,
      unfetched: subtract(fetchable, actions.map(a => a.frames)),
    })
  }
  return { terminals: [...byDevice.values()], decisions }
}

// 窗口级结项报告：可证实部分、待判部分、缺样、掉线、留存覆盖、已由历史交付满足。
//
// satisfied 的语义：所有「可证实」需求要么已持有，要么已被来源宣告为不可恢复
// （明确缺样 gap / 留存覆盖 retention）。仍可重试的掉线(offline)或预算未取，
// 意味着下一次出车还有机会，窗口不能结项。
export function windowReport({ windows, plans, store, observations }) {
  const reports = []
  for (const window of windows) {
    const linked = plans.filter(p => p.windowLinks.some(link => link.windowId === window.id))
    const parts = []
    for (const plan of linked) {
      const link = plan.windowLinks.find(l => l.windowId === window.id)
      const held = store.heldFrames(plan.key)
      const provableHeld = intersect(link.provable, held)
      const possibleHeld = intersect(link.possible, held)
      const wantedAll = normalize([...link.provable, ...link.possible])
      const gaps = intersect(wantedAll, sourceGapFrames(plan.session))
      const marks = (observations.get(plan.key) ?? [])
        .filter(item => intersect([item.frames], wantedAll).length)
      const provableMissing = subtract(link.provable, provableHeld)
      const missingMarks = marks.filter(m => intersect([m.frames], provableMissing).length)
      const retryable = missingMarks.some(m => m.status === 'offline') ||
        (provableMissing.length > 0 && missingMarks.length === 0)
      const unrecoverable = missingMarks.some(m => m.status === 'retention') ||
        intersect(provableMissing, sourceGapFrames(plan.session)).length > 0
      parts.push({
        key: plan.key,
        provableWanted: link.provable,
        possibleWanted: link.possible,
        provableHeld,
        possibleHeld,
        pending: link.pending,
        provableMissing,
        sourceGaps: gaps,
        retryable,
        unrecoverable,
        observations: marks.map(m => ({ frames: m.frames, status: m.status })),
      })
    }
    const satisfied = parts.length > 0 && parts.every(part =>
      totalLength(part.provableMissing) === 0 ||
      (!part.retryable && part.unrecoverable))
    const blocking = parts
      .filter(part => part.retryable)
      .map(part => ({ key: part.key, missing: part.provableMissing, reason: 'offline-or-pending-budget' }))
    reports.push({
      windowId: window.id,
      priority: window.priority,
      satisfied,
      blocking,
      parts,
    })
  }
  return reports
}
