// 整数半开区间 [left, right) 的集合运算。
// 录音帧、字节范围都用半开整数区间表示；区间始终保持排序、互不交叠、相邻即合并。

export function normalize(ranges) {
  const sorted = ranges
    .filter(([left, right]) => Number.isInteger(left) && Number.isInteger(right) && right > left)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [left, right] of sorted) {
    const last = merged[merged.length - 1]
    if (last && left <= last[1]) last[1] = Math.max(last[1], right)
    else merged.push([left, right])
  }
  return merged
}

export function intersect(ranges, otherRanges) {
  const result = []
  let i = 0
  let j = 0
  const a = normalize(ranges)
  const b = normalize(otherRanges)
  while (i < a.length && j < b.length) {
    const left = Math.max(a[i][0], b[j][0])
    const right = Math.min(a[i][1], b[j][1])
    if (right > left) result.push([left, right])
    if (a[i][1] < b[j][1]) i += 1
    else if (a[i][1] > b[j][1]) j += 1
    else {
      i += 1
      j += 1
    }
  }
  return result
}

export function subtract(ranges, removedRanges) {
  const result = []
  const removed = normalize(removedRanges)
  for (const [left, right] of normalize(ranges)) {
    let cursor = left
    for (const [rmLeft, rmRight] of removed) {
      if (rmRight <= cursor) continue
      if (rmLeft >= right) break
      if (rmLeft > cursor) result.push([cursor, Math.min(rmLeft, right)])
      cursor = Math.max(cursor, rmRight)
      if (cursor >= right) break
    }
    if (cursor < right) result.push([cursor, right])
  }
  return normalize(result)
}

export function totalLength(ranges) {
  return normalize(ranges).reduce((sum, [left, right]) => sum + (right - left), 0)
}

export function isEmpty(ranges) {
  return normalize(ranges).length === 0
}
