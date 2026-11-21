// 设备 tick 与调查站参考时钟（毫秒整数）之间的换算。
//
// 资料源约定（见 README）：
//   anchors 每项为 [tick, 参考时钟, 最大误差]；
//   anchor 之间名义时钟线性变化，maxError 给出本段额外误差，区间外没有可信换算。
//
// 本模块只做有依据的换算：超出 anchor 覆盖域的样本一律不给可证实归属。

function assertAnchors(anchors) {
  if (!Array.isArray(anchors) || anchors.length < 2) {
    throw new Error('对时记录至少需要两个 anchor')
  }
  for (let i = 1; i < anchors.length; i += 1) {
    if (anchors[i][0] <= anchors[i - 1][0]) throw new Error('anchor 的 tick 必须严格递增')
  }
}

function locateSegment(anchors, tick) {
  for (let i = 0; i + 1 < anchors.length; i += 1) {
    const [tickLeft] = anchors[i]
    const [tickRight] = anchors[i + 1]
    if (tick >= tickLeft && tick <= tickRight) return i
  }
  return -1
}

// 线性插值名义参考时钟；额外误差在两段 anchor 误差之间线性变化，再叠加本段 maxError。
function nominalAndError(clock, tick) {
  const { anchors, maxError = 0 } = clock
  const i = locateSegment(anchors, tick)
  if (i < 0) return null
  const [tickLeft, refLeft, errLeft] = anchors[i]
  const [tickRight, refRight, errRight] = anchors[i + 1]
  const ratio = (tick - tickLeft) / (tickRight - tickLeft)
  const nominal = refLeft + (refRight - refLeft) * ratio
  const anchorError = errLeft + (errRight - errLeft) * ratio
  return { nominal, error: anchorError + maxError }
}

export function clockDomain(clock) {
  assertAnchors(clock.anchors)
  const first = clock.anchors[0][0]
  const last = clock.anchors[clock.anchors.length - 1][0]
  return [first, last]
}

// tick -> 参考时钟的不确定区间 [nominal-error, nominal+error]（毫秒，向外取整保持保守）。
export function tickToReferenceBounds(clock, tick) {
  const point = nominalAndError(clock, tick)
  if (!point) return null
  return [Math.floor(point.nominal - point.error), Math.ceil(point.nominal + point.error)]
}

// 参考时钟点 -> tick 的不确定区间；同样只在 anchor 覆盖域内有效。
export function referenceToTickBounds(clock, reference) {
  const { anchors, maxError = 0 } = clock
  for (let i = 0; i + 1 < anchors.length; i += 1) {
    const [tickLeft, refLeft, errLeft] = anchors[i]
    const [tickRight, refRight, errRight] = anchors[i + 1]
    // 先放宽到本段可能出现的参考时钟范围。
    const low = Math.min(refLeft - errLeft, refRight - errRight) - maxError
    const high = Math.max(refLeft + errLeft, refRight + errRight) + maxError
    if (reference < low || reference > high) continue
    const slope = (refRight - refLeft) / (tickRight - tickLeft)
    const nominalTick = tickLeft + (reference - refLeft) / slope
    const errTickLeft = (errLeft + maxError) / Math.abs(slope)
    const errTickRight = (errRight + maxError) / Math.abs(slope)
    const errorTick = errTickLeft + (errTickRight - errTickLeft) *
      ((nominalTick - tickLeft) / (tickRight - tickLeft))
    return [Math.floor(nominalTick - errorTick), Math.ceil(nominalTick + errorTick)]
  }
  return null
}

// 会话原件的 tick 覆盖域（tickAtStart 为首样本 tick；帧号从 0 开始）。
export function sessionTickDomain(session) {
  return [session.tickAtStart, session.tickAtStart + session.samples]
}

function frameAtTick(session, tick) {
  // 样本 i 对应 tick = tickAtStart + i（每样本一个 tick 单位）。
  return tick - session.tickAtStart
}

// 窗口与一份会话原件的交叠判定，返回帧区间。
//   provable: 仅凭对时误差边界就能证实落在窗口内的帧（可按已证实范围推进）
//   possible: 误差边界可能跨入窗口、但尚不能证实的帧（未确定部分不得冒充已交付）
// 没有可用对时记录时返回 null，交由待判保全规则处理。
export function overlapFrames(session, clock, window) {
  if (!clock) return null
  const [winLeft, winRight] = window
  const [tickLeft, tickRight] = sessionTickDomain(session)
  const [domainLeft, domainRight] = clockDomain(clock)
  const usableTickLeft = Math.max(tickLeft, domainLeft)
  const usableTickRight = Math.min(tickRight, domainRight)
  if (usableTickRight <= usableTickLeft) return { provable: [], possible: [] }

  const provable = []
  const possible = []
  for (let tick = Math.floor(usableTickLeft); tick < Math.ceil(usableTickRight); tick += 1) {
    const bounds = tickToReferenceBounds(clock, tick)
    if (!bounds) continue
    const [bLeft, bRight] = bounds
    const frame = frameAtTick(session, tick)
    if (frame < 0 || frame >= session.samples) continue
    if (bLeft >= winLeft && bRight <= winRight) provable.push([frame, frame + 1])
    else if (bRight > winLeft && bLeft < winRight) possible.push([frame, frame + 1])
  }
  return {
    provable: mergeFrames(provable),
    possible: mergeFrames(possible),
  }
}

function mergeFrames(ranges) {
  if (!ranges.length) return []
  const sorted = ranges.map(([left, right]) => [left, right]).sort((a, b) => a[0] - b[0])
  const merged = [sorted[0].slice()]
  for (const [left, right] of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (left <= last[1]) last[1] = Math.max(last[1], right)
    else merged.push([left, right])
  }
  return merged
}

// 参考窗口整体换算到 tick 边界（用于可能交叠的保守估计，单元测试用）。
export function windowTickBounds(clock, window) {
  const [left, right] = window
  const leftBounds = referenceToTickBounds(clock, left)
  const rightBounds = referenceToTickBounds(clock, right)
  if (!leftBounds || !rightBounds) return null
  return [Math.min(leftBounds[0], rightBounds[0]), Math.max(leftBounds[1], rightBounds[1])]
}
