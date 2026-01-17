import React, { useState, useEffect, useMemo, useRef } from 'react'

/* =========================================================================================
 * CONFIGURATION & HELPERS
 * ========================================================================================= */

const VERSION = 'v2.2.3' // Tag editing & UI cleanup
const BUILTIN_TAGS = ['504', 'IEP', 'ELL', 'Gifted', 'Speech']

// Caches to speed up math calculations so the app doesn't freeze
const scoreCache = new Map()
const metersCache = new Map()

// Helper: Standardize text (remove special chars, lowercase) for easier matching
const normalizeString = (str) => {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

const WEIGHT_MAP = {
  'Low': 0.5,
  'Normal': 1.0,
  'High': 2.0,
  0.5: 'Low',
  1.0: 'Normal',
  2.0: 'High'
}

// Generates a map of A=1, B=2... Z=26 for converting letter grades
const LETTER_GRADE_MAP = (() => {
  const map = {}
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    map[letter] = i + 1
  }
  return map
})()

// Helper: Create a unique string signature for the current criteria settings
// This helps us know when to re-calculate scores.
function makeCriteriaSignature(criteria) {
  return criteria.map(c => `${c.label}:${c.weight}:${c.max}:${c.enabled}`).join('|')
}

/* =========================================================================================
 * MATH & SCORING LOGIC
 * ========================================================================================= */

// Calculate a single student's "Composite Score" based on weighted criteria
function getCompositeScore(studentsById, studentId, criteria, criteriaSig) {
  const cacheKey = studentId + '|' + criteriaSig
  const cached = scoreCache.get(cacheKey)
  if (cached !== undefined) return cached

    const student = studentsById.get(studentId)

    // Safety checks
    if (!student) { scoreCache.set(cacheKey, 0); return 0; }
    if (student.ignoreScores) { scoreCache.set(cacheKey, 0); return 0; }

    // Calculate weighted sum
    const totalScore = criteria.reduce((acc, crit) => {
      const rawValue = Number(student.criteria?.[crit.label]) || 0
      const weight = Number(crit.weight) || 0
      const maxScore = crit.max > 0 ? crit.max : 100 // Prevent division by zero

      // Normalize to 0-100 scale
      const normalizedScore = (rawValue / maxScore) * 100
      return acc + (normalizedScore * weight)
    }, 0)

    scoreCache.set(cacheKey, totalScore)
    return totalScore
}

function getAverageCriteriaScore(studentsById, allIds, criterionLabel) {
  const activeIds = allIds.filter(id => !studentsById.get(id)?.ignoreScores)
  if (activeIds.length === 0) return 0

    const totalScore = activeIds.reduce((sum, id) => {
      return sum + (Number(studentsById.get(id)?.criteria?.[criterionLabel]) || 0)
    }, 0)

    return totalScore / activeIds.length
}

function getStandardDeviation(studentsById, allIds, criterionLabel, mean) {
  const activeIds = allIds.filter(id => !studentsById.get(id)?.ignoreScores)
  if (activeIds.length <= 1) return 0

    const sumSqDiff = activeIds.reduce((acc, id) => {
      const val = Number(studentsById.get(id)?.criteria?.[criterionLabel]) || 0
      const diff = val - mean
      return acc + (diff * diff)
    }, 0)

    return Math.sqrt(sumSqDiff / activeIds.length)
}

// Calculate the stats (meters) for a specific class to see how balanced it is
function calculateClassMeters(classData, studentsById, criteria, allIds, criteriaSig) {
  const rosterSig = classData.studentIds.join(',')
  const cacheKey = `${classData.id}|${criteriaSig}|${rosterSig}`

  const cached = metersCache.get(cacheKey)
  if (cached) return cached

    const activeStudents = classData.studentIds.filter(id => !studentsById.get(id)?.ignoreScores)
    const studentCount = activeStudents.length
    const activeCriteria = criteria.filter(c => c.enabled)

    const meters = activeCriteria.map(crit => {
      let classAverage = 0

      if (studentCount > 0) {
        const totalScore = activeStudents.reduce((sum, id) => {
          return sum + (Number(studentsById.get(id)?.criteria?.[crit.label]) || 0)
        }, 0)
        classAverage = totalScore / studentCount
      }

      // Calculate Z-Score to determine color coding
      const globalAvg = getAverageCriteriaScore(studentsById, allIds, crit.label)
      const globalSD = getStandardDeviation(studentsById, allIds, crit.label, globalAvg)
      const zScore = globalSD === 0 ? 0 : (classAverage - globalAvg) / globalSD

      // Percentage for the progress bar
      const barPercent = Math.max(0, Math.min(100, (classAverage / (crit.max || 100)) * 100))

      // Determine Status Label & Color
      let colorClass = 'bg-emerald-500'
      let textColorClass = 'text-emerald-500'
      let labelText = 'Balanced'

    if (zScore > 0.5) {
      colorClass = 'bg-indigo-500'
      textColorClass = 'text-indigo-500'
      labelText = 'Above Avg'
    } else if (zScore < -1.0) {
      colorClass = 'bg-rose-500'
      textColorClass = 'text-rose-500'
      labelText = 'Far Below Avg'
    } else if (zScore < -0.5) {
      colorClass = 'bg-amber-500'
      textColorClass = 'text-amber-500'
      labelText = 'Below Avg'
    }

    return {
      label: crit.label,
      pct: barPercent,
      colorClass,
      textColorClass,
      avg: classAverage,
      labelText
    }
    })

    metersCache.set(cacheKey, meters)
    return meters
}

function getGenderStats(studentsById, studentIds) {
  let FemaleCount = 0
  let MaleCount = 0

  studentIds.forEach(id => {
    const gender = studentsById.get(id)?.gender
    if (gender === 'F') FemaleCount++
      else if (gender === 'M') MaleCount++
  })

  return { size: studentIds.length, F: FemaleCount, M: MaleCount }
}

/* =========================================================================================
 * BALANCING ALGORITHM
 * ========================================================================================= */

// Disjoint-Set (Union-Find) Helper
// Used to group students who must be kept together into single "Units"
const findRoot = (parentMap, x) => {
  while (parentMap.get(x) !== x) {
    parentMap.set(x, parentMap.get(parentMap.get(x))) // Path compression
    x = parentMap.get(x)
  }
  return x
}

const unionNodes = (parentMap, a, b) => {
  const rootA = findRoot(parentMap, a)
  const rootB = findRoot(parentMap, b)
  if (rootA !== rootB) parentMap.set(rootA, rootB)
}

// Logic to pick the best class for a student group, prioritizing averages then gender balance
function pickBestClassIndex(candidateIndexes, unitIds, classes, studentsById) {
  // If only one option, take it
  if (candidateIndexes.length === 1) return candidateIndexes[0]

    // Otherwise, break ties by looking at Gender Balance
    let bestIndex = candidateIndexes[0]
    let bestScore = Infinity

    for (const index of candidateIndexes) {
      const classRoster = classes[index].studentIds

      // Count current gender in class
      let M = 0, F = 0
      for (const id of classRoster) {
        const g = studentsById.get(id)?.gender
        if (g === 'M') M++; else if (g === 'F') F++
      }

      // Add incoming students' gender
      const incomingM = unitIds.filter(id => studentsById.get(id)?.gender === 'M').length
      const incomingF = unitIds.filter(id => studentsById.get(id)?.gender === 'F').length

      // Calculate Imbalance Score (Lower is better)
      const imbalance = Math.abs((M + incomingM) - (F + incomingF))

      if (imbalance < bestScore) {
        bestScore = imbalance
        bestIndex = index
      }
    }
    return bestIndex
}

