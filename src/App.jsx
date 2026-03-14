import React, { useState, useEffect, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'

/* =========================================================================================
 * CONFIGURATION & HELPERS
 * ========================================================================================= */

const VERSION = 'v3.0.0' // The fully polished, Per-Factor Optimization release!
const BUILTIN_TAGS = ['504', 'IEP', 'ELL', 'Gifted', 'Speech']

const scoreCache = new Map()
const metersCache = new Map()

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

const LETTER_GRADE_MAP = (() => {
  const map = {}
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    map[letter] = i + 1
  }
  return map
})()

function makeCriteriaSignature(criteria) {
  return criteria.map(c => `${c.label}:${c.weight}:${c.max}:${c.enabled}`).join('|')
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[140px]">
    <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</div>
    {children}
    </div>
  )
}

/* =========================================================================================
 * MATH & SCORING LOGIC
 * ========================================================================================= */

// Kept purely for visual sorting and the "At-a-Glance" UI badges on student cards
function getCompositeScore(studentsById, studentId, criteria, criteriaSig) {
  const cacheKey = studentId + '|' + criteriaSig
  const cached = scoreCache.get(cacheKey)
  if (cached !== undefined) return cached

    const student = studentsById.get(studentId)

    if (!student) { scoreCache.set(cacheKey, 0); return 0; }
    if (student.ignoreScores) { scoreCache.set(cacheKey, 0); return 0; }

    const totalScore = criteria.reduce((acc, crit) => {
      const rawValue = Number(student.criteria?.[crit.label]) || 0
      const weight = Number(crit.weight) || 0
      const maxScore = crit.max > 0 ? crit.max : 100

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

function calculateClassMeters(classData, studentsById, criteria, allIds, criteriaSig) {
  const rosterSig = classData.studentIds.join(',')
  const cacheKey = `${classData.id}|${criteriaSig}|${rosterSig}`

  const cached = metersCache.get(cacheKey)
  if (cached) return cached

    const activeStudents = classData.studentIds.filter(id => !studentsById.get(id)?.ignoreScores)
    const studentCount = activeStudents.length
    const activeCriteria = criteria.filter(c => c.enabled !== false && (c.weight ?? 0) > 0)

    const meters = activeCriteria.map(crit => {
      let classAverage = 0

      if (studentCount > 0) {
        const totalScore = activeStudents.reduce((sum, id) => {
          return sum + (Number(studentsById.get(id)?.criteria?.[crit.label]) || 0)
        }, 0)
        classAverage = totalScore / studentCount
      }

      const globalAvg = getAverageCriteriaScore(studentsById, allIds, crit.label)
      const globalSD = getStandardDeviation(studentsById, allIds, crit.label, globalAvg)
      const zScore = globalSD === 0 ? 0 : (classAverage - globalAvg) / globalSD

      const barPercent = Math.max(0, Math.min(100, (classAverage / (crit.max || 100)) * 100))

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
 * SUB-COMPONENTS
 * ========================================================================================= */

function TagEditor({ student, onUpdate }) {
  const [localVal, setLocalVal] = useState((student.tags || []).join(', '))

  useEffect(() => {
    setLocalVal((student.tags || []).join(', '))
  }, [student.tags])

  return (
    <div className="mb-3">
    <div className="text-[10px] uppercase text-slate-400 font-bold mb-1">Tags (Comma Separated)</div>
    <input
    className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-slate-50 dark:bg-slate-900 dark:text-white text-xs"
    placeholder="e.g. IEP, Math Support..."
    value={localVal}
    onChange={(e) => setLocalVal(e.target.value)}
    onBlur={() => {
      const tags = localVal.split(',').map(t => t.trim()).filter(Boolean)
      onUpdate({ tags })
    }}
    onKeyDown={(e) => {
      if (e.key === 'Enter') {
        e.currentTarget.blur()
      }
    }}
    />
    </div>
  )
}

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

/* =========================================================================================
 * BALANCING ALGORITHMS
 * ========================================================================================= */

const findRoot = (parentMap, x) => {
  while (parentMap.get(x) !== x) {
    parentMap.set(x, parentMap.get(parentMap.get(x)))
    x = parentMap.get(x)
  }
  return x
}

const unionNodes = (parentMap, a, b) => {
  const rootA = findRoot(parentMap, a)
  const rootB = findRoot(parentMap, b)
  if (rootA !== rootB) parentMap.set(rootA, rootB)
}

// PER-FACTOR OPTIMIZATION ENGINE (Balanced Mode)
function runAutoPlace(studentsById, allIds, numClasses, options) {
  const { criteria, keepTogetherPairs, keepApartPairs, classMeta } = options;
  const issues = [];

  // 1. INITIALIZE CLASSES & CAPACITIES
  const classes = Array.from({ length: numClasses }, (_, i) => ({
    id: `Class ${i + 1}`,
    name: classMeta?.[i]?.name || `Class ${i + 1}`,
    studentIds: []
  }));

  const baseTarget = Math.floor(allIds.length / numClasses);
  const remainder = allIds.length % numClasses;
  const capacities = classes.map((_, i) => baseTarget + (i < remainder ? 1 : 0));

  // 2. BUILD "UNITS" (Handle Keep Togethers) & RUN PRE-FLIGHT CHECKS
  const parentMap = new Map(allIds.map(id => [id, id]));
  keepTogetherPairs.forEach(([a, b]) => {
    if (a && b) unionNodes(parentMap, a, b);
  });

    const apartSet = new Set();
    keepApartPairs.forEach(([a, b]) => {
      apartSet.add(`${a}|${b}`);
      apartSet.add(`${b}|${a}`);
    });

    const groups = new Map();
    allIds.forEach(id => {
      const root = findRoot(parentMap, id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(id);
    });

    const units = [];
    for (const groupIds of groups.values()) {
      // PRE-FLIGHT: Pinning Conflicts
      const pins = groupIds.map(id => {
        const pin = studentsById.get(id)?.pinClass;
        return pin !== null && pin !== undefined ? { id, pin } : null;
      }).filter(Boolean);

      const uniquePins = [...new Set(pins.map(p => p.pin))];
      if (uniquePins.length > 1) {
        const names = pins.map(p => studentsById.get(p.id)?.name).join(', ');
        issues.push({
          type: 'critical',
          title: 'Pinning Conflict',
          message: `Students bound by a "Keep With" rule are manually pinned to different classes (${names}). They were forced into ${classes[uniquePins[0]]?.name || 'the same class'} to maintain the group.`
        });
      }

      // PRE-FLIGHT: Internal Paradoxes
      for (let i = 0; i < groupIds.length; i++) {
        for (let j = i + 1; j < groupIds.length; j++) {
          if (apartSet.has(`${groupIds[i]}|${groupIds[j]}`)) {
            const n1 = studentsById.get(groupIds[i])?.name;
            const n2 = studentsById.get(groupIds[j])?.name;
            issues.push({
              type: 'critical',
              title: 'Logical Paradox',
              message: `${n1} and ${n2} are set to be Kept Together AND Separated. The separation rule was ignored.`
            });
          }
        }
      }

      units.push({
        ids: groupIds,
        targetClassIndex: uniquePins.length > 0 ? uniquePins[0] : null
      });
    }

    // 3. CACHE GRADE-LEVEL TARGETS (Performance Optimization)
    const activeCriteria = criteria.filter(c => c.enabled !== false && (c.weight ?? 0) > 0);
    const gradeTargets = {};
    const activeWeights = {};

    activeCriteria.forEach(crit => {
      let sum = 0, count = 0;
      allIds.forEach(id => {
        const st = studentsById.get(id);
        if (!st?.ignoreScores) {
          sum += (Number(st.criteria?.[crit.label]) || 0);
          count++;
        }
      });
      gradeTargets[crit.label] = count > 0 ? (sum / count) : 0;
      activeWeights[crit.label] = crit.weight || 1.0; // Cached weight multipliers
    });

    let totalM = 0, totalF = 0;
    allIds.forEach(id => {
      const g = studentsById.get(id)?.gender;
      if (g === 'M') totalM++;
      if (g === 'F') totalF++;
    });
      const targetM = totalM / numClasses;
      const targetF = totalF / numClasses;

      // 4. THE COST FUNCTION
      const calculateCost = (classStudentIds) => {
        let cost = 0;
        let currentM = 0, currentF = 0;
        let factorSums = {};
        let factorCounts = {};

        activeCriteria.forEach(c => {
          factorSums[c.label] = 0;
          factorCounts[c.label] = 0;
        });

        classStudentIds.forEach(id => {
          const st = studentsById.get(id);
          if (!st) return;
          if (st.gender === 'M') currentM++;
          if (st.gender === 'F') currentF++;

          if (!st.ignoreScores) {
            activeCriteria.forEach(c => {
              factorSums[c.label] += (Number(st.criteria?.[c.label]) || 0);
              factorCounts[c.label]++;
            });
          }
        });

        cost += Math.abs(currentM - targetM) * 10;
        cost += Math.abs(currentF - targetF) * 10;

        activeCriteria.forEach(c => {
          const avg = factorCounts[c.label] > 0 ? (factorSums[c.label] / factorCounts[c.label]) : 0;
          const diff = Math.abs(avg - gradeTargets[c.label]);
          cost += (diff * diff) * activeWeights[c.label] * 5;
        });

        return cost;
      };

      const violatesConstraints = (unitIds, classRoster) => {
        for (const newId of unitIds) {
          for (const existingId of classRoster) {
            if (apartSet.has(`${newId}|${existingId}`)) return true;
          }
        }
        return false;
      };

      // 5. PHASE 1: PINNED STUDENTS & GREEDY DRAFT
      const pinnedUnits = units.filter(u => u.targetClassIndex !== null);
      const freeUnits = units.filter(u => u.targetClassIndex === null).sort((a, b) => b.ids.length - a.ids.length);

      pinnedUnits.forEach(u => classes[u.targetClassIndex].studentIds.push(...u.ids));

      freeUnits.forEach(unit => {
        let bestClassIndex = -1;
        let lowestCost = Infinity;

        for (let i = 0; i < numClasses; i++) {
          if (classes[i].studentIds.length + unit.ids.length > capacities[i]) continue;
          if (violatesConstraints(unit.ids, classes[i].studentIds)) continue;

          const hypotheticalRoster = [...classes[i].studentIds, ...unit.ids];
          const cost = calculateCost(hypotheticalRoster);

          if (cost < lowestCost) {
            lowestCost = cost;
            bestClassIndex = i;
          }
        }

        // AUDIT LOG: If no perfect placement exists
        if (bestClassIndex === -1) {
          bestClassIndex = classes.map((c, i) => ({ i, len: c.studentIds.length })).sort((a, b) => a.len - b.len)[0].i;
          const studentNames = unit.ids.map(id => studentsById.get(id)?.name).join(', ');
          issues.push({
            type: 'error',
            title: 'Forced Constraint Violation',
            message: `Could not honor "Separate From" constraints for [${studentNames}]. They were forced into ${classes[bestClassIndex].name} because all other classes lacked capacity or caused conflicts.`
          });
        }

        classes[bestClassIndex].studentIds.push(...unit.ids);
      });

      // 6. PHASE 2: OPTIMIZATION SWAPPER (Hill Climbing)
      const MAX_ITERATIONS = 1000;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const classAIdx = Math.floor(Math.random() * numClasses);
        let classBIdx = Math.floor(Math.random() * numClasses);
        if (classAIdx === classBIdx) classBIdx = (classBIdx + 1) % numClasses;

        const unitsA = freeUnits.filter(u => u.ids.every(id => classes[classAIdx].studentIds.includes(id)));
        const unitsB = freeUnits.filter(u => u.ids.every(id => classes[classBIdx].studentIds.includes(id)));

        if (unitsA.length === 0 || unitsB.length === 0) continue;

        const unitA = unitsA[Math.floor(Math.random() * unitsA.length)];
        const unitB = unitsB[Math.floor(Math.random() * unitsB.length)];

        const newLenA = classes[classAIdx].studentIds.length - unitA.ids.length + unitB.ids.length;
        const newLenB = classes[classBIdx].studentIds.length - unitB.ids.length + unitA.ids.length;
        if (newLenA > capacities[classAIdx] || newLenB > capacities[classBIdx]) continue;

        const rosterAWo = classes[classAIdx].studentIds.filter(id => !unitA.ids.includes(id));
        const rosterBWo = classes[classBIdx].studentIds.filter(id => !unitB.ids.includes(id));

        if (violatesConstraints(unitA.ids, rosterBWo) || violatesConstraints(unitB.ids, rosterAWo)) continue;

        const currentCostTotal = calculateCost(classes[classAIdx].studentIds) + calculateCost(classes[classBIdx].studentIds);

        const rosterAWithB = [...rosterAWo, ...unitB.ids];
        const rosterBWithA = [...rosterBWo, ...unitA.ids];
        const newCostTotal = calculateCost(rosterAWithB) + calculateCost(rosterBWithA);

        if (newCostTotal < currentCostTotal) {
          classes[classAIdx].studentIds = rosterAWithB;
          classes[classBIdx].studentIds = rosterBWithA;
        }
      }

      // 7. POST-RUN DIAGNOSTICS
      classes.forEach(c => {
        let M = 0, F = 0;
        c.studentIds.forEach(id => {
          const g = studentsById.get(id)?.gender;
          if (g === 'M') M++;
          if (g === 'F') F++;
        });
          // If a class deviates from the average by more than 2, log a warning
          if (Math.abs(M - targetM) >= 2.5 || Math.abs(F - targetF) >= 2.5) {
            issues.push({
              type: 'warning',
              title: 'Severe Gender Imbalance',
              message: `${c.name} has a disproportionate gender ratio (${M} Boys / ${F} Girls).`
            });
          }
      });

      return { classes, capacities, issues };
}

// LEVELED MODE ENGINE
function runLeveledPlace(studentsById, allIds, numClasses, options) {
  const { criteria, levelOn, keepTogetherPairs, classMeta } = options
  const issues = [];

  const classes = Array.from({ length: numClasses }, (_, i) => ({
    id: `Class ${i + 1}`,
    name: classMeta?.[i]?.name || `Class ${i + 1}`,
    studentIds: []
  }))

  const baseTarget = Math.floor(allIds.length / numClasses)
  const remainder = allIds.length % numClasses
  const capacities = classes.map((_, i) => baseTarget + (i < remainder ? 1 : 0))

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
  const getUnitScore = (ids) => {
    const scored = ids.filter(id => !studentsById.get(id)?.ignoreScores)
    if (scored.length === 0) return 0
      return scored.reduce((sum, id) => sum + getScore(id), 0) / scored.length
  }

  const pinnedUnits = units.filter(u => u.targetClassIndex !== null)
  const freeUnits = units.filter(u => u.targetClassIndex === null)

  for (let i = freeUnits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [freeUnits[i], freeUnits[j]] = [freeUnits[j], freeUnits[i]];
  }
  freeUnits.sort((a, b) => getUnitScore(b.ids) - getUnitScore(a.ids))

  pinnedUnits.forEach(u => classes[u.targetClassIndex].studentIds.push(...u.ids))

  let currentClassIndex = 0
  for (const unit of freeUnits) {
    let placed = false
    for (let i = currentClassIndex; i < numClasses; i++) {
      if (classes[i].studentIds.length + unit.ids.length <= capacities[i]) {
        classes[i].studentIds.push(...unit.ids)
        currentClassIndex = i
        placed = true
        break
      }
    }

    if (!placed) {
      const openClass = classes.find(c => c.studentIds.length + unit.ids.length <= capacities[classes.indexOf(c)])
      if (openClass) openClass.studentIds.push(...unit.ids)
    }

    if (classes[currentClassIndex].studentIds.length >= capacities[currentClassIndex] && currentClassIndex < numClasses - 1) {
      currentClassIndex++
    }
  }

  return { classes, capacities, issues }
}

/* =========================================================================================
 * CSV & FILE PARSING
 * ========================================================================================= */

function parseCSVLine(str) {
  const result = []
  let currentVal = ''
  let insideQuotes = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (insideQuotes) {
      if (char === '"') {
        if (i + 1 < str.length && str[i + 1] === '"') {
          currentVal += '"'
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
      if (!isNaN(parseFloat(v)) || LETTER_GRADE_MAP.hasOwnProperty(String(v).toUpperCase())) {
        numCount++
      }
  }
  return totalCount > 0 && (numCount / totalCount > 0.6)
}

function processCSVData(rows, headersRaw) {
  const headersNorm = headersRaw.map(h => normalizeString(h))
  const hasSingleName = headersNorm.includes('name')
  const columns = headersRaw.map((_, i) => rows.map(r => r[i] ?? ''))

  const coreFieldsSet = new Set(['id', 'firstname', 'lastname', 'name', 'gender', 'tags', 'notes', 'previousteacher', 'previous_teacher'])
  const criteriaLabels = headersRaw.filter((h, i) => !coreFieldsSet.has(headersNorm[i]) && detectNumericColumn(columns[i] || []))

  const maxScores = {}
  const parsedCriteriaValues = new Map()

  criteriaLabels.forEach(label => {
    const colIdx = headersRaw.findIndex(h => h.trim() === label)
    let maxFound = 0
    const values = []

    rows.forEach(row => {
      const raw = (String(row[colIdx] || '')).trim()
      let val = 0
      if (raw && raw !== 'undefined') {
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

  const students = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowMap = {}

    headersNorm.forEach((key, idx) => {
      const val = row[idx];
      const cleaned = (val === undefined || val === null || String(val).trim() === 'undefined') ? '' : String(val).trim();
      rowMap[key] = cleaned;
    })

    if (!rowMap['firstname'] && !rowMap['lastname'] && !rowMap['name']) continue;

    let firstName = rowMap['firstname'] || ''
    let lastName = rowMap['lastname'] || ''

    if (!firstName && !lastName && hasSingleName && rowMap['name']) {
      const parts = rowMap['name'].split(/\s+/)
      firstName = parts.shift() || ''
      lastName = parts.join(' ') || ''
    }

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
                  gender: rowMap['gender'] || '',
                  criteria: studentCriteria,
                  tags: (rowMap['tags'] || '').split(/[|,;/]/).map(x => x.trim()).filter(Boolean),
                  notes: rowMap['notes'] || '',
                  previousTeacher: rowMap['previousteacher'] || rowMap['previous_teacher'] || '',
                  ignoreScores: false
    })
  }

  return { students, criteriaLabels, maxScores }
}

function processCSVFile(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r\n|\n|\r/).filter(l => l && l.trim().length > 0)
  if (!lines.length) return { students: [], criteriaLabels: [], maxScores: {} }

  const headersRaw = parseCSVLine(lines[0].trim()).map(h => h.trim())
  const body = lines.slice(1)
  const rows = body.map(parseCSVLine)

  return processCSVData(rows, headersRaw)
}

/* =========================================================================================
 * MAIN APPLICATION
 * ========================================================================================= */

export default function App() {
  const [dark, setDark] = useState(false)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])

  const [studentsById, setStudentsById] = useState(new Map())
  const [allIds, setAllIds] = useState([])
  const [criteria, setCriteria] = useState([])
  const [classMeta, setClassMeta] = useState([])
  const [classes, setClasses] = useState([])

  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('overallHigh')
  const [numClasses, setNumClasses] = useState(6)
  const [newCritName, setNewCritName] = useState('')
  const [hasManualChanges, setHasManualChanges] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [blockedMoveMessage, setBlockedMoveMessage] = useState(null)

  const [runIssues, setRunIssues] = useState(null)

  const [mode, setMode] = useState('balanced')
  const [levelOn, setLevelOn] = useState('Composite')

  const criteriaSig = useMemo(() => makeCriteriaSignature(criteria), [criteria])

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

      setStudentsById(prev => {
        const m = new Map(prev)
        m.set(sid, { ...m.get(sid), pinClass: toIdx })
        return m
      })

      dragRef.current = null
      setHasManualChanges(true)
  }

  useEffect(() => { scoreCache.clear(); metersCache.clear() }, [studentsById, criteria])

  const updateStudent = (id, patch) => {
    setStudentsById(prev => {
      const s = prev.get(id)
      const newStudent = { ...s, ...patch }

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

        setClasses(prevClasses => {
          const copy = prevClasses.map(c => ({ ...c, studentIds: [...c.studentIds] }))
          let targetIdx = 0
          let minSize = Infinity
          copy.forEach((c, i) => { if (c.studentIds.length < minSize) { minSize = c.studentIds.length; targetIdx = i } })

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

  const runBalancing = () => {
    const keepTogetherPairs = []
    const keepApartPairs = []
    if (mode !== 'leveled') {
      allIds.forEach(id => (studentsById.get(id)?.pinKeepWith || []).forEach(o => keepTogetherPairs.push([id, o])))
      allIds.forEach(id => (studentsById.get(id)?.pinKeepApart || []).forEach(o => keepApartPairs.push([id, o])))
    }

    const options = { criteria, keepTogetherPairs, keepApartPairs, classMeta, levelOn }
    let result

    if (mode === 'leveled') {
      result = runLeveledPlace(studentsById, allIds, numClasses, options)
    } else {
      result = runAutoPlace(studentsById, allIds, numClasses, options)
    }

    setClasses(result.classes)
    setHasManualChanges(false)

    if (result.issues && result.issues.length > 0) {
      setRunIssues(result.issues)
    } else {
      setRunIssues(null)
      displayStatus('Classes balanced successfully with no constraint violations!', 'success')
    }
  }

  useEffect(() => {
    if (allIds.length > 0 && classes.length === 0) runBalancing()
  }, [studentsById, allIds.length, numClasses, criteria, mode, levelOn])

  const handleRunClick = () => {
    if (hasManualChanges) setShowConfirmModal(true)
      else runBalancing()
  }

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

  const importFile = (file) => {
    const reader = new FileReader();
    const fileName = file.name.toLowerCase();

    reader.onload = (e) => {
      try {
        let parsedData;
        if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheet];
          const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

          if (!jsonRows.length) throw new Error('Excel sheet is empty.');
          const headersRaw = jsonRows[0].map(h => String(h || '').trim());
          const rows = jsonRows.slice(1);
          parsedData = processCSVData(rows, headersRaw);
        } else {
          parsedData = processCSVFile(e.target.result);
        }

        const { students, criteriaLabels, maxScores } = parsedData;
        if (!students.length) throw new Error('No valid student rows found.');

        const newCriteria = criteriaLabels.map(label => ({
          label, weight: 1.0, max: maxScores[label] || 100, enabled: true
        }))

        const newMap = new Map()
        const newIds = []

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
    };

    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  }

  const exportJSON = () => {
    const data = {
      version: 'bcs-1',
      numClasses,
      criteria: criteria.map(({ enabled, ...rest }) => rest),
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

  const printStyles = `
  @media print {
    :root, body, #root, .min-h-screen {
      background-color: white !important; color: black !important;
      min-height: 0 !important; height: auto !important; overflow: visible !important;
    }

    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    @page { margin: 0.5cm; size: landscape; }

    .no-print { display: none !important; }
    .print-break-after { break-after: page; page-break-after: always; }
    .print-full-width { width: 100% !important; max-width: none !important; }

    table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; margin-bottom: 2rem; }
    th, td { padding: 8px 6px; text-align: left; vertical-align: top; overflow: hidden; }

    th { color: #475569; font-weight: 700; text-transform: uppercase; font-size: 9px; letter-spacing: 0.05em; border-bottom: 2px solid #cbd5e1; }
    td { border-bottom: 1px solid #e2e8f0; color: #1e293b; }

    tr { break-inside: avoid; page-break-inside: avoid; }
  }
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

    <Modal open={!!runIssues} onClose={() => setRunIssues(null)} title="Optimization Report">
    <div className="space-y-4">
    <p className="text-sm text-slate-600 dark:text-slate-300">
    The algorithm finished sorting, but encountered complex constraints it couldn't perfectly resolve. You will need to manually review the following issues:
    </p>
    <div className="max-h-96 overflow-y-auto space-y-3 pr-2">
    {runIssues?.map((issue, idx) => (
      <div key={idx} className={`p-3 rounded-xl border ${issue.type === 'critical' ? 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800' : issue.type === 'error' ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
      <div className={`font-bold text-sm mb-1 ${issue.type === 'critical' ? 'text-rose-700 dark:text-rose-400' : issue.type === 'error' ? 'text-orange-700 dark:text-orange-400' : 'text-amber-700 dark:text-amber-400'}`}>
      {issue.type === 'critical' ? '🚨' : issue.type === 'error' ? '⚠️' : '📊'} {issue.title}
      </div>
      <div className={`text-xs ${issue.type === 'critical' ? 'text-rose-600 dark:text-rose-300' : issue.type === 'error' ? 'text-orange-600 dark:text-orange-300' : 'text-amber-600 dark:text-amber-300'}`}>
      {issue.message}
      </div>
      </div>
    ))}
    </div>
    <div className="flex justify-end pt-2">
    <button onClick={() => setRunIssues(null)} className="px-5 py-2 rounded-lg bg-slate-800 text-white font-bold hover:bg-slate-700 transition">Acknowledge</button>
    </div>
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
    <button onClick={() => document.getElementById('fileInput')?.click()} className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition text-slate-700 dark:text-slate-300">Import Roster</button>
    <input id="fileInput" type="file" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { importFile(f); e.target.value = '' } }} />

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
      <button
      key={m}
      onClick={() => setMode(m)}
      title={m === 'balanced' ? 'Balances each factor individually to create perfectly rounded classes' : 'Sorts students into tiered classes based on overall scores'}
      className={`flex-1 px-3 py-1.5 rounded-md text-sm font-bold capitalize transition-all ${mode === m ? 'bg-white dark:bg-slate-600 text-indigo-600 dark:text-indigo-200 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
      >
      {m}
      </button>
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
    ) : <div />}
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

    {/* PRINT SECTIONS - PAGE 1: COVER PAGE & SUMMARIES */}
    <div className="hidden print:block print-break-after">
    <div className="flex justify-between items-start mb-6 border-b-2 border-slate-200 pb-4">
    <div>
    <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Class Placement Report</h1>
    <p className="text-sm font-medium text-slate-500 mt-1">{new Date().toLocaleDateString()}</p>
    </div>

    <div className="flex flex-col items-end gap-3 text-sm font-bold text-slate-600 uppercase tracking-wide">
    <div className="flex items-center gap-3">
    <span>Current Grade:</span>
    <div className="w-32 border-b-2 border-slate-300"></div>
    </div>
    <div className="flex items-center gap-3">
    <span>Next Grade:</span>
    <div className="w-32 border-b-2 border-slate-300"></div>
    </div>
    </div>
    </div>

    {/* NEW: PRINT OPTIMIZATION ISSUES WARNING */}
    <PrintIssues issues={runIssues} />

    <div className="mb-8">
    <h2 className="text-lg font-bold text-slate-800 mb-4 uppercase tracking-wider text-slate-500">Class Summaries</h2>
    <PrintOverview classes={classes} studentsById={studentsById} criteria={criteria} criteriaSig={criteriaSig} />
    </div>
    </div>

    {/* PRINT SECTIONS - PAGE 2: GRADE LEVEL STATS */}
    <div className="hidden print:block print-break-after">
    <GradeLevelStats allIds={allIds} studentsById={studentsById} criteria={criteria} />
    </div>

    {/* PRINT SECTIONS - PAGE 3: SEPARATIONS */}
    <PrintSeparations studentsById={studentsById} allIds={allIds} />

    {/* PRINT SECTIONS - PAGE 4+: DEDICATED ROSTERS */}
    <PrintClassRosters classes={classes} studentsById={studentsById} criteria={criteria} criteriaSig={criteriaSig} sortMode={sortMode} classMeta={classMeta} />


    {/* CRITERIA SECTION (Screen Only) */}
    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-5 no-print">
    <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4">Balancing Factors</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
    {criteria.map(c => (
      <div key={c.label} className="border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 transition-colors">
      <div className="flex items-center justify-between mb-3">
      <div className="font-bold text-slate-700 dark:text-slate-200 truncate pr-2" title={c.label}>{c.label}</div>
      <div className="flex items-center gap-2">
      <label className="text-[10px] flex items-center gap-1 text-slate-500 cursor-pointer select-none">
      <input type="checkbox" checked={c.enabled} onChange={() => setCriteria(prev => prev.map(x => x.label === c.label ? { ...x, enabled: !x.enabled } : x))} className="rounded text-indigo-600 focus:ring-indigo-500" /> Show
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
        const tooltipText = label === 'High'
        ? 'Strictly enforce balance for this factor (High Penalty)'
        : label === 'Low'
        ? 'Allow more variance to satisfy other constraints'
        : 'Standard balancing priority'

        return (
          <button
          key={label}
          title={tooltipText}
          className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all ${isActive ? 'bg-indigo-100 text-indigo-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
          onClick={() => { setCriteria(prev => prev.map(x => x.label === c.label ? { ...x, weight: WEIGHT_MAP[label] } : x)); setHasManualChanges(true) }}
          >
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
    <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-3 flex flex-col justify-center gap-2 bg-slate-50/50 dark:bg-slate-800/50">
    <input value={newCritName} onChange={e => setNewCritName(e.target.value)} placeholder="New factor name..." className="border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 text-sm w-full bg-white dark:bg-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none" />
    <button onClick={() => { const label = newCritName.trim(); if (!label || criteria.some(c => c.label === label)) return; setCriteria(prev => [...prev, { label, weight: 1.0, max: 100, enabled: true }]); setNewCritName('') }} className="w-full py-1.5 rounded bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition">
    + Add Factor
    </button>
    </div>
    </div>
    </div>

    {/* --- CLASS BUCKETS (Screen Only) --- */}
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-6 no-print">
    {(() => {
      const activeCriteria = criteria.filter(c => c.enabled !== false && (c.weight ?? 0) > 0);
      const cls = classes.map((c, idx) => ({ ...c, name: classMeta[idx]?.name || c.name, studentIds: [...c.studentIds] }))

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
          <div key={c.id} className="flex flex-col h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/50 dark:bg-slate-900/50 backdrop-blur-sm">
          <div className="p-4 bg-white dark:bg-slate-900 rounded-t-2xl border-b border-slate-100 dark:border-slate-800">
          <input className="font-bold text-lg text-slate-800 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none w-full transition-colors" value={classMeta[idx]?.name ?? c.name} onChange={e => { const v = e.target.value; setClassMeta(prev => { const copy = [...prev]; copy[idx] = { ...(copy[idx] || {}), name: v }; return copy }); setClasses(prev => prev.map((x, i) => i === idx ? { ...x, name: v } : x)) }} />
          <div className="flex items-center gap-3 mt-2 text-xs font-medium text-slate-500">
          <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-600 dark:text-slate-400">Size: {stats.size}</span>
          <span>M {stats.M}</span>
          <span>F {stats.F}</span>
          </div>

          <div className="mt-4 space-y-2">
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
          <ul className="space-y-2 h-full" onDragOver={e => e.preventDefault()} onDrop={e => handleDrop(idx, e)}>
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
                {st.ignoreScores ? (
                  <span className="bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-tighter">
                  Non-Scored Student
                  </span>
                ) : (
                  <>
                  <span className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 px-1.5 py-0.5 rounded text-[10px] font-bold">{Math.round(overall)}</span>
                  <span className="opacity-80 text-[10px]">{scoreBits.join(' · ')}</span>
                  </>
                )}
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
          </div>
          </div>
        )
      })
    })()}
    </div>

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
          <Field label="First Name"><input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.firstName || ''} onChange={e => updateStudent(s.id, { firstName: e.target.value })} /></Field>
          <Field label="Last Name"><input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.lastName || ''} onChange={e => updateStudent(s.id, { lastName: e.target.value })} /></Field>
          <Field label="Gender">
          <select className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.gender || ''} onChange={e => updateStudent(s.id, { gender: e.target.value || undefined })}>
          <option value="">—</option><option value="M">Male</option><option value="F">Female</option>
          </select>
          </Field>
          <Field label="Prev Teacher"><input className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-slate-50 dark:bg-slate-900 dark:text-white" value={s.previousTeacher || ''} onChange={e => updateStudent(s.id, { previousTeacher: e.target.value })} /></Field>
          </div>

          <TagEditor student={s} onUpdate={(patch) => updateStudent(s.id, patch)} />

          <div className="mb-3">
          <div className="text-[10px] uppercase text-slate-400 font-bold mb-1">Notes</div>
          <textarea
          className="w-full border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-slate-50 dark:bg-slate-900 dark:text-white text-xs resize-none focus:ring-1 focus:ring-indigo-500"
          rows={2}
          placeholder="Add notes about this student..."
          value={s.notes || ''}
          onChange={e => updateStudent(s.id, { notes: e.target.value })}
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
  )
}

function ManualPins({ allIds, studentsById, numClasses, setStudentsById, classes, setBlockedMoveMessage }) {
  const [selectedId, setSelectedId] = useState('')
  const [constraintSearch, setConstraintSearch] = useState('')

  useEffect(() => {
    if (selectedId && !allIds.includes(selectedId)) setSelectedId('')
  }, [allIds, selectedId])

  const selectedStudent = selectedId ? studentsById.get(selectedId) : null
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

    if (isKeepWith && (targetStudent?.pinKeepApart || []).includes(selectedId)) {
      setBlockedMoveMessage(`Conflict: ${selectedName} cannot be kept with ${targetName} because they are set to be separated.`)
      return
    }
    if (!isKeepWith && (targetStudent?.pinKeepWith || []).includes(selectedId)) {
      setBlockedMoveMessage(`Conflict: ${selectedName} cannot be separated from ${targetName} because they are set to be kept together.`)
      return
    }

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
    return `px-3 py-1.5 text-xs font-medium rounded-full border transition-all duration-200 truncate ${isActive
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
          {currentList.map(id => (
            <button key={id} onClick={() => togglePin(type, id)} className={getButtonClass(id, currentList)}>
            <span className="mr-1">✓</span> {studentsById.get(id)?.name}
            </button>
          ))}
          {filteredTargets.filter(id => !currentList.includes(id)).map(id => (
            <button key={id} onClick={() => togglePin(type, id)} className={getButtonClass(id, currentList)}>
            + {studentsById.get(id)?.name}
            </button>
          ))}
          </div>
          </div>
        )
    })}
    </div>
  )
}

function PrintIssues({ issues }) {
  if (!issues || issues.length === 0) return null;
  return (
    <div className="mb-8 border-2 border-rose-200 bg-rose-50 p-4 rounded-lg print-break-inside-avoid">
    <h2 className="text-lg font-bold text-rose-800 mb-2 uppercase tracking-wider">⚠ Optimization Warnings (Manual Review Needed)</h2>
    <ul className="list-disc pl-5 space-y-1 text-rose-700 text-sm">
    {issues.map((iss, i) => (
      <li key={i}><strong>{iss.title}:</strong> {iss.message}</li>
    ))}
    </ul>
    </div>
  )
}

function PrintOverview({ classes, studentsById, criteria, criteriaSig }) {
  if (!classes || !classes.length) return null

    const activeCriteria = criteria.filter(c => c.enabled !== false && (c.weight ?? 0) > 0)

    return (
      <table className="w-full text-sm">
      <thead>
      <tr>
      <th className="w-[20%]">Class Name</th>
      <th className="text-center w-[8%]">Size</th>
      <th className="text-center w-[12%]">Gender</th>
      {activeCriteria.length > 0 && (
        <th className="text-center w-[12%]">Avg Score</th>
      )}
      <th className="w-[48%]">Factor Averages</th>
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
          <tr key={c.id}>
          <td className="font-bold text-slate-800">{c.name || `Class ${i + 1}`}</td>
          <td className="text-center font-medium">{ids.length}</td>
          <td className="text-center text-slate-500">{stats.M}M / {stats.F}F</td>
          {activeCriteria.length > 0 && (
            <td className="text-center font-extrabold text-indigo-600">{avgComp}</td>
          )}
          <td>
          <div className="flex flex-wrap gap-2">
          {activeCriteria.map(crit => {
            const sum = activeIds.reduce((acc, id) => acc + (Number(studentsById.get(id)?.criteria?.[crit.label]) || 0), 0)
            const avg = activeIds.length ? (sum / activeIds.length).toFixed(1) : '-'
            return (
              <span key={crit.label} className="inline-flex items-center gap-1 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded text-[9px] text-slate-700">
              <span className="font-bold text-slate-900">{crit.label.substring(0, 4)}:</span> {avg}
              </span>
            )
          })}
          </div>
          </td>
          </tr>
        )
      })}
      </tbody>
      </table>
    )
}

function PrintClassRosters({ classes, studentsById, criteria, criteriaSig, sortMode, classMeta }) {
  if (!classes || !classes.length) return null

    const activeCriteria = criteria.filter(c => c.enabled !== false && (c.weight ?? 0) > 0)

    return (
      <div className="hidden print:block w-full">
      {classes.map((c, idx) => {
        const sortedIds = [...c.studentIds]
        if (sortMode === 'overallHigh') sortedIds.sort((a, b) => getCompositeScore(studentsById, b, criteria, criteriaSig) - getCompositeScore(studentsById, a, criteria, criteriaSig))
          else if (sortMode === 'overallLow') sortedIds.sort((a, b) => getCompositeScore(studentsById, a, criteria, criteriaSig) - getCompositeScore(studentsById, b, criteria, criteriaSig))
            else if (sortMode === 'lastName') sortedIds.sort((a, b) => (studentsById.get(a)?.lastName || '').localeCompare(studentsById.get(b)?.lastName || ''))
              else if (sortMode === 'firstName') sortedIds.sort((a, b) => (studentsById.get(a)?.firstName || '').localeCompare(studentsById.get(b)?.firstName || ''))

                return (
                  <div key={c.id} className="print-break-after w-full mb-8">
                  <h2 className="text-2xl font-extrabold text-slate-900 mb-4">{classMeta[idx]?.name || c.name || `Class ${idx + 1}`} Roster</h2>
                  <table className="w-full">
                  <thead>
                  <tr>
                  <th className="w-[18%]">Name</th>
                  <th className="text-center w-[5%]">G</th>
                  <th className="w-[12%]">Tags</th>
                  {activeCriteria.length > 0 && <th className="text-center w-[8%]">Score</th>}
                  <th className="w-[32%]">Factor Breakdown</th>
                  <th className="w-[25%]">Notes & Prev</th>
                  </tr>
                  </thead>
                  <tbody>
                  {sortedIds.map(id => {
                    const st = studentsById.get(id)
                    if (!st) return null
                      return (
                        <tr key={id}>
                        <td className="font-bold text-sm text-slate-900">{st.lastName}, {st.firstName}</td>
                        <td className="text-center font-medium text-slate-500">{st.gender}</td>
                        <td>
                        {st.tags && st.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                          {st.tags.map(t => (
                            <span key={t} className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[9px] font-bold">{t}</span>
                          ))}
                          </div>
                        ) : null}
                        </td>
                        {activeCriteria.length > 0 && (
                          <td className="text-center font-extrabold text-sm">
                          {st.ignoreScores ? '-' : Math.round(getCompositeScore(studentsById, id, criteria, criteriaSig))}
                          </td>
                        )}
                        <td>
                        <div className="flex flex-wrap gap-1.5">
                        {activeCriteria.map(crit => (
                          <span key={crit.label} className="inline-flex items-center gap-1 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded text-[9px] text-slate-700">
                          <span className="font-bold text-slate-900">{crit.label.substring(0, 4)}:</span>
                          <span>{st.ignoreScores ? '-' : (Number(st.criteria?.[crit.label]) || 0)}</span>
                          </span>
                        ))}
                        </div>
                        </td>
                        <td>
                        <div className="flex flex-col gap-1.5">
                        {st.previousTeacher && (
                          <div><span className="inline-block bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded text-[9px] font-bold border border-indigo-100">Prev: {st.previousTeacher}</span></div>
                        )}
                        {st.notes && (
                          <div className="text-[10px] text-slate-600 leading-snug">{st.notes}</div>
                        )}
                        </div>
                        </td>
                        </tr>
                      )
                  })}
                  </tbody>
                  </table>
                  </div>
                )
      })}
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
      <div className="hidden print:block print-break-after">
      <div className="mb-6 border-b-2 border-slate-200 pb-4">
      <h1 className="text-2xl font-extrabold text-slate-900">Separation Constraints</h1>
      </div>
      <table className="w-full text-sm">
      <thead>
      <tr>
      <th className="w-1/3">Student</th>
      <th>Must Be Separated From</th>
      </tr>
      </thead>
      <tbody>
      {separations.map((row, i) => (
        <tr key={i}>
        <td className="font-bold text-slate-800">{row.name}</td>
        <td className="text-slate-600">{row.targets}</td>
        </tr>
      ))}
      </tbody>
      </table>
      </div>
    )
}