function runAutoPlace(studentsById, allIds, numClasses, options) {
  const { criteria, keepTogetherPairs, keepApartPairs, classMeta } = options

  // 1. Initialize empty classes
  const classes = Array.from({ length: numClasses }, (_, i) => ({
    id: `Class ${i + 1}`,
    name: classMeta?.[i]?.name || `Class ${i + 1}`,
    studentIds: []
  }))

  // 2. Calculate capacity targets
  const baseTarget = Math.floor(allIds.length / numClasses)
  const remainder = allIds.length % numClasses
  const capacities = classes.map((_, i) => baseTarget + (i < remainder ? 1 : 0))

  // 3. Group "Keep Together" students into Units using Union-Find
  const parentMap = new Map(allIds.map(id => [id, id]))
  keepTogetherPairs.forEach(([a, b]) => {
    if (a && b) unionNodes(parentMap, a, b)
  })

  // Group IDs by their root parent
  const groups = new Map()
  allIds.forEach(id => {
    const root = findRoot(parentMap, id)
    if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(id)
  })

  // Convert groups to "Units" (some units are just 1 student, some are pairs/groups)
  const units = []
  for (const groupIds of groups.values()) {
    // Check if any student in this group is manually pinned to a specific class
    const pins = groupIds.map(id => studentsById.get(id)?.pinClass).filter(p => p !== null && p !== undefined)
    const uniquePins = [...new Set(pins)]

    if (uniquePins.length > 0) {
      // If pinned, the whole group goes to that class
      units.push({ ids: groupIds, targetClassIndex: uniquePins[0] })
    } else {
      // Free floating unit
      units.push({ ids: groupIds, targetClassIndex: null })
    }
  }

  // 4. Sort Units by "difficulty" (Average Score)
  const criteriaSig = makeCriteriaSignature(criteria)
  const getUnitAvg = (ids) => ids.reduce((acc, id) => acc + getCompositeScore(studentsById, id, criteria, criteriaSig), 0) / ids.length

  const pinnedUnits = units.filter(u => u.targetClassIndex !== null)
  const freeUnits = units.filter(u => u.targetClassIndex === null).sort((a, b) => getUnitAvg(b.ids) - getUnitAvg(a.ids)) // High to Low

  // Helper: Check constraints
  const apartSet = new Set(keepApartPairs.map(([a, b]) => `${a}|${b}`))

  const violatesConstraints = (unitIds, classIndex) => {
    const classRoster = classes[classIndex].studentIds
    for (const newStudentId of unitIds) {
      for (const existingStudentId of classRoster) {
        if (apartSet.has(`${newStudentId}|${existingStudentId}`) || apartSet.has(`${existingStudentId}|${newStudentId}`)) {
          return true
        }
      }
    }
    return false
  }

  // 5. Place Pinned Units First
  for (const unit of pinnedUnits) {
    // If pinned class has a conflict, we try to force it but might technically break constraint.
    // Ideally, we'd warn user. For now, we respect the pin.
    classes[unit.targetClassIndex].studentIds.push(...unit.ids)
  }

  // 6. Place Free Units (The main algorithm)
  const getClassAvgAfterAdd = (classIndex, newIds) => {
    const currentIds = classes[classIndex].studentIds.filter(id => !studentsById.get(id)?.ignoreScores)
    const incomingIds = newIds.filter(id => !studentsById.get(id)?.ignoreScores)

    const combinedTotal = [...currentIds, ...incomingIds].reduce((acc, id) => acc + getCompositeScore(studentsById, id, criteria, criteriaSig), 0)
    return combinedTotal / (currentIds.length + incomingIds.length || 1)
  }

  for (const unit of freeUnits) {
    // Find valid classes (not full, no constraints)
    // We look for classes with the MINIMUM current size first to keep sizes even
    const currentSizes = classes.map(c => c.studentIds.length)
    const minSize = Math.min(...currentSizes)

    let candidates = classes.map((c, i) => i)
    .filter(i => currentSizes[i] === minSize) // Must be one of the smallest classes
    .filter(i => classes[i].studentIds.length + unit.ids.length <= capacities[i]) // Must fit capacity
    .filter(i => !violatesConstraints(unit.ids, i)) // Must not violate "Separate From"

    // Fallback: If no min-size class works, try ANY class that fits
    if (candidates.length === 0) {
      candidates = classes.map((c, i) => i)
      .sort((a, b) => currentSizes[a] - currentSizes[b]) // Sort by size asc
      .filter(i => !violatesConstraints(unit.ids, i))
    }

    // Decision time: Which candidate class needs this student's score the most?
    let bestCandidates = []
    let bestAvgDiff = Infinity

    // We want the class average to stay close to the global average?
    // Or just balance them against each other?
    // Simple approach: Pick the class where adding this student results in the lowest variance.
    // Current approach: Pick the class with the lowest average (waterfall filling).

    // Use the Gender Balance tie-breaker on the valid candidates
    const chosenIndex = pickBestClassIndex(candidates, unit.ids, classes, studentsById)

    if (chosenIndex !== undefined) {
      classes[chosenIndex].studentIds.push(...unit.ids)
    } else {
      // Desperation move: put in smallest class even if it violates constraints (rare)
      const smallestIndex = classes.map((c, i) => ({ i, len: c.studentIds.length })).sort((a, b) => a.len - b.len)[0].i
      classes[smallestIndex].studentIds.push(...unit.ids)
    }
  }

  return { classes, capacities }
}

function runLeveledPlace(studentsById, allIds, numClasses, options) {
  const { criteria, levelOn, keepTogetherPairs, classMeta } = options

  const classes = Array.from({ length: numClasses }, (_, i) => ({
    id: `Class ${i + 1}`,
    name: classMeta?.[i]?.name || `Class ${i + 1}`,
    studentIds: []
  }))

  const baseTarget = Math.floor(allIds.length / numClasses)
  const remainder = allIds.length % numClasses
  const capacities = classes.map((_, i) => baseTarget + (i < remainder ? 1 : 0))

  // Group Keep Together
  const parentMap = new Map(allIds.map(id => [id, id]))
  keepTogetherPairs.forEach(([a, b]) => {
    if (a && b) unionNodes(parentMap, a, b)
  })
  const groups = new Map()
  allIds.forEach(id => {
    const root = findRoot(parentMap, id)
    if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(id)
  })

  const units = []
  for (const groupIds of groups.values()) {
    const pins = groupIds.map(id => studentsById.get(id)?.pinClass).filter(p => p !== null && p !== undefined)
    const uniquePins = [...new Set(pins)]
    if (uniquePins.length > 0) units.push({ ids: groupIds, targetClassIndex: uniquePins[0] })
      else units.push({ ids: groupIds, targetClassIndex: null })
  }

  const criteriaSig = makeCriteriaSignature(criteria)
  const getScore = (id) => {
    if (levelOn === 'Composite') return getCompositeScore(studentsById, id, criteria, criteriaSig)
      return Number(studentsById.get(id)?.criteria?.[levelOn]) || 0
  }
  const getUnitScore = (ids) => ids.reduce((sum, id) => sum + getScore(id), 0) / ids.length

  const pinnedUnits = units.filter(u => u.targetClassIndex !== null)
  const freeUnits = units.filter(u => u.targetClassIndex === null)

  // Shuffle free units to avoid input-order bias, then sort
  for (let i = freeUnits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [freeUnits[i], freeUnits[j]] = [freeUnits[j], freeUnits[i]];
  }
  freeUnits.sort((a, b) => getUnitScore(b.ids) - getUnitScore(a.ids)) // High to Low

  // Place Pinned
  pinnedUnits.forEach(u => classes[u.targetClassIndex].studentIds.push(...u.ids))

  // Place Free (Snake/Waterfall fill)
  let currentClassIndex = 0
  for (const unit of freeUnits) {
    // Find next class with room
    let placed = false
    // Try filling sequentially to create "levels"
    for (let i = currentClassIndex; i < numClasses; i++) {
      if (classes[i].studentIds.length + unit.ids.length <= capacities[i]) {
        classes[i].studentIds.push(...unit.ids)
        currentClassIndex = i
        placed = true
        break
      }
    }

    // If current level is full, just find any open spot
    if (!placed) {
      const openClass = classes.find(c => c.studentIds.length + unit.ids.length <= capacities[classes.indexOf(c)])
      if (openClass) openClass.studentIds.push(...unit.ids)
    }

    // If current class full, move pointer
    if (classes[currentClassIndex].studentIds.length >= capacities[currentClassIndex] && currentClassIndex < numClasses - 1) {
      currentClassIndex++
    }
  }

  return { classes, capacities }
}


/* =========================================================================================
 * CSV & FILE PARSING
 * ========================================================================================= */

// Standardize CSV splitting to handle quoted strings like "Doe, John"
function parseCSVLine(str) {
  const result = []
  let currentVal = ''
  let insideQuotes = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (insideQuotes) {
      if (char === '"') {
        if (i + 1 < str.length && str[i + 1] === '"') {
          currentVal += '"' // Escaped quote
          i++
        } else {
          insideQuotes = false
        }
      } else {
        currentVal += char
      }
    } else {
      if (char === '"') insideQuotes = true
        else if (char === ',') {
          result.push(currentVal.trim())
          currentVal = ''
        } else {
          currentVal += char
        }
    }
  }
  result.push(currentVal.trim())
  return result
}

function detectNumericColumn(values) {
  let numCount = 0
  let totalCount = 0

  for (const v of values) {
    if (!v) continue
      totalCount++
      // Check if it's a number OR a valid letter grade (A, B, C...)
      if (!isNaN(parseFloat(v)) || LETTER_GRADE_MAP.hasOwnProperty(String(v).toUpperCase())) {
        numCount++
      }
  }
  return totalCount > 0 && (numCount / totalCount > 0.6)
}

function processCSVFile(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '') // Remove BOM
  const lines = raw.split(/\r\n|\n|\r/).filter(l => l && l.trim().length > 0)
  if (!lines.length) return { students: [], criteriaLabels: [], maxScores: {} }

  const headersRaw = parseCSVLine(lines[0].trim()).map(h => h.trim())
  const headersNorm = headersRaw.map(h => normalizeString(h))
  const hasSingleName = headersNorm.includes('name')

  const body = lines.slice(1)
  const rows = body.map(parseCSVLine)
  const columns = headersRaw.map((_, i) => rows.map(r => r[i] ?? ''))

  const coreFieldsSet = new Set(['id', 'firstname', 'lastname', 'name', 'gender', 'tags', 'notes', 'previousteacher', 'previous_teacher'])
  const criteriaLabels = headersRaw.filter((h, i) => !coreFieldsSet.has(headersNorm[i]) && detectNumericColumn(columns[i] || []))

  // Determine Max Scores
  const maxScores = {}
  const parsedCriteriaValues = new Map()

  criteriaLabels.forEach(label => {
    const colIdx = headersRaw.findIndex(h => h.trim() === label)
    let maxFound = 0
    const values = []

    rows.forEach(row => {
      const raw = (row[colIdx] || '').trim()
      let val = 0
      if (raw) {
        const num = parseFloat(raw)
        if (!isNaN(num)) val = num
          else val = LETTER_GRADE_MAP[raw.toUpperCase()] || 0
      }
      values.push(val)
      if (val > maxFound) maxFound = val
    })

    maxScores[label] = maxFound > 0 ? maxFound : 100
    parsedCriteriaValues.set(label, values)
  })

  // Build Student Objects
  const students = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowMap = {}
    headersNorm.forEach((key, idx) => rowMap[key] = (row[idx] ?? '').trim())

    if (!rowMap['firstname'] && !rowMap['lastname'] && !rowMap['name']) continue

      // Name Parsing
      let firstName = rowMap['firstname'] || ''
      let lastName = rowMap['lastname'] || ''
      if (!firstName && !lastName && hasSingleName && rowMap['name']) {
        const parts = rowMap['name'].split(/\s+/)
        firstName = parts.shift() || ''
        lastName = parts.join(' ') || ''
      }

      // ID Generation
      let id = rowMap['id']
      if (!id) {
        id = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '') || `row${i + 1}`
      }

      const studentCriteria = {}
      criteriaLabels.forEach(label => {
        studentCriteria[label] = parsedCriteriaValues.get(label)[i]
      })

      students.push({
        id: id,
        firstName,
        lastName,
        name: `${firstName} ${lastName}`.trim(),
                    gender: rowMap['gender'] || undefined,
                    criteria: studentCriteria,
                    tags: (rowMap['tags'] || '').split(/[|,;/]/).map(x => x.trim()).filter(Boolean),
                    notes: rowMap['notes'] || '',
                    previousTeacher: rowMap['previousteacher'] || rowMap['previous_teacher'] || '',
                    ignoreScores: false
      })
  }

  return { students, criteriaLabels, maxScores }
}


/* =========================================================================================
 * SUB-COMPONENTS
 * ========================================================================================= */

function Modal({ open, onClose, title, children }) {
  if (!open) return null
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm transition-opacity" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[min(700px,92vw)] max-h-[86vh] overflow-auto border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
      <div className="font-bold text-lg text-slate-800 dark:text-white">{title}</div>
      <button className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-600 transition" onClick={onClose}>Close</button>
      </div>
      <div className="p-6">{children}</div>
      </div>
      </div>
    )
}

function ManualPins({ allIds, studentsById, numClasses, setStudentsById, classes, setBlockedMoveMessage }) {
  const [selectedId, setSelectedId] = useState('')
  const [constraintSearch, setConstraintSearch] = useState('')

  useEffect(() => {
    if (selectedId && !allIds.includes(selectedId)) setSelectedId('')
  }, [allIds, selectedId])

  const selectedStudent = selectedId ? studentsById.get(selectedId) : null

  // Sort list alphabetically
  const sortedIds = useMemo(() => [...allIds].sort((a, b) => (studentsById.get(a)?.name || '').localeCompare(studentsById.get(b)?.name || '')), [allIds, studentsById])

  const batchUpdate = (updates) => {
    setStudentsById(prev => {
      const newMap = new Map(prev)
      updates.forEach(({ id, patch }) => {
        newMap.set(id, { ...newMap.get(id), ...patch })
      })
      return newMap
    })
  }

  const togglePin = (type, targetId) => {
    const targetStudent = studentsById.get(targetId)
    const selectedName = selectedStudent?.name || selectedId
    const targetName = targetStudent?.name || targetId

    const isKeepWith = type === 'pinKeepWith'
    const currentList = selectedStudent?.[type] || []
    const isCurrentlySet = currentList.includes(targetId)

    if (isCurrentlySet) {
      // Toggle OFF
      const newList = currentList.filter(id => id !== targetId)
      const reciprocalType = isKeepWith ? 'pinKeepWith' : 'pinKeepApart'
      const targetList = targetStudent?.[reciprocalType] || []
      const newTargetList = targetList.filter(id => id !== selectedId)

      batchUpdate([
        { id: selectedId, patch: { [type]: newList } },
        { id: targetId, patch: { [reciprocalType]: newTargetList } }
      ])
      return
    }

    // Check Conflicts before adding
    if (isKeepWith && (targetStudent?.pinKeepApart || []).includes(selectedId)) {
      setBlockedMoveMessage(`Conflict: ${selectedName} cannot be kept with ${targetName} because they are set to be separated.`)
      return
    }
    if (!isKeepWith && (targetStudent?.pinKeepWith || []).includes(selectedId)) {
      setBlockedMoveMessage(`Conflict: ${selectedName} cannot be separated from ${targetName} because they are set to be kept together.`)
      return
    }

    // Toggle ON
    const newList = [...currentList, targetId]
    const reciprocalType = isKeepWith ? 'pinKeepWith' : 'pinKeepApart'
    const targetList = targetStudent?.[reciprocalType] || []
    const newTargetList = targetList.includes(selectedId) ? targetList : [...targetList, selectedId]

    batchUpdate([
      { id: selectedId, patch: { [type]: newList } },
      { id: targetId, patch: { [reciprocalType]: newTargetList } }
    ])
  }

  const getButtonClass = (targetId, currentArray) => {
    const isActive = currentArray.includes(targetId)
    return `px-3 py-1.5 text-xs font-medium rounded-full border transition-all duration-200 truncate ${
      isActive
      ? 'bg-indigo-600 text-white border-indigo-600 shadow-md transform scale-105'
      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-indigo-300'
    }`
  }

  const filteredTargets = sortedIds
  .filter(id => id !== selectedId)
  .filter(id => {
    const name = studentsById.get(id)?.name || ''
    return constraintSearch === '' || name.toLowerCase().includes(constraintSearch.toLowerCase())
  })

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
    {/* Student Selector */}
    <div className="lg:col-span-4 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Student Focus</div>
    <select
    className="form-select block w-full border-slate-300 dark:border-slate-700 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-slate-800 dark:text-white py-2 px-3"
    value={selectedId || ''}
    onChange={e => setSelectedId(e.target.value || null)}
    >
    <option value="">(Select Student)</option>
    {sortedIds.map(id => <option key={id} value={id}>{studentsById.get(id)?.name}</option>)}
    </select>

    {selectedStudent && (
      <div className="mt-4">
      <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Pin to Class</div>
      <select
      className="block w-full border-slate-300 dark:border-slate-700 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-slate-800 dark:text-white py-2 px-3"
      value={selectedStudent?.pinClass ?? ''}
      onChange={e => {
        const val = e.target.value === '' ? null : Number(e.target.value)
        batchUpdate([{ id: selectedId, patch: { pinClass: val } }])
      }}
      >
      <option value="">None (Auto-sort)</option>
      {Array.from({ length: numClasses }, (_, i) => (
        <option key={i} value={i}>{classes[i]?.name || `Class ${i + 1}`}</option>
      ))}
      </select>
      </div>
    )}
    </div>

    {/* Constraints Columns */}
    {['pinKeepWith', 'pinKeepApart'].map((type) => {
      if (!selectedStudent) return null
        const currentList = selectedStudent?.[type] || []
        const isKeepWith = type === 'pinKeepWith'

        return (
          <div key={type} className="lg:col-span-4 flex flex-col h-full">
          <div className="flex items-center justify-between mb-2">
          <div className={`text-sm font-bold ${isKeepWith ? 'text-indigo-600 dark:text-indigo-400' : 'text-rose-600 dark:text-rose-400'}`}>
          {isKeepWith ? 'Keep With' : 'Separate From'}
          </div>
          <button
          className="text-xs font-medium text-slate-400 hover:text-rose-500 transition"
          onClick={() => batchUpdate([{ id: selectedId, patch: { [type]: [] } }])}
          >
          Clear All
          </button>
          </div>

          <input
          type="text"
          value={constraintSearch}
          onChange={(e) => setConstraintSearch(e.target.value)}
          placeholder="Search..."
          className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg mb-3 bg-white dark:bg-slate-800 dark:text-white text-sm focus:ring-2 focus:ring-indigo-100 outline-none"
          />

          <div className="flex-1 border border-slate-200 dark:border-slate-700 rounded-xl p-3 max-h-64 overflow-y-auto flex flex-wrap content-start gap-2 bg-slate-50/50 dark:bg-slate-900/50">
          {/* Selected Buttons */}
          {currentList.map(id => (
            <button key={id} onClick={() => togglePin(type, id)} className={getButtonClass(id, currentList)}>
            <span className="mr-1">✓</span> {studentsById.get(id)?.name}
            </button>
          ))}

          {/* Unselected Buttons */}
          {filteredTargets.filter(id => !currentList.includes(id)).map(id => (
            <button key={id} onClick={() => togglePin(type, id)} className={getButtonClass(id, currentList)}>
            + {studentsById.get(id)?.name}
            </button>
          ))}

          {filteredTargets.length === 0 && constraintSearch && <p className="text-slate-400 text-xs p-2">No results</p>}
          </div>
          </div>
        )
    })}
    </div>
  )
}