function GradeLevelStats({ allIds, studentsById, criteria }) {
  const stats = useMemo(() => {
    const activeIds = allIds.filter(id => !studentsById.get(id)?.ignoreScores)
    const totalCount = allIds.length
    let males = 0, females = 0

    allIds.forEach(id => {
      const g = studentsById.get(id)?.gender
      if (g === 'M') males++; else if (g === 'F') females++
    })

    const criteriaStats = criteria.filter(c => (c.weight ?? 0) > 0).map(crit => {
      const vals = activeIds.map(id => Number(studentsById.get(id)?.criteria?.[crit.label]) || 0)
      return {
        label: crit.label,
        avg: vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 0,
                                                                        max: vals.length ? Math.max(...vals) : 0,
                                                                        min: vals.length ? Math.min(...vals) : 0
      }
    })

    return { totalCount, males, females, criteriaStats }
  }, [allIds, studentsById, criteria])

  return (
    <div>
    <h2 className="text-2xl font-extrabold text-slate-900 mb-6 border-b-2 border-slate-200 pb-2">Grade Level Statistics</h2>
    <div className="grid grid-cols-3 gap-6 mb-8">
    <div>
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Enrollment</div>
    <div className="text-2xl font-extrabold text-slate-800">{stats.totalCount} Students</div>
    </div>
    <div>
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Gender Breakdown</div>
    <div className="text-2xl font-extrabold text-slate-800">{stats.males}M / {stats.females}F</div>
    </div>
    <div>
    <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Criteria Tracked</div>
    <div className="text-2xl font-extrabold text-slate-800">{stats.criteriaStats.length} Factors</div>
    </div>
    </div>
    <table className="w-full text-sm">
    <thead>
    <tr>
    <th className="w-1/2 text-left">Balancing Factor</th>
    <th className="text-center w-[16%]">Average Score</th>
    <th className="text-center w-[16%]">Low Range</th>
    <th className="text-center w-[16%]">High Range</th>
    </tr>
    </thead>
    <tbody>
    {stats.criteriaStats.map(s => (
      <tr key={s.label}>
      <td className="font-bold text-slate-800">{s.label}</td>
      <td className="text-center font-mono font-medium text-slate-600">{s.avg}</td>
      <td className="text-center font-mono font-medium text-slate-600">{s.min}</td>
      <td className="text-center font-mono font-medium text-slate-600">{s.max}</td>
      </tr>
    ))}
    </tbody>
    </table>
    </div>
  )
}