function PrintOverview({ classes, studentsById, criteria, criteriaSig }) {
  if (!classes || !classes.length) return null
    const activeCriteria = criteria.filter(c => (c.weight ?? 0) > 0 && c.enabled)

    return (
      <div className="hidden print:block mb-8 break-after-page">
      <div className="mb-6 border-b pb-4 flex justify-between items-end">
      <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-1">Class Placement Summary</h1>
      <p className="text-sm text-gray-500">Created with Class Balancer</p>
      </div>
      <div className="text-sm text-gray-900 font-medium space-y-2 text-right">
      <div>Current Grade: __________________</div>
      <div>Next Year Grade: __________________</div>
      </div>
      </div>

      <table className="w-full text-sm border-collapse border border-gray-300">
      <thead>
      <tr className="bg-gray-100 text-left">
      <th className="border border-gray-300 p-2 font-bold text-gray-900">Class Name</th>
      <th className="border border-gray-300 p-2 font-bold text-gray-900 w-16 text-center">Size</th>
      <th className="border border-gray-300 p-2 font-bold text-gray-900 w-24 text-center">Gender</th>
      {activeCriteria.length > 0 && (
        <th className="border border-gray-300 p-2 font-bold text-gray-900 w-24 text-right">Avg Score</th>
      )}
      {activeCriteria.map(c => (
        <th key={c.label} className="border border-gray-300 p-2 font-bold text-gray-900 text-right">{c.label} (Avg)</th>
      ))}
      </tr>
      </thead>
      <tbody>
      {classes.map((c, i) => {
        const ids = c.studentIds
        const activeIds = ids.filter(id => !studentsById.get(id)?.ignoreScores)
        const stats = getGenderStats(studentsById, ids)

        const sumComp = activeIds.reduce((acc, id) => acc + getCompositeScore(studentsById, id, criteria, criteriaSig), 0)
        const avgComp = activeIds.length ? (sumComp / activeIds.length).toFixed(1) : '-'

        return (
          <tr key={c.id} className="even:bg-gray-50">
          <td className="border border-gray-300 p-2 font-semibold">{c.name || `Class ${i + 1}`}</td>
          <td className="border border-gray-300 p-2 text-center">{ids.length}</td>
          <td className="border border-gray-300 p-2 text-center text-xs">{stats.M}M / {stats.F}F</td>

          {activeCriteria.length > 0 && (
            <td className="border border-gray-300 p-2 text-right font-mono">{avgComp}</td>
          )}

          {activeCriteria.map(crit => {
            const sum = activeIds.reduce((acc, id) => acc + (Number(studentsById.get(id)?.criteria?.[crit.label]) || 0), 0)
            const avg = activeIds.length ? (sum / activeIds.length).toFixed(1) : '-'
          return <td key={crit.label} className="border border-gray-300 p-2 text-right font-mono text-gray-600">{avg}</td>
          })}
          </tr>
        )
      })}
      </tbody>
      </table>
      </div>
    )
}

function PrintSeparations({ studentsById, allIds }) {
  const separations = useMemo(() => {
    return allIds
    .map(id => studentsById.get(id))
    .filter(s => s && s.pinKeepApart && s.pinKeepApart.length > 0)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(s => {
      const targetNames = s.pinKeepApart
      .map(tid => studentsById.get(tid)?.name)
      .filter(Boolean)
      .sort()
      .join(', ')
      return { name: s.name, targets: targetNames }
    })
  }, [studentsById, allIds])

  if (separations.length === 0) return null

    return (
      <div className="hidden print:block pt-4">
      <div className="mb-6 border-b pb-4">
      <h1 className="text-3xl font-bold text-gray-900 mb-1">Separation Constraints</h1>
      <p className="text-sm text-gray-500">Confidential Reference</p>
      </div>
      <table className="w-full text-sm border-collapse border border-gray-300">
      <thead>
      <tr className="bg-gray-100 text-left">
      <th className="border border-gray-300 p-2 font-bold text-gray-900 w-1/3">Student</th>
      <th className="border border-gray-300 p-2 font-bold text-gray-900">Must Be Separated From</th>
      </tr>
      </thead>
      <tbody>
      {separations.map((row, i) => (
        <tr key={i} className="even:bg-gray-50">
        <td className="border border-gray-300 p-2 font-semibold">{row.name}</td>
        <td className="border border-gray-300 p-2">{row.targets}</td>
        </tr>
      ))}
      </tbody>
      </table>
      </div>
    )
}


/* =========================================================================================
 * MAIN APPLICATION
 * ========================================================================================= */

export default function App() {
  // Theme State
  const [dark, setDark] = useState(false)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])

  // Core Data State
  const [studentsById, setStudentsById] = useState(new Map())
  const [allIds, setAllIds] = useState([])
  const [criteria, setCriteria] = useState([])
  const [classMeta, setClassMeta] = useState([])
  const [classes, setClasses] = useState([])

  // UI State
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('overallHigh')
  const [numClasses, setNumClasses] = useState(6)
  const [newCritName, setNewCritName] = useState('')
  const [hasManualChanges, setHasManualChanges] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [blockedMoveMessage, setBlockedMoveMessage] = useState(null)

  // Advanced Settings
  const [mode, setMode] = useState('balanced')
  const [levelOn, setLevelOn] = useState('Composite')

  // Computed State
  const criteriaSig = useMemo(() => makeCriteriaSignature(criteria), [criteria])

  // ---- Drag & Drop Logic ----
  const dragRef = useRef(null)

  const onDragStartStudent = (e, sid, fromIdx) => {
    dragRef.current = { sid, fromIdx }
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDrop = (toIdx, e) => {
    e.preventDefault()
    const info = dragRef.current
    if (!info || info.fromIdx === toIdx) return

      const sid = info.sid
      const student = studentsById.get(sid)
      const destClassIds = classes[toIdx]?.studentIds || []

      // Check Conflicts in destination class
      const studentConflicts = new Set(student?.pinKeepApart || [])

      for (const existingId of destClassIds) {
        const existingStudent = studentsById.get(existingId)
        const existingConflicts = new Set(existingStudent?.pinKeepApart || [])

        if (studentConflicts.has(existingId) || existingConflicts.has(sid)) {
          const blockerName = existingStudent?.name || 'another student'
          setBlockedMoveMessage(`Conflict: ${student.name} cannot be placed here because they must be separated from ${blockerName}.`)
          dragRef.current = null
          return
        }
      }

      // Perform the Move
      setClasses(prev => {
        const copy = prev.map(c => ({ ...c, studentIds: [...c.studentIds] }))
        const src = copy[info.fromIdx]
        const dst = copy[toIdx]

        const idx = src.studentIds.indexOf(sid)
        if (idx > -1) {
          src.studentIds.splice(idx, 1)
          if (!dst.studentIds.includes(sid)) {
            dst.studentIds.push(sid)
          }
        }
        return copy
      })

      // Update Student Pin
      setStudentsById(prev => {
        const m = new Map(prev)
        m.set(sid, { ...m.get(sid), pinClass: toIdx })
        return m
      })

      dragRef.current = null
      setHasManualChanges(true)
  }

  // Clear caches when data changes
  useEffect(() => { scoreCache.clear(); metersCache.clear() }, [studentsById, criteria])

  // ---- CRUD Operations ----
  const updateStudent = (id, patch) => {
    setStudentsById(prev => {
      const s = prev.get(id)
      const newStudent = { ...s, ...patch }

      // Auto-update full name if parts change
      if (patch.firstName !== undefined || patch.lastName !== undefined || patch.name !== undefined) {
        let fn = patch.firstName !== undefined ? patch.firstName : (s.firstName || '')
        let ln = patch.lastName !== undefined ? patch.lastName : (s.lastName || '')
        if (patch.name !== undefined) {
          const parts = patch.name.trim().split(/\s+/)
          fn = parts.shift() || ''
          ln = parts.join(' ') || ''
        }
        newStudent.firstName = fn
        newStudent.lastName = ln
        newStudent.name = `${fn} ${ln}`.trim()
      }

      setHasManualChanges(true)
      const copy = new Map(prev)
      copy.set(id, newStudent)
      return copy
    })
  }

  const deleteStudent = (id) => {
    setStudentsById(prev => { const m = new Map(prev); m.delete(id); return m })
    setAllIds(prev => prev.filter(x => x !== id))
    setClasses(prev => prev.map(c => ({ ...c, studentIds: c.studentIds.filter(x => x !== id) })))
  }

  // ---- Adding New Students ----
  const [lastAddedId, setLastAddedId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [draftStudent, setDraftStudent] = useState(null)
  const [statusMessage, setStatusMessage] = useState({ message: '', type: 'success' })

  const displayStatus = (message, type = 'success', duration = 4000) => {
    setStatusMessage({ message, type })
    setTimeout(() => setStatusMessage({ message: '', type: 'success' }), duration)
  }

  const openAddStudent = () => {
    const activeCriteria = criteria.filter(c => (c.weight ?? 0) > 0)
    const crit = {}; activeCriteria.forEach(c => { crit[c.label] = 0 })
    setDraftStudent({
      firstName: '', lastName: '', name: '', id: '', gender: '', previousTeacher: '', notes: '', tags: '', criteria: crit
    })
    setShowAdd(true)
  }

  const submitAddStudent = () => {
    if (!draftStudent) return
      let firstName = (draftStudent.firstName || '').trim()
      let lastName = (draftStudent.lastName || '').trim()

      if (!firstName && !lastName) {
        const parts = (draftStudent.name || '').trim().split(/\s+/)
        firstName = parts.shift() || ''
        lastName = parts.join(' ') || ''
      }
      const fullName = `${firstName} ${lastName}`.trim()
      if (!fullName) { displayStatus('Please enter a name.', 'error'); return }

      // Generate ID
      const baseId = `${firstName}${lastName}`.toLowerCase().replace(/[^a-z0-9]+/g, '')
      let newId = baseId
      let n = 1
      while (studentsById.has(newId) || newId === '') { newId = baseId + (++n) }

      const tags = (draftStudent.tags || '').split(/[|,;/]/).map(t => t.trim()).filter(Boolean)
      const student = {
        id: newId,
        firstName,
        lastName,
        name: fullName,
        gender: draftStudent.gender || undefined,
        previousTeacher: draftStudent.previousTeacher || '',
        notes: draftStudent.notes || '',
        tags,
        criteria: { ...(draftStudent.criteria || {}) },
        pinClass: null,
        pinKeepWith: [],
        pinKeepApart: []
      }

      setStudentsById(prev => {
        const m = new Map(prev)
        m.set(student.id, student)

        // Auto-place the new student immediately
        // We do a "mini-run" just to find a spot for this one person
        setClasses(prevClasses => {
          const copy = prevClasses.map(c => ({ ...c, studentIds: [...c.studentIds] }))
          // Simple logic: pick class with lowest average score to balance it
          // Or smallest class. For simplicity, we stick them in the smallest class.
          let targetIdx = 0
          let minSize = Infinity
          copy.forEach((c, i) => { if(c.studentIds.length < minSize) { minSize = c.studentIds.length; targetIdx = i } })

          copy[targetIdx].studentIds.push(student.id)
          displayStatus(`Added ${student.name} to ${copy[targetIdx].name}`, 'success')
          setLastAddedId(student.id)
          setTimeout(() => setLastAddedId(null), 2000)
          return copy
        })

        return m
      })
      setAllIds(prev => [...prev, student.id])
      setShowAdd(false)
      setDraftStudent(null)
  }

  // ---- Running the Algorithm ----
  const runBalancing = () => {
    // 1. Prepare Constraints
    const keepTogetherPairs = []
    const keepApartPairs = []
    if (mode !== 'leveled') {
      allIds.forEach(id => (studentsById.get(id)?.pinKeepWith || []).forEach(o => keepTogetherPairs.push([id, o])))
      allIds.forEach(id => (studentsById.get(id)?.pinKeepApart || []).forEach(o => keepApartPairs.push([id, o])))
    }

    const options = { criteria, keepTogetherPairs, keepApartPairs, classMeta, levelOn }
    let result

    // 2. Run selected mode
    if (mode === 'leveled') {
      result = runLeveledPlace(studentsById, allIds, numClasses, options)
    } else {
      result = runAutoPlace(studentsById, allIds, numClasses, options)
    }

    // 3. Apply results
    setClasses(result.classes)
    setHasManualChanges(false)
  }

  // Trigger initial run when data loads
  useEffect(() => {
    if (allIds.length > 0 && classes.length === 0) runBalancing()
  }, [studentsById, allIds.length, numClasses, criteria, mode, levelOn])


  const handleRunClick = () => {
    if (hasManualChanges) setShowConfirmModal(true)
      else runBalancing()
  }

  // ---- File I/O ----
  const exportCSV = () => {
    const studentClassMap = new Map()
    classes.forEach(cls => cls.studentIds.forEach(id => studentClassMap.set(id, cls.name)))

    const headers = ['Class Name', 'First Name', 'Last Name', 'Gender', 'Tags', 'Notes', 'Previous Teacher', ...criteria.map(c => c.label)]
    const rows = allIds.map(id => {
      const s = studentsById.get(id)
      const className = studentClassMap.get(id) || 'Unassigned'
    const base = [
      className, s.firstName, s.lastName, s.gender,
      (s.tags || []).join('; '), (s.notes || '').replaceAll('\n', ' '), s.previousTeacher
    ]
    const scores = criteria.map(c => Number(s.criteria?.[c.label]) || 0)
    return base.concat(scores)
    })

    rows.sort((a, b) => a[0].localeCompare(b[0]))
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'balanced-roster.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const importCSV = async (file) => {
    try {
      const text = await file.text()
      const { students, criteriaLabels, maxScores } = processCSVFile(text)
      if (!students.length) throw new Error('No valid student rows found.')

        const newCriteria = criteriaLabels.map(label => ({
          label, weight: 1.0, max: maxScores[label] || 100, enabled: true
        }))

        const newMap = new Map()
        const newIds = []

        // Merge Strategy: Clean slate import
        students.forEach(s => {
          newMap.set(s.id, s)
          newIds.push(s.id)
        })

        setCriteria(newCriteria)
        setStudentsById(newMap)
        setAllIds(newIds)
        setClassMeta([])
        setClasses([])
        setLevelOn('Composite')

        displayStatus(`Successfully imported ${newIds.length} students.`, 'success')
        setHasManualChanges(false)
    } catch (err) {
      displayStatus('Import failed: ' + err.message, 'error')
    }
  }

  const exportJSON = () => {
    const data = {
      version: 'bcs-1',
      numClasses,
      criteria: criteria.map(({ enabled, ...rest }) => rest), // Don't save transient UI state
      students: Array.from(studentsById.values()),
      classMeta,
      classes
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'bcs-session.json'; a.click(); URL.revokeObjectURL(url)
  }

  const importJSON = async (file) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!data.students) throw new Error('Invalid Session File')

        const newMap = new Map()
        const newIds = []

        data.students.forEach(s => {
          // Re-construct student object safely
          const student = {
            ...s,
            pinClass: s.pinClass ?? null,
            pinKeepWith: s.pinKeepWith || [],
            pinKeepApart: s.pinKeepApart || [],
            ignoreScores: s.ignoreScores || false
          }
          newMap.set(s.id, student)
          newIds.push(s.id)
        })

        setStudentsById(newMap)
        setAllIds(newIds)

        if (data.criteria) {
          setCriteria(data.criteria.map(c => ({ ...c, enabled: (c.weight ?? 0) > 0 })))
        }
        if (data.numClasses) setNumClasses(data.numClasses)
          if (data.classMeta) setClassMeta(data.classMeta)
            if (data.classes) setClasses(data.classes)

              displayStatus('Session loaded successfully.', 'success')
              setHasManualChanges(false)
    } catch (err) {
      displayStatus('Load failed: ' + err.message, 'error')
    }
  }

  // --- Render Helpers ---
  function Field({ label, children }) {
    return (
      <div className="flex flex-col gap-1.5 min-w-[140px]">
      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</div>
      {children}
      </div>
    )
  }

  // Print Styles Injection
  const printStyles = `
  @media print {
    :root, body, #root, .min-h-screen {
      background-color: white !important; color: black !important;
      min-height: 0 !important; height: auto !important; overflow: visible !important;
    }
    .dark\\:bg-slate-900, .dark\\:text-white { background-color: white !important; color: black !important; }
    @page { margin: 0.5cm; size: auto; }
    .no-print { display: none !important; }
    .print-break-after { break-after: page; page-break-after: always; }
    .print-full-width { width: 100% !important; max-width: none !important; }
    .print-reset-grid { display: block !important; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
    th, td { border: 1px solid #ccc; padding: 2px 4px; text-align: left; vertical-align: top; overflow: hidden; }
    th { background-color: #f3f4f6 !important; font-weight: bold; }
    .screen-only-content { display: none !important; }
    .print-only-content { display: block !important; }
  }
  .print-only-content { display: none; }
  `

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-sans selection:bg-indigo-100 selection:text-indigo-700 print:bg-white print:text-black">
    <style>{printStyles}</style>

    {/* --- MODALS --- */}
    <Modal open={showConfirmModal} onClose={() => setShowConfirmModal(false)} title="Overwrite Manual Changes?">
    <div className="text-slate-600 dark:text-slate-300">
    <p className="mb-4">Re-running the balancer will undo your manual moves.</p>
    <p className="text-sm bg-amber-50 dark:bg-amber-900/30 p-3 rounded-lg border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200">
    We recommend clicking <strong>Save Session</strong> to backup your work first.
    </p>
    </div>
    <div className="flex justify-end gap-3 mt-6">
    <button onClick={() => setShowConfirmModal(false)} className="px-4 py-2 rounded-lg border border-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition">Cancel</button>
    <button onClick={() => { setShowConfirmModal(false); runBalancing() }} className="px-4 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 shadow-lg shadow-rose-500/30 transition">Run Anyway</button>
    </div>
    </Modal>

    <Modal open={!!blockedMoveMessage} onClose={() => setBlockedMoveMessage(null)} title="Move Blocked">
    <div className="text-slate-600 dark:text-slate-300">
    <p className="font-bold text-rose-600 mb-4 flex items-center gap-2"><span className="text-2xl">⚠️</span> Constraint Violation</p>
    <p>{blockedMoveMessage}</p>
    </div>
    <div className="flex justify-end mt-6">
    <button onClick={() => setBlockedMoveMessage(null)} className="px-4 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-700">Got it</button>
    </div>
    </Modal>

    {/* --- TOP NAVBAR --- */}
    <div className="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm no-print transition-all">
    <div className="max-w-9xl mx-auto px-6 py-4 space-y-4">
    <div className="flex items-center justify-between gap-4">
    <div className="flex items-center gap-3">
    <div className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white cursor-help" title={`Version: ${VERSION}`}>
    Class<span className="text-indigo-600 dark:text-indigo-400">Balancer</span>
    </div>
    <button onClick={() => setDark(d => !d)} className="p-2 hover:bg-slate-100 rounded-full transition text-slate-500">
    {dark ? '🌙' : '☀️'}
    </button>
    </div>

    <div className="flex flex-wrap items-center gap-2">
    <div className="flex items-center gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
    <button onClick={() => document.getElementById('csvInput')?.click()} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">Import Roster</button>
    <input id="csvInput" type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { importCSV(f); e.target.value = '' } }} />

    <button onClick={exportCSV} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">Export Roster</button>
    <div className="w-px h-4 bg-slate-300 mx-1"></div>

    <button onClick={() => document.getElementById('jsonInput')?.click()} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">Load Session</button>
    <input id="jsonInput" type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { importJSON(f); e.target.value = '' } }} />
    <button onClick={exportJSON} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">Save Session</button>
    </div>
    <button onClick={() => window.print()} className="ml-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50 hover:text-slate-900 transition dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200">Print Report</button>
    </div>
    </div>

    <div className="flex flex-col lg:flex-row items-end lg:items-center gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full lg:w-auto flex-1">
    <Field label="Classes">
    <input type="number" min={1} max={20} value={numClasses} onChange={e => setNumClasses(parseInt(e.target.value || '1', 10))} className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium" />
    </Field>

    <Field label="Sort Lists By">
    <select className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium" value={sortMode} onChange={e => setSortMode(e.target.value)}>
    <option value="overallHigh">High to Low</option>
    <option value="overallLow">Low to High</option>
    <option value="lastName">Last Name (A-Z)</option>
    <option value="firstName">First Name (A-Z)</option>
    </select>
    </Field>

    <Field label="Mode">
    <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg w-full">
    {['balanced', 'leveled'].map(m => (
      <button key={m} onClick={() => setMode(m)} className={`flex-1 px-3 py-1.5 rounded-md text-sm font-bold capitalize transition-all ${mode === m ? 'bg-white dark:bg-slate-600 text-indigo-600 dark:text-indigo-200 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{m}</button>
    ))}
    </div>
    </Field>

    {mode === 'leveled' ? (
      <Field label="Level on">
      <select className="border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-medium" value={levelOn} onChange={e => setLevelOn(e.target.value)}>
      <option value="Composite">Overall Score</option>
      {criteria.map(c => <option key={c.label} value={c.label}>{c.label}</option>)}
      </select>
      </Field>
    ) : <div/>}
    </div>

    <button onClick={handleRunClick} className={`w-full lg:w-auto px-8 py-3 rounded-xl text-white text-sm font-bold tracking-wide shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.02] active:scale-95 transition-all duration-200 ease-out ${hasManualChanges ? 'bg-gradient-to-r from-rose-500 to-orange-600 ring-2 ring-rose-200 animate-pulse' : 'bg-gradient-to-r from-indigo-600 to-blue-600'}`}>
    {hasManualChanges ? 'Run Re-Balance (!)' : 'Run Class Balancing'}
    </button>
    </div>
    </div>
    </div>

    {/* --- NOTIFICATIONS --- */}
    {statusMessage.message && (
      <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300 no-print">
      <div className={`rounded-xl border px-4 py-3 shadow-xl font-medium flex items-center gap-3 ${statusMessage.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : statusMessage.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
      <span>{statusMessage.type === 'error' ? '✕' : '✓'}</span>
      {statusMessage.message}
      </div>
      </div>
    )}

    {/* --- CONTENT GRID --- */}
    <div className="max-w-9xl mx-auto px-6 py-8 space-y-8">

    {/* CRITERIA SECTION */}
    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4">Balancing Factors</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
    {criteria.map(c => (
      <div key={c.label} className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 transition-colors">
      <div className="flex items-center justify-between mb-3">
      <div className="font-bold text-slate-700 dark:text-slate-200 truncate pr-2" title={c.label}>{c.label}</div>
      <div className="flex items-center gap-2">
      <label className="text-[10px] flex items-center gap-1 text-slate-500 cursor-pointer select-none">
      <input type="checkbox" checked={c.enabled} onChange={() => setCriteria(prev => prev.map(x => x.label === c.label ? { ...x, enabled: !x.enabled } : x))} className="rounded text-indigo-600 focus:ring-indigo-500"/> Show
      </label>
      <button className="text-slate-400 hover:text-rose-500 transition" onClick={() => setCriteria(prev => prev.filter(x => x.label !== c.label))}>×</button>
      </div>
      </div>
      <div className="space-y-2">
      <div>
      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Importance</div>
      <div className="flex bg-white dark:bg-slate-700 rounded-lg p-0.5 border border-slate-200 dark:border-slate-600">
      {['Low', 'Normal', 'High'].map(label => {
        const isActive = c.weight === WEIGHT_MAP[label]
        return (
          <button key={label} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all ${isActive ? 'bg-indigo-100 text-indigo-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`} onClick={() => { setCriteria(prev => prev.map(x => x.label === c.label ? { ...x, weight: WEIGHT_MAP[label] } : x)); setHasManualChanges(true) }}>
          {label}
          </button>
        )
      })}
      </div>
      </div>
      <div>
      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Max Score</div>
      <input type="number" value={c.max} onChange={e => setCriteria(prev => prev.map(x => x.label === c.label ? { ...x, max: parseFloat(e.target.value || '100') } : x))} className="w-full text-xs font-mono border-slate-200 rounded px-2 py-1 bg-white dark:bg-slate-900 dark:text-white focus:border-indigo-500 outline-none" />
      </div>
      </div>
      </div>
    ))}
    {/* Add Factor Button */}
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-3 flex flex-col justify-center gap-2 bg-slate-50/50 dark:bg-slate-800/50">
    <input value={newCritName} onChange={e => setNewCritName(e.target.value)} placeholder="New factor name..." className="border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 text-sm w-full bg-white dark:bg-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none" />
    <button onClick={() => { const label = newCritName.trim(); if (!label || criteria.some(c => c.label === label)) return; setCriteria(prev => [...prev, { label, weight: 1.0, max: 100, enabled: true }]); setNewCritName('') }} className="w-full py-1.5 rounded bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition">
    + Add Factor
    </button>
    </div>
    </div>
    </div>

    <PrintOverview classes={classes} studentsById={studentsById} criteria={criteria} criteriaSig={criteriaSig} />

    {/* --- CLASS BUCKETS --- */}
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-6 print-reset-grid">
    {(() => {
      const cls = classes.map((c, idx) => ({ ...c, name: classMeta[idx]?.name || c.name, studentIds: [...c.studentIds] }))

      // Sort Logic within buckets
      cls.forEach(c => {
        if (sortMode === 'overallHigh') c.studentIds.sort((a, b) => getCompositeScore(studentsById, b, criteria, criteriaSig) - getCompositeScore(studentsById, a, criteria, criteriaSig))
          else if (sortMode === 'overallLow') c.studentIds.sort((a, b) => getCompositeScore(studentsById, a, criteria, criteriaSig) - getCompositeScore(studentsById, b, criteria, criteriaSig))
            else if (sortMode === 'lastName') c.studentIds.sort((a, b) => (studentsById.get(a)?.lastName || '').localeCompare(studentsById.get(b)?.lastName || ''))
              else if (sortMode === 'firstName') c.studentIds.sort((a, b) => (studentsById.get(a)?.firstName || '').localeCompare(studentsById.get(b)?.firstName || ''))
      })

      return cls.map((c, idx) => {
        const stats = getGenderStats(studentsById, c.studentIds)
        const meters = calculateClassMeters(c, studentsById, criteria, allIds, criteriaSig)

        return (
          <div key={c.id} className="flex flex-col h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/50 dark:bg-slate-900/50 backdrop-blur-sm print-break-after print-clean print-full-width">
          <div className="p-4 bg-white dark:bg-slate-900 rounded-t-2xl border-b border-slate-100 dark:border-slate-800">
          <input className="font-bold text-lg text-slate-800 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none w-full transition-colors" value={classMeta[idx]?.name ?? c.name} onChange={e => { const v = e.target.value; setClassMeta(prev => { const copy = [...prev]; copy[idx] = { ...(copy[idx] || {}), name: v }; return copy }); setClasses(prev => prev.map((x, i) => i === idx ? { ...x, name: v } : x)) }} />
          <div className="flex items-center gap-3 mt-2 text-xs font-medium text-slate-500">
          <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-600 dark:text-slate-400 print:!bg-transparent print:!text-black print:!border print:!border-slate-300">Size: {stats.size}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 print:bg-blue-400" style={{printColorAdjust: 'exact'}}></span><span className="print:!text-black">M {stats.M}</span></span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-pink-400 print:bg-pink-400" style={{printColorAdjust: 'exact'}}></span><span className="print:!text-black">F {stats.F}</span></span>
          </div>

          <div className="mt-4 space-y-2 no-print">
          {meters.map(m => (
            <div key={m.label} title={`Class Avg: ${m.avg.toFixed(2)}`}>
            <div className="flex justify-between text-[10px] font-bold text-slate-400 mb-0.5 uppercase tracking-wide">
            <span>{m.label}</span>
            <span className={m.textColorClass}>{m.labelText}</span>
            </div>
            <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
            <div className={`h-full rounded-full transition-all duration-500 ease-out ${m.colorClass}`} style={{ width: m.pct + '%' }} />
            </div>
            </div>
          ))}
          </div>
          </div>

          <div className="p-3 flex-1 overflow-y-auto min-h-[300px]">
          <ul className="space-y-2 screen-only-content h-full" onDragOver={e => e.preventDefault()} onDrop={e => handleDrop(idx, e)}>
          {c.studentIds.map(id => {
            const st = studentsById.get(id)
            if (!st) return null
              const overall = getCompositeScore(studentsById, id, criteria, criteriaSig)
              const scoreBits = criteria.filter(cc => (cc.weight ?? 0) > 0 && cc.enabled).map(cc => `${cc.label.charAt(0)}:${st.criteria?.[cc.label] ?? 0}`)

              return (
                <li key={id} draggable onDragStart={e => onDragStartStudent(e, id, idx)} className={"group relative p-3 rounded-xl border border-transparent bg-white dark:bg-slate-800 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-grab active:cursor-grabbing border-l-4 " + (st.gender === 'F' ? "border-l-pink-400 " : st.gender === 'M' ? "border-l-blue-400 " : "border-l-slate-300 ") + (id === lastAddedId ? "ring-2 ring-emerald-500 ring-offset-2" : "")}>
                <div className="flex items-start justify-between gap-2">
                <div>
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 leading-tight">{st.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 font-medium">
                <span className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 px-1.5 py-0.5 rounded text-[10px] font-bold">{Math.round(overall)}</span>
                <span className="opacity-80 text-[10px]">{scoreBits.join(' · ')}</span>
                </div>
                </div>
                </div>
                {(st.notes || st.previousTeacher) && (
                  <div className="mt-2 pt-2 border-t border-slate-50 dark:border-slate-700 space-y-0.5">
                  {st.previousTeacher && <div className="text-[10px] text-slate-400">Prev: {st.previousTeacher}</div>}
                  {st.notes && <div className="text-[10px] text-slate-400 italic line-clamp-2">{st.notes}</div>}
                  </div>
                )}
                {Array.isArray(st.tags) && st.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                  {st.tags.map(tag => (
                    <span key={tag} className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 text-slate-500 uppercase tracking-wide">{tag}</span>
                  ))}
                  </div>
                )}
                </li>
              )
          })}
          </ul>
          {/* Print Table (Hidden on screen) */}
          <div className="print-only-content class-roster-container">
          <table className="w-full text-xs border-collapse">
          <thead>
          <tr className="border-b border-gray-400 text-left">
          <th className="py-1 w-[18%]">Name</th>
          <th className="py-1 w-[5%] text-center">Gen</th>
          <th className="py-1 w-[10%]">Tags</th>
          {criteria.some(c => c.enabled) && <th className="py-1 w-[7%] text-right">Score</th>}
          {criteria.filter(c => c.enabled).map(c => <th key={c.label} className="py-1 w-[5%] text-right text-[9px]">{c.label.substring(0,3)}</th>)}
          <th className="py-1 w-[10%] pl-2">Previous</th>
          <th className="py-1 w-auto pl-2">Notes</th>
          </tr>
          </thead>
          <tbody>
          {c.studentIds.map(id => {
            const st = studentsById.get(id)
            if (!st) return null
              return (
                <tr key={id} className="border-b border-gray-100">
                <td className="py-1 truncate">{st.lastName}, {st.firstName}</td>
                <td className="py-1 text-center">{st.gender}</td>
                <td className="py-1 text-[9px] text-gray-500 leading-tight">{(st.tags || []).join(', ')}</td>
                {criteria.some(c => c.enabled) && <td className="py-1 text-right">{Math.round(getCompositeScore(studentsById, id, criteria, criteriaSig))}</td>}
                {criteria.filter(c => c.enabled).map(c => <td key={c.label} className="py-1 text-right text-gray-500">{st.criteria?.[c.label] ?? 0}</td>)}
                <td className="py-1 text-gray-700 text-[9px] pl-2 truncate">{st.previousTeacher}</td>
                <td className="py-1 text-gray-700 text-[9px] pl-2 italic leading-tight">{st.notes}</td>
                </tr>
              )
          })}
          </tbody>
          </table>
          </div>
          </div>
          </div>
        )
      })
    })()}
    </div>

    <PrintSeparations studentsById={studentsById} allIds={allIds} />

    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4">Manual Pins & Relationships</h2>
    <ManualPins allIds={allIds} studentsById={studentsById} numClasses={numClasses} setStudentsById={setStudentsById} classes={classes} setBlockedMoveMessage={setBlockedMoveMessage} />
    </div>

    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
    <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
    <h2 className="text-lg font-bold text-slate-800 dark:text-white">Student Roster</h2>
    <div className="flex items-center gap-2">
    <input placeholder="Search roster..." className="border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none w-64" value={search} onChange={e => setSearch(e.target.value)} />
    <button onClick={openAddStudent} className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition shadow-lg shadow-emerald-500/20">+ New Student</button>
    </div>
    </div>

    {/* UPDATED: 2-COLUMN GRID FOR LARGE SCREENS */}
    <div className="overflow-y-auto max-h-[600px] pr-2 grid grid-cols-1 xl:grid-cols-2 gap-4">
    {[...allIds]
      .filter(id => (studentsById.get(id)?.name + id).toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (studentsById.get(a)?.lastName || '').localeCompare(studentsById.get(b)?.lastName || ''))
      .map(id => {
        const s = studentsById.get(id)
        return (
          <div key={id} className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-sm bg-white dark:bg-slate-800 hover:border-indigo-300 transition flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
          <div className="font-bold text-slate-800 dark:text-white text-base">{s.name}</div>
          <button className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50" onClick={() => deleteStudent(s.id)}>Delete</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <div className="space-y-1">
          <div className="text-[10px] uppercase text-slate-400 font-bold">First Name</div>
          <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.firstName || ''} onChange={e => updateStudent(s.id, { firstName: e.target.value })} />
          </div>
          <div className="space-y-1">
          <div className="text-[10px] uppercase text-slate-400 font-bold">Last Name</div>
          <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.lastName || ''} onChange={e => updateStudent(s.id, { lastName: e.target.value })} />
          </div>
          <div className="space-y-1">
          <div className="text-[10px] uppercase text-slate-400 font-bold">Gender</div>
          <select className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.gender || ''} onChange={e => updateStudent(s.id, { gender: e.target.value || undefined })}>
          <option value="">—</option><option value="M">Male</option><option value="F">Female</option>
          </select>
          </div>
          <div className="space-y-1">
          <div className="text-[10px] uppercase text-slate-400 font-bold">Prev Teacher</div>
          <input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.previousTeacher || ''} onChange={e => updateStudent(s.id, { previousTeacher: e.target.value })} />
          </div>
          </div>

          {/* UPDATED: TAGS EDITING */}
          <div className="mb-3">
          <div className="text-[10px] uppercase text-slate-400 font-bold mb-1">Tags (Comma Separated)</div>
          <input
          className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-slate-50 dark:bg-slate-900 dark:text-white text-xs"
          placeholder="e.g. IEP, Math Support..."
          value={(s.tags || []).join(', ')}
          onChange={e=> {
            const val = e.target.value;
            updateStudent(s.id, { tags: val.split(',').map(t=>t.trim()).filter(Boolean) })
          }}
          />
          </div>

          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase text-slate-400 font-bold">Scores</div>
          <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={s.ignoreScores || false} onChange={e => updateStudent(s.id, { ignoreScores: e.target.checked })} className="w-3.5 h-3.5 rounded text-amber-500 focus:ring-amber-500 border-gray-300" />
          <span className="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-wide">Exclude from Balancing</span>
          </label>
          </div>
          <div className="flex flex-wrap gap-3">
          {criteria.map(c => (
            <div key={c.label} className="flex flex-col">
            <span className="text-[10px] text-slate-500 truncate max-w-[80px] text-center">{c.label}</span>
            <input type="number" className="w-20 border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-center bg-white dark:bg-slate-800 dark:text-white focus:ring-1 focus:ring-indigo-500" value={(s.criteria?.[c.label] ?? '')} onChange={e => updateStudent(s.id, { criteria: { ...(s.criteria || {}), [c.label]: e.target.value } })} onBlur={e => updateStudent(s.id, { criteria: { ...(s.criteria || {}), [c.label]: e.target.value === '' ? 0 : Number(e.target.value) } })} />
            </div>
          ))}
          </div>
          </div>
          </div>
        )
      })}
      </div>
      </div>

      <Modal open={showAdd} onClose={() => { setShowAdd(false); setDraftStudent(null) }} title="Add New Student">
      {draftStudent && (
        <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
        <Field label="First Name"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.firstName} onChange={e => setDraftStudent(ds => ({ ...ds, firstName: e.target.value }))} autoFocus /></Field>
        <Field label="Last Name"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.lastName} onChange={e => setDraftStudent(ds => ({ ...ds, lastName: e.target.value }))} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
        <Field label="Gender">
        <select className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.gender} onChange={e => setDraftStudent(ds => ({ ...ds, gender: e.target.value }))}>
        <option value="">—</option><option value="M">M</option><option value="F">F</option>
        </select>
        </Field>
        <Field label="Prev Teacher"><input className="border-slate-300 dark:border-slate-600 rounded px-3 py-2 w-full bg-white dark:bg-slate-800 dark:text-white" value={draftStudent.previousTeacher} onChange={e => setDraftStudent(ds => ({ ...ds, previousTeacher: e.target.value }))} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
        {criteria.map(c => (
          <Field key={c.label} label={c.label}>
          <input type="number" className="border-slate-300 dark:border-slate-600 rounded px-2 py-1 w-full text-right bg-white dark:bg-slate-800 dark:text-white" value={(draftStudent.criteria?.[c.label] ?? 0)} onChange={e => setDraftStudent(ds => ({ ...ds, criteria: { ...(ds.criteria || {}), [c.label]: Number(e.target.value) } }))} />
          </Field>
        ))}
        </div>
        <div className="flex justify-end pt-4">
        <button className="px-6 py-2 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700" onClick={submitAddStudent}>Add Student</button>
        </div>
        </div>
      )}
      </Modal>
      </div>
      </div>
  )
}
